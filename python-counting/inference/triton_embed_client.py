"""gRPC client for a face-embedding model (ArcFace) served by NVIDIA Triton.

Same thin-client philosophy as TritonYoloClient: no torch/CUDA in the camera
container, model input shape/dtype discovered from Triton metadata at connect
time. Unlike the YOLO client this has no decode step — the model output IS
the embedding vector.
"""
from __future__ import annotations

import logging

import cv2
import numpy as np

import tritonclient.grpc as grpcclient
from tritonclient.utils import InferenceServerException

from .triton_client import TritonUnavailableError

_TRITON_TO_NP = {"FP32": np.float32, "FP16": np.float16}


class TritonEmbedClient:
    def __init__(self, url: str, model_name: str, timeout_s: float = 10.0):
        self.url = url
        self.model_name = model_name
        self.timeout_s = timeout_s

        self._client: grpcclient.InferenceServerClient | None = None
        self.input_name: str | None = None
        self.input_dtype = np.float32
        self.input_shape: tuple[int, int] = (112, 112)  # (H, W)
        self.output_name: str | None = None

    @property
    def connected(self) -> bool:
        return self._client is not None

    def connect(self):
        try:
            client = grpcclient.InferenceServerClient(url=self.url, verbose=False)
            if not client.is_server_ready():
                raise TritonUnavailableError(f"Triton at {self.url} is not ready")
            if not client.is_model_ready(self.model_name):
                raise TritonUnavailableError(
                    f"Model '{self.model_name}' is not loaded on Triton at {self.url}"
                )
            meta = client.get_model_metadata(self.model_name, as_json=True)
        except InferenceServerException as e:
            raise TritonUnavailableError(f"Triton connect failed ({self.url}): {e}") from e

        inp = meta["inputs"][0]
        out = meta["outputs"][0]
        self.input_name = inp["name"]
        self.output_name = out["name"]
        self.input_dtype = _TRITON_TO_NP.get(inp["datatype"], np.float32)

        dims = [int(d) for d in inp["shape"]]
        hw = dims[-2:] if len(dims) >= 2 else [112, 112]
        self.input_shape = tuple(112 if d <= 0 else d for d in hw)

        self._client = client
        logging.info(
            f"[Triton] Connected {self.url} model={self.model_name} "
            f"input={self.input_name}{list(self.input_shape)} dtype={inp['datatype']} "
            f"output={self.output_name}"
        )

    def close(self):
        if self._client is not None:
            try:
                self._client.close()
            except Exception:
                pass
            self._client = None

    def _preprocess(self, face_bgr: np.ndarray) -> np.ndarray:
        """Plain resize (no letterbox — face crops are already roughly square)
        + BGR->RGB + normalize to [-1, 1] + NCHW, the standard ArcFace input prep."""
        h, w = self.input_shape
        resized = cv2.resize(face_bgr, (w, h), interpolation=cv2.INTER_LINEAR)
        rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB).astype(self.input_dtype)
        normalized = (rgb - 127.5) / 128.0
        return np.transpose(normalized, (2, 0, 1))[np.newaxis, ...]

    def infer(self, face_bgr: np.ndarray) -> np.ndarray:
        """Embed a cropped face (BGR). Returns a 1-D embedding vector."""
        if self._client is None:
            self.connect()

        tensor = self._preprocess(face_bgr)
        triton_dtype = "FP16" if self.input_dtype == np.float16 else "FP32"
        infer_input = grpcclient.InferInput(self.input_name, list(tensor.shape), triton_dtype)
        infer_input.set_data_from_numpy(tensor)
        outputs = [grpcclient.InferRequestedOutput(self.output_name)]

        try:
            result = self._client.infer(
                model_name=self.model_name,
                inputs=[infer_input],
                outputs=outputs,
                client_timeout=self.timeout_s,
            )
        except InferenceServerException as e:
            self.close()
            raise TritonUnavailableError(f"Triton infer failed ({self.url}): {e}") from e

        return result.as_numpy(self.output_name).astype(np.float32).reshape(-1)
