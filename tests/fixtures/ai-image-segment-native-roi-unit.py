"""Native-ROI worker geometry tests; no SAM, NumPy, network or user images.

A small binary array double exercises the actual ROI/projection code while
the candidate predictor is explicit test evidence, never a host receipt.
"""

import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("native_roi_worker", sys.argv[1])
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
sys.argv = sys.argv[:1]


class Binary:
    def __init__(self, height, width):
        self.height, self.width = height, width
        self.shape = (height, width)
        self.values = bytearray(height * width)

    def __getitem__(self, key):
        y, x = key
        if isinstance(y, int) and isinstance(x, int):
            return bool(self.values[(y % self.height) * self.width + x % self.width])
        ys = list(range(self.height))[y] if isinstance(y, slice) else [y % self.height]
        xs = list(range(self.width))[x] if isinstance(x, slice) else [x % self.width]
        result = Binary(len(ys), len(xs))
        for row, sy in enumerate(ys):
            for column, sx in enumerate(xs):
                result[row, column] = self[sy, sx]
        return result

    def __setitem__(self, key, value):
        y, x = key
        if isinstance(y, int) and isinstance(x, int):
            self.values[(y % self.height) * self.width + x % self.width] = bool(value)
            return
        ys, xs = list(range(self.height))[y], list(range(self.width))[x]
        if isinstance(value, Binary):
            assert value.shape == (len(ys), len(xs))
        for row, sy in enumerate(ys):
            for column, sx in enumerate(xs):
                self[sy, sx] = value[row, column] if isinstance(value, Binary) else value

    def any(self):
        return any(self.values)

    def sum(self):
        return sum(self.values)


class NativeRGB:
    def __getitem__(self, key):
        y, x, channels = key
        assert channels == slice(None)
        # Source pixels are represented by their native coordinates; this
        # makes accidental crop resizing or shifted projection observable.
        return tuple(tuple((sx, sy, sx + sy) for sx in range(x.start, x.stop))
                     for sy in range(y.start, y.stop))


class Predictor:
    def __init__(self):
        self.images = []

    def set_image(self, image):
        self.images.append(image)


def part(box=None, positive=None, negative=None):
    return {
        "label": "test part",
        "box": [.4, .4, .6, .6] if box is None else box,
        "positivePoints": [[.5, .5]] if positive is None else positive,
        "negativePoints": [] if negative is None else negative,
    }


def candidate(pattern, observed):
    def select(predictor, hints, width, height):
        observed.append((hints, width, height))
        mask = pattern(width, height)
        checks = worker.point_checks(mask, hints, width, height)
        return mask, {
            "label": hints["label"], "box": hints["box"],
            "selectedStage": "logits-refined", "selectedIndex": 0,
            "modelScore": .8125, "pixels": mask.sum(), "pointChecks": checks,
            "pointConstraintsSatisfied": not (checks["positiveMissing"] or checks["negativeIncluded"]),
            "predictionSeconds": .125,
            "candidates": [
                {"stage": "initial", "index": 2, "modelScore": .7125,
                 "positiveMissing": checks["positiveMissing"], "negativeIncluded": checks["negativeIncluded"]},
                {"stage": "logits-refined", "index": 0, "modelScore": .8125,
                 "positiveMissing": checks["positiveMissing"], "negativeIncluded": checks["negativeIncluded"]},
            ],
        }
    return select


