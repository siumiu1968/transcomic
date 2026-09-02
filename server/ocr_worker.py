#!/usr/bin/env python3
"""Persistent JSONL OCR worker. One request and one response per line."""

from __future__ import annotations

import argparse
import base64
import json
import sys
from typing import Any, Iterable


def _load_engine(backend: str):
    if backend == "paddleocr":
        from paddleocr import PaddleOCR

        return PaddleOCR(use_angle_cls=True, lang="en", show_log=False)

    try:
        from rapidocr_onnxruntime import RapidOCR
    except ImportError:
        from rapidocr import RapidOCR
    return RapidOCR()


def _flatten_paddle(value: Any) -> Iterable[Any]:
    if not isinstance(value, list):
        return []
    if value and isinstance(value[0], list) and len(value[0]) == 2 and isinstance(value[0][1], (list, tuple)):
        return value
    return [item for group in value if isinstance(group, list) for item in _flatten_paddle(group)]


def _recognise(engine: Any, backend: str, image: Any) -> Iterable[Any]:
    if backend == "paddleocr":
        return _flatten_paddle(engine.ocr(image, cls=True))
    result = engine(image)
    if hasattr(result, "boxes") and hasattr(result, "txts") and hasattr(result, "scores"):
        boxes = result.boxes if result.boxes is not None else []
        texts = result.txts if result.txts is not None else []
        scores = result.scores if result.scores is not None else []
        return zip(boxes, texts, scores)
    return result[0] or [] if isinstance(result, tuple) else result or []


def _word(item: Any, backend: str, index: int) -> dict[str, Any] | None:
    try:
        box, text, score = (item[0], item[1][0], item[1][1]) if backend == "paddleocr" else item[:3]
        points = [(float(point[0]), float(point[1])) for point in box]
        left = min(point[0] for point in points)
        top = min(point[1] for point in points)
        right = max(point[0] for point in points)
        bottom = max(point[1] for point in points)
        text = str(text).strip()
        if not text or right <= left or bottom <= top:
            return None
        return {
            "x": round(left),
            "y": round(top),
            "width": max(1, round(right - left)),
            "height": max(1, round(bottom - top)),
            "confidence": round(float(score) * 100, 2),
            "line": f"{backend}:{index}",
            "text": text,
            "engine": backend,
        }
    except (IndexError, TypeError, ValueError):
        return None


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--backend", choices=("rapidocr", "paddleocr"), default="rapidocr")
    args = parser.parse_args()

    import cv2
    import numpy as np

    engine = _load_engine(args.backend)
    for raw_line in sys.stdin:
        request_id: Any = None
        try:
            request = json.loads(raw_line)
            request_id = request.get("id")
            encoded = request.get("image_base64", "")
            image = cv2.imdecode(np.frombuffer(base64.b64decode(encoded, validate=True), dtype=np.uint8), cv2.IMREAD_COLOR)
            if image is None:
                raise ValueError("invalid image")
            words = [word for index, item in enumerate(_recognise(engine, args.backend, image)) if (word := _word(item, args.backend, index))]
            response = {"id": request_id, "words": words}
        except Exception as error:
            response = {"id": request_id, "error": f"{type(error).__name__}: {error}", "words": []}
        sys.stdout.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
