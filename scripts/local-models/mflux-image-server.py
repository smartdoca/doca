"""Authenticated, serialized local image protocol v1. No model downloads or retries."""
import os
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
import argparse
import asyncio
import base64
import gc
import hashlib
import importlib.metadata
import io
import json
import secrets
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, Request
from PIL import Image, ImageOps
from pydantic import BaseModel, ConfigDict, Field, model_validator

PROFILES = {
    "mflux-flux2-klein-9b-q8-v1": "flux2-klein-9b-8bit",
    "mflux-qwen-image-edit-2511-q8-v1": "qwen-image-edit-2511-8bit",
}
MAX_BODY = 114 * 1024 * 1024
Image.MAX_IMAGE_PIXELS = 25_000_000

class Reference(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mime: Literal["image/png", "image/jpeg", "image/webp"]
    b64_json: str = Field(min_length=4, max_length=14 * 1024 * 1024)
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")

class ImageInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: Literal[1]
    profile: Literal["mflux-flux2-klein-9b-q8-v1", "mflux-qwen-image-edit-2511-q8-v1"]
    model: Literal["flux2-klein-9b-8bit", "qwen-image-edit-2511-8bit"]
    operation: Literal["generate", "reference", "edit"]
    prompt: str = Field(min_length=1, max_length=16000)
    width: int = Field(ge=128, le=2048, strict=True)
    height: int = Field(ge=128, le=2048, strict=True)
    n: Literal[1]
    images: list[Reference] = Field(max_length=8)

    @model_validator(mode="before")
    @classmethod
    def strict_version(cls, value):
        if not isinstance(value, dict) or type(value.get("version")) is not int or type(value.get("n")) is not int:
            raise ValueError("Version and count must be explicit integers")
        return value

    @model_validator(mode="after")
    def validate_operation(self):
        if PROFILES[self.profile] != self.model or not self.prompt.strip():
            raise ValueError("Explicit model/profile mismatch or empty prompt")
        if self.width % 16 or self.height % 16 or self.width * self.height < 256 * 256 or max(self.width / self.height, self.height / self.width) > 4:
            raise ValueError("Unsupported dimensions")
        if (self.operation == "generate") != (not self.images):
            raise ValueError("Operation/reference mismatch")
        if self.model == "qwen-image-edit-2511-8bit" and self.operation == "generate":
            raise ValueError("Qwen Edit requires source images")
        return self

def load_specs(path: Path):
    config = json.loads(path.read_text())
    if set(config) != {"version", "models"} or type(config["version"]) is not int or config["version"] != 1 or not isinstance(config["models"], list):
        raise ValueError("Expected model manifest v1")
    result = {}
    for entry in config["models"]:
        if set(entry) != {"profile", "model", "directory", "model_revision", "verified_files"} or PROFILES.get(entry["profile"]) != entry["model"] or entry["model"] in result:
            raise ValueError("Invalid model manifest entry")
        directory = Path(entry["directory"]).resolve(strict=True)
        if not directory.is_dir() or len(entry["model_revision"]) not in [40, 64] or any(c not in "0123456789abcdef" for c in entry["model_revision"]):
            raise ValueError("Invalid pinned model directory/revision")
        seen = set()
        for item in entry["verified_files"]:
            if set(item) != {"path", "size", "sha256"} or item["path"] in seen:
                raise ValueError("Invalid verified file inventory")
            seen.add(item["path"])
            file = (directory / item["path"]).resolve(strict=True)
            if not file.is_relative_to(directory) or file.stat().st_size != item["size"]:
                raise ValueError("Model file path/size changed")
            digest = hashlib.sha256()
            with file.open("rb") as source:
                for block in iter(lambda: source.read(8 * 1024 * 1024), b""):
                    digest.update(block)
            if digest.hexdigest() != item["sha256"]:
                raise ValueError("Model file hash changed")
        if not seen or not any(p.startswith("transformer/") for p in seen):
            raise ValueError("Missing verified weights")
        result[entry["model"]] = entry
    if not result:
        raise ValueError("No pinned models configured")
    return result

class Backend:
    def __init__(self, specs, output_root):
        if importlib.metadata.version("mflux") != "0.22.0":
            raise ValueError("Expected MFLUX 0.22.0")
        self.specs = specs
        self.output_root = output_root
        self.current = None
        self.current_key = None

    def generate(self, value: ImageInput):
        self.last_request_id = None
        import mlx.core as mx
        from mflux.models.common.config.model_config import ModelConfig
        from mflux.models.flux2.variants import Flux2Klein, Flux2KleinEdit
        from mflux.models.qwen.variants.edit.qwen_image_edit import QwenImageEdit
        request_id = str(uuid.uuid4())
        self.last_request_id = request_id
        folder = self.output_root / request_id
        folder.mkdir(mode=0o700)
        (folder / "request-v1.json").write_text(json.dumps(dict(version=1, request_id=request_id, state="running", pid=os.getpid(),
            profile=value.profile, model=value.model, operation=value.operation, width=value.width, height=value.height,
            input_sha256=[item.sha256 for item in value.images], prompt_sha256=hashlib.sha256(value.prompt.encode()).hexdigest(),
            started_at=time.time()), indent=2))
        paths = []
        input_hashes = []
        for index, reference in enumerate(value.images):
            raw = base64.b64decode(reference.b64_json, validate=True)
            if not raw or len(raw) > 10 * 1024 * 1024 or hashlib.sha256(raw).hexdigest() != reference.sha256:
                raise ValueError("Reference bytes/hash mismatch")
            image = Image.open(io.BytesIO(raw))
            if Image.MIME.get(image.format) != reference.mime or getattr(image, "n_frames", 1) != 1:
                raise ValueError("Reference type/frame mismatch")
            image.load()
            if image.width * image.height > 25_000_000 or image.convert("RGBA").getchannel("A").getextrema() != (255, 255):
                raise ValueError("Invalid or transparent reference")
            file = folder / f"reference-{index}.png"
            ImageOps.exif_transpose(image).convert("RGB").save(file)
            paths.append(str(file))
            input_hashes.append(reference.sha256)
        spec = self.specs[value.model]
        kind = "generate" if value.operation == "generate" else "edit"
        started = time.monotonic()
        # Low-RAM callbacks evict modules. Every operation loads its exact
        # pinned model, rather than reusing an evicted instance after failure.
        self.current = None
        self.current_key = None
        gc.collect()
        mx.clear_cache()
        if value.model == "flux2-klein-9b-8bit":
            cls = Flux2Klein if kind == "generate" else Flux2KleinEdit
            self.current = cls(model_config=ModelConfig.flux2_klein_9b(), model_path=spec["directory"], quantize=8)
        else:
            self.current = QwenImageEdit(model_config=ModelConfig.qwen_image_edit_2511(), model_path=spec["directory"], quantize=8)
        from mflux.models.common.vae.tiling_config import TilingConfig
        from mflux.callbacks.instances.memory_saver import MemorySaver
        self.current.tiling_config = TilingConfig(vae_decode_tile_size=512)
        self.current.callbacks.register(MemorySaver(model=self.current, keep_transformer=False, keep_text_encoder=False, cache_limit_bytes=1_000_000_000))
        seed = secrets.randbelow(2147483648)
        steps = 4 if value.model == "flux2-klein-9b-8bit" else 30
        params = dict(seed=seed, prompt=value.prompt, width=value.width, height=value.height, num_inference_steps=steps,
                      guidance=1.0 if value.model == "flux2-klein-9b-8bit" else 2.5)
        if kind == "edit":
            params["image_paths"] = paths
        generated = self.current.generate_image(**params)
        target = folder / "output.png"
        generated.save(path=str(target))
        with Image.open(target) as result:
            result.load()
            dimensions = result.size
        if dimensions != (value.width, value.height):
            raise ValueError("Generated dimensions do not match request; retained actual output")
        raw = target.read_bytes()
        runtime = dict(implementation="mflux", implementation_version="0.22.0", steps=steps, seed=seed,
                       elapsed_seconds=round(time.monotonic() - started, 3), model_revision=spec["model_revision"])
        reply = dict(version=1, status="completed", profile=value.profile, model=value.model, request_id=request_id,
                     input_sha256=input_hashes, data=[dict(b64_json=base64.b64encode(raw).decode(), mime="image/png", width=dimensions[0], height=dimensions[1], sha256=hashlib.sha256(raw).hexdigest())],
                     usage=dict(input_images=len(paths), generated_images=1, runtime=runtime))
        (folder / "receipt.json").write_text(json.dumps({k: v for k, v in reply.items() if k != "data"}, indent=2))
        journal = folder / "request-v1.json"
        record = json.loads(journal.read_text())
        record.update(state="completed", ended_at=time.time(), output_sha256=reply["data"][0]["sha256"])
        journal.write_text(json.dumps(record, indent=2))
        # MemorySaver intentionally evicts encoder and transformer modules.
        # Release the one-shot model before another request; never reuse it
        # with missing modules or silently change model families.
        self.current = None
        self.current_key = None
        gc.collect()
        mx.clear_cache()
        return reply

def create_app(specs, key, output_root):
    app = FastAPI(docs_url=None, redoc_url=None)
    executor = ThreadPoolExecutor(max_workers=1)
    lock = asyncio.Lock()
    backend = Backend(specs, output_root)
    def authenticate(request):
        if not secrets.compare_digest(request.headers.get("Authorization", ""), "Bearer " + key):
            raise HTTPException(401, "Authentication required")

    @app.get("/v1/models")
    async def models(request: Request):
        authenticate(request)
        return dict(version=1, models=[dict(model=entry["model"], profile=entry["profile"], model_revision=entry["model_revision"]) for entry in specs.values()])

    @app.post("/v1/images")
    async def images(request: Request):
        authenticate(request)
        chunks = []
        size = 0
        async for chunk in request.stream():
            size += len(chunk)
            if size > MAX_BODY:
                raise HTTPException(413, "Request too large")
            chunks.append(chunk)
        try:
            value = ImageInput.model_validate_json(b"".join(chunks))
            if value.model not in specs:
                raise ValueError("Model not registered")
        except Exception:
            raise HTTPException(422, "Invalid protocol v1 request")
        async with lock:
            if await request.is_disconnected():
                raise HTTPException(409, "Request disconnected before generation")
            try:
                return await asyncio.get_running_loop().run_in_executor(executor, backend.generate, value)
            except Exception as error:
                # Actual artifacts remain private; no implicit resubmission.
                request_id = getattr(backend, "last_request_id", None)
                if request_id:
                    journal = output_root / request_id / "request-v1.json"
                    if journal.exists():
                        record = json.loads(journal.read_text())
                        record.update(state="failed", error_type=type(error).__name__, ended_at=time.time())
                        journal.write_text(json.dumps(record, indent=2))
                backend.current = None
                backend.current_key = None
                gc.collect()
                import mlx.core as mx
                mx.clear_cache()
                print(json.dumps(dict(event="generation_failed", error_type=type(error).__name__)), flush=True)
                raise HTTPException(500, "Local generation failed; artifacts retained")
    return app

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--models", required=True, type=Path)
    parser.add_argument("--key-file", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--port", type=int, default=39365)
    args = parser.parse_args()
    key = args.key_file.read_text().strip()
    if len(key) < 24:
        raise ValueError("A private authentication key is required")
    args.output.mkdir(parents=True, exist_ok=True, mode=0o700)
    specs = load_specs(args.models)
    import uvicorn
    uvicorn.run(create_app(specs, key, args.output), host="127.0.0.1", port=args.port, access_log=False)

if __name__ == "__main__":
    main()
