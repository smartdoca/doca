"""Run in the pinned local-model venv; never loads model weights."""
import asyncio
import hashlib
import importlib.util
import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx

spec = importlib.util.spec_from_file_location("mflux_image_server", Path(__file__).with_name("mflux-image-server.py"))
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)

class NativeProtocolTest(unittest.TestCase):
    def request(self, **changes):
        return dict(version=1, profile="mflux-flux2-klein-9b-q8-v1", model="flux2-klein-9b-8bit",
                    operation="generate", prompt="A cozy room", width=512, height=512, n=1, images=[], **changes)

    def test_rejects_ambiguous_versions_and_model_operations(self):
        valid = self.request()
        server.ImageInput.model_validate(valid)
        for change in [dict(version=True), dict(version=1.0), dict(n=True), dict(width="512"),
                       dict(model="gpt-image-1"), dict(profile="mflux-qwen-image-edit-2511-q8-v1"),
                       dict(operation="edit"), dict(prompt=" "), dict(width=513), dict(mask="old-field")]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                server.ImageInput.model_validate({**valid, **change})

    def test_weight_manifest_rejects_tampering_and_escape(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            model = root / "model"
            (model / "transformer").mkdir(parents=True)
            weight = model / "transformer" / "mock.safetensors"
            weight.write_bytes(b"test-only pinned bytes")
            entry = dict(profile="mflux-flux2-klein-9b-q8-v1", model="flux2-klein-9b-8bit", directory=str(model),
                         model_revision="a" * 40, verified_files=[dict(path="transformer/mock.safetensors",
                         size=weight.stat().st_size, sha256=hashlib.sha256(weight.read_bytes()).hexdigest())])
            manifest = root / "models.json"
            manifest.write_text(json.dumps(dict(version=1, models=[entry])))
            self.assertEqual(list(server.load_specs(manifest)), ["flux2-klein-9b-8bit"])
            weight.write_bytes(b"Test-only pinned bytes")
            with self.assertRaisesRegex(ValueError, "hash changed"):
                server.load_specs(manifest)
            escaped = root / "outside.safetensors"
            escaped.write_bytes(b"secret")
            entry["verified_files"] = [dict(path="../outside.safetensors", size=6, sha256=hashlib.sha256(b"secret").hexdigest())]
            manifest.write_text(json.dumps(dict(version=1, models=[entry])))
            with self.assertRaisesRegex(ValueError, "path/size changed"):
                server.load_specs(manifest)
            manifest.write_text(json.dumps(dict(version=True, models=[entry])))
            with self.assertRaisesRegex(ValueError, "manifest v1"):
                server.load_specs(manifest)

    def test_auth_and_bad_requests_never_start_generation(self):
        async def run():
            with tempfile.TemporaryDirectory() as tmp, patch.object(server.Backend, "generate") as generate:
                app = server.create_app({"flux2-klein-9b-8bit": {"model": "flux2-klein-9b-8bit", "profile": "mflux-flux2-klein-9b-q8-v1", "model_revision": "a" * 40}}, "test-private-key", Path(tmp))
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://localhost") as client:
                    self.assertEqual((await client.post("/v1/images", json=self.request())).status_code, 401)
                    self.assertEqual((await client.post("/v1/images", json={**self.request(), "version": 2}, headers={"Authorization": "Bearer test-private-key"})).status_code, 422)
                    generate.assert_not_called()
        asyncio.run(run())

    def test_serializes_native_requests_without_retries(self):
        active = 0
        maximum = 0
        calls = 0
        guard = threading.Lock()
        def generation(_backend, _value):
            nonlocal active, maximum, calls
            with guard:
                active += 1
                maximum = max(maximum, active)
                calls += 1
            time.sleep(.04)
            with guard:
                active -= 1
            return {"test_only": True}
        async def run():
            with tempfile.TemporaryDirectory() as tmp, patch.object(server.Backend, "generate", generation):
                app = server.create_app({"flux2-klein-9b-8bit": {}}, "test-private-key", Path(tmp))
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://localhost") as client:
                    result = await asyncio.gather(*[client.post("/v1/images", json=self.request(), headers={"Authorization": "Bearer test-private-key"}) for _ in range(2)])
                    self.assertEqual([item.status_code for item in result], [200, 200])
        asyncio.run(run())
        self.assertEqual((maximum, calls), (1, 2))

    def test_failure_preserves_artifacts_and_records_one_failure(self):
        calls = 0
        def generation(backend, _value):
            nonlocal calls
            calls += 1
            backend.last_request_id = "test-operation"
            folder = backend.output_root / backend.last_request_id
            folder.mkdir()
            (folder / "request-v1.json").write_text(json.dumps(dict(version=1, state="running")))
            (folder / "reference-test.txt").write_text("retained test bytes")
            raise ValueError("test-only runtime failure")
        async def run():
            with tempfile.TemporaryDirectory() as tmp, patch.object(server.Backend, "generate", generation):
                root = Path(tmp)
                app = server.create_app({"flux2-klein-9b-8bit": {}}, "test-private-key", root)
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://localhost") as client:
                    result = await client.post("/v1/images", json=self.request(), headers={"Authorization": "Bearer test-private-key"})
                self.assertEqual(result.status_code, 500)
                record = json.loads((root / "test-operation/request-v1.json").read_text())
                self.assertEqual((record["state"], record["error_type"]), ("failed", "ValueError"))
                self.assertEqual((root / "test-operation/reference-test.txt").read_text(), "retained test bytes")
        asyncio.run(run())
        self.assertEqual(calls, 1)

if __name__ == "__main__":
    unittest.main()
