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

Faces (model "faces"): YuNet (MIT) finds faces and their five landmarks; each face is
aligned to 112x112 and turned into a 512-number fingerprint by InsightFace's
MobileFaceNet (w600k_mbf; its weights are for non-commercial use, which a home system
is). The answer per face: [score, x, y, w, h, landmarks (10), sharpness, frontal,
fingerprint (512)], positions normalised to the picture.
"""

import json
import os
import sys

import numpy as np
import onnxruntime as ort

MODEL = os.environ.get("SENTINEL_DETECT_MODEL", "/app/detect/yolox_s.onnx")
VERIFY_MODEL = os.environ.get("SENTINEL_VERIFY_MODEL", "/app/detect/yolox_m.onnx")
FACE_MODEL = os.environ.get("SENTINEL_FACE_MODEL", "/app/detect/yunet.onnx")
EMBED_MODEL = os.environ.get("SENTINEL_EMBED_MODEL", "/app/detect/w600k_mbf.onnx")
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


def session(path):
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = 2
    opts.inter_op_num_threads = 1
    return ort.InferenceSession(path, opts, providers=["CPUExecutionProvider"])


# Where the five landmarks go in a 112x112 face (the standard ArcFace layout).
TEMPLATE = np.array([[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]], np.float32)


class Faces:
    size = 640

    def __init__(self, det_path, emb_path):
        self.det = session(det_path)
        self.emb = session(emb_path)
        self.emb_in = self.emb.get_inputs()[0].name
        self.names = [o.name for o in self.det.get_outputs()]

    def detect(self, data, w, h):
        rgb = np.frombuffer(data, np.uint8).reshape(h, w, 3)
        img = np.zeros((640, 640, 3), np.float32)
        img[:h, :w] = rgb[:, :, ::-1]  # YuNet takes BGR, 0..255, top-left letterboxed
        outs = dict(zip(self.names, self.det.run(None, {"input": img.transpose(2, 0, 1)[None]})))
        boxes, scores, kps = [], [], []
        for st in (8, 16, 32):
            n = 640 // st
            sc = np.sqrt(np.clip(outs[f"cls_{st}"][0, :, 0], 0, 1) * np.clip(outs[f"obj_{st}"][0, :, 0], 0, 1))
            for i in np.where(sc > 0.5)[0]:
                r, c = divmod(int(i), n)
                b = outs[f"bbox_{st}"][0, i]
                cx, cy = (c + b[0]) * st, (r + b[1]) * st
                bw, bh = np.exp(b[2]) * st, np.exp(b[3]) * st
                boxes.append([cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2])
                scores.append(float(sc[i]))
                k = outs[f"kps_{st}"][0, i]
                kps.append([((k[2 * j] + c) * st, (k[2 * j + 1] + r) * st) for j in range(5)])
        if not boxes:
            return []
        boxes, scores = np.array(boxes, np.float32), np.array(scores, np.float32)
        wh = np.stack([(boxes[:, 0] + boxes[:, 2]) / 2, (boxes[:, 1] + boxes[:, 3]) / 2, boxes[:, 2] - boxes[:, 0], boxes[:, 3] - boxes[:, 1]], 1)
        found = []
        for i in nms(wh, scores, 0.3):
            k = np.array(kps[i], np.float32)
            face = align(rgb, k)
            x = ((face - 127.5) / 127.5).transpose(2, 0, 1)[None].astype(np.float32)
            v = self.emb.run(None, {self.emb_in: x})[0][0]
            v = v / (np.linalg.norm(v) + 1e-9)
            x0, y0, x1, y1 = boxes[i]
            x0, y0, x1, y1 = max(x0, 0), max(y0, 0), min(x1, w), min(y1, h)
            if x1 <= x0 or y1 <= y0:
                continue
            found.append([round(float(scores[i]), 3), round(float(x0 / w), 4), round(float(y0 / h), 4), round(float((x1 - x0) / w), 4), round(float((y1 - y0) / h), 4)]
                         + [round(float(v), 4) for v in (k / np.array([w, h], np.float32)).ravel()]
                         + [round(sharpness(face), 1), round(frontal(k), 3)]
                         + [round(float(x), 4) for x in v])
        return found


def align(rgb, kps, size=112):
    """The face turned and scaled so its landmarks sit on TEMPLATE (a similarity
    transform, Umeyama), sampled bilinearly."""
    n = kps.shape[0]
    mu_s, mu_d = kps.mean(0), TEMPLATE.mean(0)
    s0, d0 = kps - mu_s, TEMPLATE - mu_d
    u, sv, vt = np.linalg.svd(d0.T @ s0 / n)
    d = np.eye(2)
    if np.linalg.det(u) * np.linalg.det(vt) < 0:
        d[1, 1] = -1
    rot = u @ d @ vt
    scale = (sv * np.diag(d)).sum() / ((s0 ** 2).sum() / n)
    a = scale * rot
    t = mu_d - a @ mu_s
    ys, xs = np.mgrid[0:size, 0:size].astype(np.float32)
    src = np.linalg.inv(a) @ np.stack([xs.ravel() - t[0], ys.ravel() - t[1]])
    h, w = rgb.shape[:2]
    x, y = src[0], src[1]
    x0 = np.clip(np.floor(x).astype(int), 0, w - 2)
    y0 = np.clip(np.floor(y).astype(int), 0, h - 2)
    fx = np.clip(x - x0, 0, 1)[:, None]
    fy = np.clip(y - y0, 0, 1)[:, None]
    im = rgb.astype(np.float32)
    out = im[y0, x0] * (1 - fx) * (1 - fy) + im[y0, x0 + 1] * fx * (1 - fy) + im[y0 + 1, x0] * (1 - fx) * fy + im[y0 + 1, x0 + 1] * fx * fy
    return out.reshape(size, size, 3)


def sharpness(face):
    """Variance of the Laplacian: low = blurred (motion, focus) or flat."""
    g = face.mean(2)
    return float((g[1:-1, 1:-1] * 4 - g[:-2, 1:-1] - g[2:, 1:-1] - g[1:-1, :-2] - g[1:-1, 2:]).var())


def frontal(k):
    """1 = looking at the camera, 0 = side on (the nose far off the middle of the eyes)."""
    eye_d = float(np.linalg.norm(k[1] - k[0])) + 1e-6
    off = abs(float(k[2][0] - (k[0][0] + k[1][0]) / 2)) / eye_d
    return max(0.0, 1.0 - off * 2)


def main():
    ort.set_default_logger_severity(3)  # errors only
    models = {"scan": Model(MODEL)}
    if os.path.exists(VERIFY_MODEL):
        models["verify"] = Model(VERIFY_MODEL)
    if os.path.exists(FACE_MODEL) and os.path.exists(EMBED_MODEL):
        models["faces"] = Faces(FACE_MODEL, EMBED_MODEL)
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