class NativeROI(unittest.TestCase):
    def setUp(self):
        self.numpy = patch.dict(sys.modules, {
            "numpy": types.SimpleNamespace(zeros=lambda shape, dtype: Binary(*shape)),
        })
        self.numpy.start()

    def tearDown(self):
        self.numpy.stop()

    def select(self, hints, pattern, width=256, height=256):
        predictor, observed = Predictor(), []
        with patch.object(worker, "select_mask", candidate(pattern, observed)):
            full, report, embedding = worker.select_mask_roi(
                predictor, hints, NativeRGB(), width, height)
        return full, report, predictor, observed, embedding

    def test_every_global_hint_including_far_negative_and_endpoints_keeps_pixel(self):
        hints = part(positive=[[.5, .5], [1, 1]], negative=[[.01, .99], [0, 0]])
        rect, local = worker.roi_geometry(hints, 1000, 800)
        left, top, right, bottom = rect
        self.assertEqual(rect, (0, 0, 1000, 800))
        for field in ["positivePoints", "negativePoints"]:
            self.assertEqual(len(local[field]), len(hints[field]))
            for original, mapped in zip(hints[field], local[field]):
                x, y = worker.pixel_point(original, 1000, 800)
                self.assertEqual(worker.pixel_point(mapped, right-left, bottom-top),
                                 [x-left, y-top])

    def test_context_is_fixed_bounded_and_deterministic(self):
        hints = part(box=[.4, .4, .401, .401], positive=[[.4, .4]])
        self.assertEqual(worker.roi_geometry(hints, 1000, 1000)[0], (368, 368, 433, 433))
        large = part(box=[.3, .3, .7, .7])
        self.assertEqual(worker.roi_geometry(large, 10000, 10000)[0],
                         (2872, 2872, 7128, 7128))
        self.assertEqual(worker.roi_geometry(large, 10000, 10000),
                         worker.roi_geometry(large, 10000, 10000))

    def test_fractional_native_box_keeps_exact_prompt_edges(self):
        hints = part(box=[.40025, .4005, .60175, .60225])
        (left, top, right, bottom), local = worker.roi_geometry(hints, 1000, 800)
        for index, edge in enumerate(local["box"]):
            offset = left if index % 2 == 0 else top
            span = right-left if index % 2 == 0 else bottom-top
            original_size = 1000 if index % 2 == 0 else 800
            self.assertAlmostEqual(edge * span + offset,
                                   hints["box"][index] * original_size)

    def test_same_polarity_pixel_aliases_are_not_dropped_or_rejected(self):
        hints = part(positive=[[.5001, .5001], [.5002, .5002]],
                     negative=[[.4001, .4001], [.4002, .4002]])
        worker.validate_part(hints, "test")
        _, local = worker.roi_geometry(hints, 1000, 1000)
        self.assertEqual(len(local["positivePoints"]), 2)
        self.assertEqual(local["positivePoints"][0], local["positivePoints"][1])
        self.assertEqual(len(local["negativePoints"]), 2)

    def test_lossless_projection_keeps_hole_disconnected_island_and_real_candidate_metadata(self):
        def shape(width, height):
            mask = Binary(height, width)
            mask[20:height-20, 20:width-20] = True
            mask[height//2-2:height//2+2, width//2-2:width//2+2] = False
            mask[10:13, 10:13] = True
            return mask
        hints = part()
        (left, top, right, bottom), _ = worker.roi_geometry(hints, 256, 256)
        full, report, predictor, observed, _ = self.select(hints, shape)
        expected = shape(right-left, bottom-top)
        self.assertEqual(full[top:bottom, left:right].values, expected.values)
        self.assertEqual(full.sum(), expected.sum())  # no pixels outside the ROI
        self.assertFalse(full[top+(bottom-top)//2, left+(right-left)//2])
        self.assertTrue(full[top+11, left+11])
        self.assertEqual(predictor.images[0][0][0], (left, top, left+top))
        self.assertEqual(predictor.images[0][-1][-1], (right-1, bottom-1, right+bottom-2))
        self.assertEqual(len(predictor.images), 1)
        self.assertEqual(len(observed), 1)  # no whole-frame prediction or OR fallback
        self.assertEqual((report["selectedStage"], report["selectedIndex"], report["modelScore"]),
                         ("logits-refined", 0, .8125))
        self.assertEqual(report["predictionSeconds"], .125)
        self.assertEqual(report["box"], hints["box"])
        self.assertEqual(set(report), {"label", "box", "selectedStage", "selectedIndex", "modelScore",
                                      "pixels", "pointChecks", "pointConstraintsSatisfied",
                                      "predictionSeconds", "candidates"})

    def test_all_four_internal_edges_fail_without_reembedding_or_expanding(self):
        for edge in ["left", "top", "right", "bottom"]:
            with self.subTest(edge=edge):
                def shape(width, height):
                    mask = Binary(height, width)
                    x = 0 if edge == "left" else width-1 if edge == "right" else width//2
                    y = 0 if edge == "top" else height-1 if edge == "bottom" else height//2
                    mask[y, x] = True
                    return mask
                predictor, observed = Predictor(), []
                with patch.object(worker, "select_mask", candidate(shape, observed)):
                    with self.assertRaises(worker.WorkerError) as error:
                        worker.select_mask_roi(predictor, part(), NativeRGB(), 500, 500)
                self.assertEqual(error.exception.code, "roi_boundary_touched")
                self.assertEqual(len(predictor.images), 1)
                self.assertEqual(len(observed), 1)

    def test_original_image_border_is_a_real_source_limit(self):
        for edge, box, point, pixel in [
            ("left", [0, .4, .1, .6], [0, .5], [0, 100]),
            ("top", [.4, 0, .6, .1], [.5, 0], [100, 0]),
            ("right", [.9, .4, 1, .6], [1, .5], [199, 100]),
            ("bottom", [.4, .9, .6, 1], [.5, 1], [100, 199]),
        ]:
            with self.subTest(edge=edge):
                def shape(width, height):
                    mask = Binary(height, width)
                    x = 0 if edge == "left" else width-1 if edge == "right" else width//2
                    y = 0 if edge == "top" else height-1 if edge == "bottom" else height//2
                    mask[y, x] = True
                    return mask
                full, _, _, _, _ = self.select(part(box=box, positive=[point]), shape, 200, 200)
                # The same original image edge is selected, without extending
                # the source canvas or treating it as an internal crop edge.
                self.assertTrue(full[:, 0].any() if edge == "left" else
                                full[0, :].any() if edge == "top" else
                                full[:, -1].any() if edge == "right" else full[-1, :].any())

    def test_opposite_polarity_pixel_alias_fails_before_engine_load(self):
        class Image:
            width, height, size = 1000, 800, (1000, 800)
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def getexif(self): return {}
            def convert(self, mode): return self
        image_module = types.SimpleNamespace(open=lambda _: Image(),
                                             DecompressionBombError=RuntimeError)
        pil = types.SimpleNamespace(Image=image_module,
                                    ImageOps=types.SimpleNamespace(exif_transpose=lambda image: image))
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "source.png"
            source.write_bytes(b"isolated source identity")
            task = {"version": 1, "sourcePath": str(source),
                    "outputDir": str(Path(temporary) / "output"),
                    "targets": [part(positive=[[.5001, .5001]], negative=[[.5002, .5002]])],
                    "exclusions": []}
            worker.validate_task(task)  # distinct normalized points are valid
            with patch.dict(sys.modules, {"PIL": pil}):
                with self.assertRaises(worker.WorkerError) as error:
                    worker.run(task, types.SimpleNamespace())
            self.assertEqual(error.exception.code, "point_conflict")
            self.assertFalse((Path(temporary) / "output").exists())

    def test_constraints_are_recomputed_with_original_global_points(self):
        def shape(width, height):
            mask = Binary(height, width)
            mask[10:height-10, 10:width-10] = True
            return mask
        hints = part(positive=[[.45, .45]], negative=[[.55, .55]])
        _, report, _, _, _ = self.select(hints, shape)
        self.assertEqual(report["pointChecks"]["negativePoints"][0],
                         {"point": [.55, .55], "pixel": [140, 140], "included": True})
        self.assertEqual(report["pointChecks"]["negativeIncluded"], 1)
        self.assertFalse(report["pointConstraintsSatisfied"])

    def test_exact_v1_input_never_accepts_algorithm_fields_or_missing_version(self):
        task = {"version": 1, "sourcePath": "/tmp/source.png", "outputDir": "/tmp/output",
                "targets": [part()], "exclusions": []}
        worker.validate_task(task)
        for invalid in [{k: v for k, v in task.items() if k != "version"},
                        {**task, "algorithm": "native-roi"}, {**task, "version": 2}]:
            with self.assertRaises(worker.WorkerError):
                worker.validate_task(invalid)
        raw = json.dumps(task).replace('"version": 1', '"version": 1, "version": 1')
        with self.assertRaises(worker.WorkerError):
            worker.read_task(io.BytesIO(raw.encode()))


if __name__ == "__main__":
    unittest.main()
