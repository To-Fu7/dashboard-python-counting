"""gRPC client for YOLO person detection served by NVIDIA Triton.

The camera container is a thin client: no torch, no CUDA context. All model
knowledge (input name/shape/precision, output layout) is discovered from Triton
model metadata at connect time, so the same client code serves TensorRT engines
(jetson/server modes) and onnxruntime-CPU models (cpu mode) without config drift.

Failure model (Triton is a shared dependency for every camera):
- connect() and infer() raise TritonUnavailableError on transport/server errors.
- The caller (main loop) keeps the RTSP capture alive, backs off exponentially,
  and resets the tracker after reconnect — the process never exits because of
  Triton being down.
"""
from __future__ import annotations

import logging

import numpy as np

import tritonclient.grpc as grpcclient
from tritonclient.utils import InferenceServerException

from .postprocessing import decode_e2e, decode_raw, is_end_to_end, unletterbox
from .preprocessing import preprocess

_TRITON_TO_NP = {"FP32": np.float32, "FP16": np.float16}


class TritonUnavailableError(RuntimeError):
    """Raised when Triton cannot be reached or inference fails server-side."""


class TritonYoloClient:
    def __init__(
        self,
        url: str,
        model_name: str,
        conf_thresh: float = 0.3,
        iou_thresh: float = 0.3,
        class_id: int | None = 0,
        timeout_s: float = 10.0,
    ):
        self.url = url
        self.model_name = model_name
        self.conf_thresh = conf_thresh
        self.iou_thresh = iou_thresh
        self.class_id = class_id
        self.timeout_s = timeout_s

        self._client: grpcclient.InferenceServerClient | None = None
        self.input_name: str | None = None
        self.input_dtype = np.float32
        self.input_shape: tuple[int, int] = (640, 640)  # (H, W)
        self.output_name: str | None = None
        self.end_to_end: bool = True
        self._batched_model = True  # config.max_batch_size > 0

    @property
    def connected(self) -> bool:
        return self._client is not None

    def connect(self):
        """Open the gRPC channel and read model metadata/config."""
        try:
            client = grpcclient.InferenceServerClient(url=self.url, verbose=False)
            if not client.is_server_ready():
                raise TritonUnavailableError(f"Triton at {self.url} is not ready")
            if not client.is_model_ready(self.model_name):
                raise TritonUnavailableError(
                    f"Model '{self.model_name}' is not loaded on Triton at {self.url}"
                )

            meta = client.get_model_metadata(self.model_name, as_json=True)
            config = client.get_model_config(self.model_name, as_json=True).get("config", {})
        except InferenceServerException as e:
            raise TritonUnavailableError(f"Triton connect failed ({self.url}): {e}") from e

        inp = meta["inputs"][0]
        out = meta["outputs"][0]
        self.input_name = inp["name"]
        self.output_name = out["name"]
        self.input_dtype = _TRITON_TO_NP.get(inp["datatype"], np.float32)
        self._batched_model = int(config.get("max_batch_size", 0) or 0) > 0

        # dims exclude the batch axis when max_batch_size > 0
        dims = [int(d) for d in inp["shape"]]
        hw = dims[-2:] if len(dims) >= 2 else [640, 640]
        self.input_shape = tuple(640 if d <= 0 else d for d in hw)

        out_dims = [int(d) for d in out["shape"]]
        self.end_to_end = is_end_to_end(tuple(out_dims))

        self._client = client
        logging.info(
            f"[Triton] Connected {self.url} model={self.model_name} "
            f"input={self.input_name}{list(self.input_shape)} dtype={inp['datatype']} "
            f"output={self.output_name} e2e={self.end_to_end}"
        )

    def close(self):
        if self._client is not None:
            try:
                self._client.close()
            except Exception:
                pass
            self._client = None

    def infer(self, frame_bgr: np.ndarray) -> np.ndarray:
        """Detect persons in a BGR frame. Returns [N, 6] x1,y1,x2,y2,conf,cls in frame pixels."""
        if self._client is None:
            self.connect()

        tensor, ratio, pad = preprocess(frame_bgr, self.input_shape, self.input_dtype)
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

        output = result.as_numpy(self.output_name).astype(np.float32)

        if self.end_to_end:
            dets = decode_e2e(output, self.conf_thresh, self.class_id)
        else:
            dets = decode_raw(output, self.conf_thresh, self.iou_thresh, self.class_id)

        return unletterbox(dets, ratio, pad, frame_bgr.shape[:2])
