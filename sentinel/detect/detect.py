"""Sentinel object detector: finds people and animals in frames of motion events.

A long-running worker started by Sentinel. It never watches video continuously: it only
sees the handful of frames Sentinel asks about when something moves.

Two models: a fast one ("scan") looks at each frame, and a bigger, more accurate one
("verify") takes a second, zoomed-in look at anything the first one found. A label only
counts when both agree, which keeps a cat from being called a person.

Protocol (stdin/stdout, one request at a time):
  request:  "<w> <h> <model>\n" (model "scan" or "verify") followed by w*h*3 bytes of
            RGB (w and h at most the model size)
  response: one JSON line: [[class, score, x, y, w, h], ...] with the box normalised to
            the picture (0..1), best first
The models are YOLOX (Apache-2.0), COCO classes.
"""

import json
import os
import sys

import numpy as np
import onnxruntime as ort

MODEL = os.environ.get("SENTINEL_DETECT_MODEL", "/app/detect/yolox_s.onnx")
VERIFY_MODEL = os.environ.get("SENTINEL_VERIFY_MODEL", "/app/detect/yolox_m.onnx")
# COCO ids worth an alert, and the name Sentinel shows.
CLASSES = {0: "person", 15: "cat", 16: "dog"}
MIN_SCORE = 0.3


class Model:
    def __init__(self, path):
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = 2  # leave the other cores to the recorders
        opts.inter_op_num_threads = 1
        self.sess = ort.InferenceSession(path, opts, providers=["CPUExecutionProvider"])
        self.inp = self.sess.get_inputs()[0]
        self.size = size = int(self.inp.shape[2])
        grids, strides = [], []
        for s in (8, 16, 32):
            n = size // s
            ys, xs = np.meshgrid(np.arange(n), np.arange(n), indexing="ij")
            grids.append(np.stack((xs, ys), 2).reshape(-1, 2))
            strides.append(np.full((n * n, 1), s))
        self.grid = np.concatenate(grids).astype(np.float32)
        self.stride = np.concatenate(strides).astype(np.float32)

    def detect(self, data, w, h):
        size = self.size
        img = np.full((size, size, 3), 114, np.uint8)
        # YOLOX was trained on BGR, top-left letterboxed with grey 114.
        img[:h, :w] = np.frombuffer(data, np.uint8).reshape(h, w, 3)[:, :, ::-1]
        x = img.transpose(2, 0, 1)[None].astype(np.float32)
        p = self.sess.run(None, {self.inp.name: x})[0][0]
        p[:, :2] = (p[:, :2] + self.grid) * self.stride
        p[:, 2:4] = np.exp(p[:, 2:4]) * self.stride
        found = []
        for cid, name in CLASSES.items():
            score = p[:, 4] * p[:, 5 + cid]
            keep = score > MIN_SCORE
            if not keep.any():
                continue
            boxes = p[keep, :4]
            sc = score[keep]
            for i in nms(boxes, sc):
                cx, cy, bw, bh = boxes[i]
                x0, y0 = max(cx - bw / 2, 0), max(cy - bh / 2, 0)
                x1, y1 = min(cx + bw / 2, w), min(cy + bh / 2, h)
                if x1 <= x0 or y1 <= y0:
                    continue
                found.append([name, round(float(sc[i]), 3), round(float(x0 / w), 4), round(float(y0 / h), 4),
                              round(float((x1 - x0) / w), 4), round(float((y1 - y0) / h), 4)])
        found.sort(key=lambda d: -d[1])
        return found


def main():
    ort.set_default_logger_severity(3)  # errors only
    models = {"scan": Model(MODEL)}
    if os.path.exists(VERIFY_MODEL):
        models["verify"] = Model(VERIFY_MODEL)
    out = sys.stdout
    out.write(json.dumps({"ready": True, "size": models["scan"].size,
                          "models": {k: m.size for k, m in models.items()}}) + "\n")
    out.flush()
    src = sys.stdin.buffer
    while True:
        line = src.readline()
        if not line:
            return
        parts = line.split()
        w, h = int(parts[0]), int(parts[1])
        name = parts[2].decode() if len(parts) > 2 else "scan"
        m = models.get(name, models["scan"])
        data = src.read(w * h * 3)
        if len(data) != w * h * 3 or w > m.size or h > m.size:
            return
        out.write(json.dumps(m.detect(data, w, h)) + "\n")
        out.flush()


def nms(boxes, scores, iou=0.45):
    x0, y0 = boxes[:, 0] - boxes[:, 2] / 2, boxes[:, 1] - boxes[:, 3] / 2
    x1, y1 = boxes[:, 0] + boxes[:, 2] / 2, boxes[:, 1] + boxes[:, 3] / 2
    area = boxes[:, 2] * boxes[:, 3]
    order = scores.argsort()[::-1]
    keep = []
    while order.size:
        i = order[0]
        keep.append(i)
        ix0, iy0 = np.maximum(x0[i], x0[order[1:]]), np.maximum(y0[i], y0[order[1:]])
        ix1, iy1 = np.minimum(x1[i], x1[order[1:]]), np.minimum(y1[i], y1[order[1:]])
        inter = np.clip(ix1 - ix0, 0, None) * np.clip(iy1 - iy0, 0, None)
        order = order[1:][inter / (area[i] + area[order[1:]] - inter) <= iou]
    return keep


if __name__ == "__main__":
    main()
