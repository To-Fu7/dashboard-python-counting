"""Resolve Triton class ids to human-readable labels.

Triton's inference API only returns numeric class ids. The label names live in
metadata.json written by tools/export_model.py next to each model's ONNX file
in the shared models/ repository — which every camera container already has
read access to via its /app bind mount (docker-compose mounts the whole
python-counting/ directory, models/ included).
"""
from __future__ import annotations

import json
import logging
import os


def load_model_classes(model_name: str) -> dict[int, str]:
    """Return {class_id: label} for a Triton model, or {} if metadata is missing."""
    path = os.path.join('models', model_name, 'metadata.json')
    if not os.path.exists(path):
        logging.warning(
            f"No metadata.json for model '{model_name}' at {path} — "
            f"labels will show as class_<id>"
        )
        return {}
    try:
        with open(path) as f:
            meta = json.load(f)
        classes = meta.get('classes', {})
        return {int(k): v for k, v in classes.items()}
    except Exception as e:
        logging.error(f"Failed to load classes for model '{model_name}': {e}")
        return {}
