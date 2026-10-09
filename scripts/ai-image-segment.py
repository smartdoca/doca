#!/usr/bin/env python3
"""Single-image, CPU-only SAM2 candidate worker; paths are host-owned inputs."""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import math
from pathlib import Path, PurePosixPath
import re
import sys
import time


MAX_INPUT_BYTES = 256 * 1024
MAX_PIXELS = 25_000_000
MAX_PARTS = 64
MAX_POINTS = 128
PART_FIELDS = {"label", "box", "positivePoints", "negativePoints"}


class WorkerError(Exception):
    def __init__(self, code: str, message: str, facts=None):
        super().__init__(message)
        self.code, self.facts = code, facts


def require(condition, message, code="invalid_input"):
    if not condition:
        raise WorkerError(code, message)


def exact_fields(value, fields, where):
    require(type(value) is dict and set(value) == fields,
            f"{where} must contain exactly {', '.join(sorted(fields))}")


def coordinate(value):
    return type(value) in (int, float) and 0 <= value <= 1 and math.isfinite(value)


def scalar_text(value):
    return not any(ord(char) < 32 or 0xD800 <= ord(char) <= 0xDFFF for char in value)


def validate_part(value, where):
    exact_fields(value, PART_FIELDS, where)
    label, box = value["label"], value["box"]
    require(type(label) is str and 1 <= len(label) <= 100 and label == label.strip()
            and scalar_text(label), f"{where}.label is invalid")
    require(type(box) is list and len(box) == 4 and all(map(coordinate, box))
            and box[0] < box[2] and box[1] < box[3], f"{where}.box is invalid")
    positive, negative = value["positivePoints"], value["negativePoints"]
    require(type(positive) is list and type(negative) is list and len(positive) >= 1
            and len(positive) + len(negative) <= MAX_POINTS,
            f"{where} requires positive points and at most {MAX_POINTS} total points")
    for name, points in [("positivePoints", positive), ("negativePoints", negative)]:
        require(all(type(point) is list and len(point) == 2 and all(map(coordinate, point))
                    for point in points), f"{where}.{name} is invalid")
        require(len({tuple(point) for point in points}) == len(points),
                f"{where}.{name} contains duplicate points")
    require(not ({tuple(point) for point in positive} & {tuple(point) for point in negative}),
            f"{where} has conflicting positive and negative points", "point_conflict")


def absolute_path(value, where):
    require(type(value) is str and 1 <= len(value) <= 4096 and scalar_text(value)
            and Path(value).is_absolute(), f"{where} must be an absolute local path")
    return Path(value)


def validate_task(value):
    exact_fields(value, {"version", "sourcePath", "outputDir", "targets", "exclusions"}, "task")
    require(type(value["version"]) is int and value["version"] == 1, "version must be 1")
    absolute_path(value["sourcePath"], "sourcePath")
    absolute_path(value["outputDir"], "outputDir")
    for group, minimum in [("targets", 1), ("exclusions", 0)]:
        parts = value[group]
        require(type(parts) is list and minimum <= len(parts) <= MAX_PARTS,
                f"{group} must have {minimum}..{MAX_PARTS} parts")
        for index, part in enumerate(parts):
            validate_part(part, f"{group}[{index}]")
        require(len({part["label"] for part in parts}) == len(parts),
                f"{group} labels must be unique")
    return value


def read_task(stream):
    raw = stream.read(MAX_INPUT_BYTES + 1)
    require(len(raw) <= MAX_INPUT_BYTES, "input exceeds 256 KiB", "input_too_large")

    def object_pairs(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "duplicate JSON field")
            result[key] = value
        return result

    def constant(_):
        raise WorkerError("invalid_input", "JSON non-finite numbers are forbidden")

    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=object_pairs,
                           parse_constant=constant)
    except (ValueError, UnicodeError, RecursionError) as error:
        raise WorkerError("invalid_input", "input must be one strict UTF-8 JSON object") from error
    return validate_task(value)


def sha256(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def pixel_point(point, width, height):
    return [min(math.floor(point[0] * width), width - 1),
            min(math.floor(point[1] * height), height - 1)]


def point_checks(mask, part, width, height):
    result = {}
    for name in ["positivePoints", "negativePoints"]:
        result[name] = [{"point": point, "pixel": (pixel := pixel_point(point, width, height)),
                         "included": bool(mask[pixel[1], pixel[0]])} for point in part[name]]
    result["positiveMissing"] = sum(not item["included"] for item in result["positivePoints"])
    result["negativeIncluded"] = sum(item["included"] for item in result["negativePoints"])
    return result


def select_mask(predictor, part, width, height):
    import numpy as np

    started = time.perf_counter()
    points = np.array([pixel_point(point, width, height)
                       for point in part["positivePoints"] + part["negativePoints"]], dtype=np.float32)
    labels = np.array([1] * len(part["positivePoints"]) +
                      [0] * len(part["negativePoints"]), dtype=np.int32)
    box = np.array(part["box"], dtype=np.float32) * np.array([width, height, width, height])

    def predict(stage, mask_input=None):
        masks, scores, logits = predictor.predict(
            point_coords=points, point_labels=labels, box=box,
            mask_input=mask_input, multimask_output=mask_input is None,
        )
        masks, scores, logits = np.asarray(masks), np.asarray(scores), np.asarray(logits)
        require(masks.ndim == 3 and masks.shape[1:] == (height, width)
                and 1 <= masks.shape[0] <= 3 and scores.shape == (masks.shape[0],)
                and logits.ndim == 3 and logits.shape[0] == masks.shape[0]
                and np.isfinite(scores).all() and np.isfinite(logits).all()
                and ((masks == 0) | (masks == 1)).all(),
                "SAM2 returned invalid candidate arrays", "engine_output_invalid")
        candidates = []
        for index, (mask, score) in enumerate(zip(masks.astype(bool), scores)):
            checks = point_checks(mask, part, width, height)
            candidates.append({"mask": mask, "logits": logits[index], "stage": stage,
                               "index": index, "modelScore": float(score), "pointChecks": checks})
        return candidates

    # Constraint violations precede SAM's predicted quality score; neither is visual acceptance.
    def rank(candidate):
        checks = candidate["pointChecks"]
        return checks["negativeIncluded"], checks["positiveMissing"], -candidate["modelScore"]

    initial = predict("initial")
    first = min(initial, key=rank)
    refined = predict("logits-refined", first["logits"][None, :, :])
    chosen = min([*initial, *refined], key=rank)
    report = {
        "label": part["label"], "box": part["box"],
        "selectedStage": chosen["stage"], "selectedIndex": chosen["index"],
        "modelScore": chosen["modelScore"], "pixels": int(chosen["mask"].sum()),
        "pointChecks": chosen["pointChecks"],
        "pointConstraintsSatisfied": chosen["pointChecks"]["positiveMissing"] == 0
        and chosen["pointChecks"]["negativeIncluded"] == 0,
        "predictionSeconds": time.perf_counter() - started,
        "candidates": [{"stage": item["stage"], "index": item["index"],
                        "modelScore": item["modelScore"],
                        "positiveMissing": item["pointChecks"]["positiveMissing"],
                        "negativeIncluded": item["pointChecks"]["negativeIncluded"]}
                       for item in [*initial, *refined]],
    }
    return chosen["mask"], report


def run(task, args):
    from PIL import Image, ImageOps
    import numpy as np

    started = time.perf_counter()
    source_path = absolute_path(task["sourcePath"], "sourcePath").resolve(strict=True)
    require(source_path.is_file(), "sourcePath must be a file", "source_invalid")
    output_dir = absolute_path(task["outputDir"], "outputDir")
    require(not output_dir.is_symlink(), "outputDir cannot be a symlink", "output_invalid")
    require(not output_dir.exists() or (output_dir.is_dir() and not any(output_dir.iterdir())),
            "outputDir must be absent or an empty directory", "output_invalid")
    require(output_dir.parent.is_dir(), "outputDir parent must already exist", "output_invalid")
    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    try:
        with Image.open(source_path) as original:
            require(original.width * original.height <= MAX_PIXELS,
                    "source exceeds 25 million pixels", "source_too_large")
            require(getattr(original, "n_frames", 1) == 1,
                    "source must contain exactly one frame", "source_multiframe")
            original_size, orientation = original.size, original.getexif().get(274)
            require(orientation is None or (type(orientation) is int and 1 <= orientation <= 8),
                    "source has invalid EXIF orientation", "source_invalid")
            source = ImageOps.exif_transpose(original).convert("RGB")
    except Image.DecompressionBombError as error:
        raise WorkerError("source_too_large", "source exceeds 25 million pixels") from error
    width, height = source.size
    for group in ["targets", "exclusions"]:
        for part in task[group]:
            positive = {tuple(pixel_point(point, width, height)) for point in part["positivePoints"]}
            negative = {tuple(pixel_point(point, width, height)) for point in part["negativePoints"]}
            require(not positive & negative, f"{part['label']} has conflicting points at source resolution",
                    "point_conflict")

    checkpoint = absolute_path(args.checkpoint, "checkpoint").resolve(strict=True)
    require(checkpoint.is_file(), "checkpoint must be a local file", "engine_config_invalid")
    import sam2
    import torch
    from sam2.build_sam import build_sam2
    from sam2.sam2_image_predictor import SAM2ImagePredictor

    config_root = Path(sam2.__file__).resolve().parent
    config_path = (config_root / args.config).resolve(strict=True)
    require(config_path.is_relative_to(config_root) and config_path.is_file(),
            "config must be an installed local SAM2 YAML file", "engine_config_invalid")
    engine = {"name": "sam2", "device": "cpu", "commit": args.engine_commit,
              "checkpointVersion": args.checkpoint_version, "checkpointSha256": sha256(checkpoint),
              "config": args.config, "configSha256": sha256(config_path),
              "torchVersion": torch.__version__, "pythonVersion": sys.version.split()[0]}
    torch.set_num_threads(args.threads)
    load_started = time.perf_counter()
    predictor = SAM2ImagePredictor(build_sam2(args.config, str(checkpoint), device="cpu",
                                            apply_postprocessing=False),
                                   max_hole_area=0, max_sprinkle_area=0)
    load_seconds = time.perf_counter() - load_started
    target, exclusion = np.zeros((height, width), dtype=bool), np.zeros((height, width), dtype=bool)
    reports = {"targets": [], "exclusions": []}
    with torch.inference_mode():
        embedding_started = time.perf_counter()
        predictor.set_image(np.asarray(source))
        embedding_seconds = time.perf_counter() - embedding_started
        prediction_started = time.perf_counter()
        for group, union in [("targets", target), ("exclusions", exclusion)]:
            for part in task[group]:
                try:
                    mask, report = select_mask(predictor, part, width, height)
                except WorkerError as error:
                    error.facts = {"group": group, "label": part["label"], "completedParts": reports}
                    raise
                union |= mask
                reports[group].append(report)
        prediction_seconds = time.perf_counter() - prediction_started

    editable = target & ~exclusion

    def positive_conflicts(group, mask):
        conflicts = []
        for part in task[group]:
            for index, point in enumerate(part["positivePoints"]):
                pixel = pixel_point(point, width, height)
                if mask[pixel[1], pixel[0]]:
                    conflicts.append({"label": part["label"], "pointIndex": index,
                                      "point": point, "pixel": pixel})
        return conflicts

    failures = []
    for group in ["targets", "exclusions"]:
        for part in reports[group]:
            checks = part["pointChecks"]
            if not part["pointConstraintsSatisfied"]:
                failures.append({"group": group, "label": part["label"],
                                 "positiveMissing": checks["positiveMissing"],
                                 "negativeIncluded": checks["negativeIncluded"],
                                 "missingPositive": [item for item in checks["positivePoints"]
                                                     if not item["included"]],
                                 "includedNegative": [item for item in checks["negativePoints"]
                                                      if item["included"]]})
    conflicts = {"overlapPixels": int((target & exclusion).sum()),
                 "targetPositiveExcluded": positive_conflicts("targets", exclusion),
                 "exclusionPositiveInTarget": positive_conflicts("exclusions", target)}
    # Ordinary overlap is expected before subtraction; erasing a required target point is not.
    for conflict in conflicts["targetPositiveExcluded"]:
        failures.append({"group": "target-exclusion-conflict", "label": conflict["label"],
                         "positiveMissing": 1, "negativeIncluded": 0,
                         "missingPositive": [{"point": conflict["point"],
                                              "pixel": conflict["pixel"], "included": False}],
                         "includedNegative": []})

    result = {
        "version": 1, "candidateOnly": True, "engine": engine,
        "source": {"width": width, "height": height, "originalWidth": original_size[0],
                   "originalHeight": original_size[1], "exifOrientation": orientation,
                   "sha256": sha256(source_path)},
        "parts": reports,
        "pointConstraintsSatisfied": not failures,
        "constraintFailures": failures,
        "conflicts": conflicts,
        "counts": {"targetPixels": int(target.sum()), "exclusionPixels": int(exclusion.sum()),
                   "editablePixelsAfterExclusion": int(editable.sum())},
        "timings": {"loadSeconds": load_seconds, "embeddingSeconds": embedding_seconds,
                    "predictionSeconds": prediction_seconds},
        "acceptance": "This is a segmentation candidate, not visual coverage or final-edit acceptance.",
    }
    require(result["counts"]["targetPixels"] > 0, "target union is empty", "empty_target")
    write_started = time.perf_counter()
    output_dir.mkdir(parents=False, exist_ok=True)
    artifacts = {}
    for name, mask in [("target", target), ("exclusion", exclusion)]:
        path = output_dir / f"{name}-union.png"
        with path.open("xb") as stream:
            Image.fromarray(mask.astype(np.uint8) * 255).save(stream, format="PNG")
        artifacts[name] = {"path": str(path.resolve()), "mime": "image/png",
                           "width": width, "height": height, "sha256": sha256(path)}
    result["artifacts"] = artifacts
    result["timings"].update(writeSeconds=time.perf_counter() - write_started,
                             totalSeconds=time.perf_counter() - started)
    with (output_dir / "result.json").open("x", encoding="utf-8") as stream:
        json.dump(result, stream, ensure_ascii=False, allow_nan=False, indent=2)
        stream.write("\n")
    if failures:
        raise WorkerError("point_constraints_unsatisfied",
                          "SAM2 cannot satisfy all point constraints; masks are debugging evidence only", result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, help="YAML name relative to the installed sam2 package")
    parser.add_argument("--checkpoint", required=True, help="Absolute path to an existing trusted checkpoint")
    parser.add_argument("--engine-commit", required=True, help="Caller-provided full SAM2 Git commit")
    parser.add_argument("--checkpoint-version", required=True, help="Caller-provided weight version fact")
    parser.add_argument("--threads", type=int, default=8)
    args = parser.parse_args()
    try:
        require(re.fullmatch(r"[0-9a-f]{40}", args.engine_commit) is not None,
                "engine-commit must be a full lowercase Git commit", "engine_config_invalid")
        require(1 <= len(args.checkpoint_version) <= 128
                and args.checkpoint_version == args.checkpoint_version.strip()
                and scalar_text(args.checkpoint_version),
                "checkpoint-version must be a nonempty caller-provided fact", "engine_config_invalid")
        config = PurePosixPath(args.config)
        require(re.fullmatch(r"[A-Za-z0-9_./+\-]+\.yaml", args.config) is not None
                and not config.is_absolute() and ".." not in config.parts,
                "config must name a local installed SAM2 YAML", "engine_config_invalid")
        require(1 <= args.threads <= 32, "threads must be 1..32", "engine_config_invalid")
        task = read_task(sys.stdin.buffer)
        # Libraries may print diagnostics; reserve stdout for one machine-readable JSON result.
        with contextlib.redirect_stdout(sys.stderr):
            result = run(task, args)
        print(json.dumps({"ok": True, **result}, ensure_ascii=False, allow_nan=False))
        return 0
    except WorkerError as error:
        result = {"ok": False, "version": 1,
                  "error": {"code": error.code, "message": str(error)}}
        if error.facts is not None:
            result["error"]["facts"] = error.facts
        print(json.dumps({"code": error.code, "message": str(error)}, ensure_ascii=False), file=sys.stderr)
        print(json.dumps(result, ensure_ascii=False, allow_nan=False))
        return 2
    except Exception as error:
        print(json.dumps({"ok": False, "version": 1, "error": {
            "code": "worker_failed", "message": str(error)[:1000],
        }}, ensure_ascii=False, allow_nan=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
