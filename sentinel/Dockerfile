# Backend: one static Go binary.
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
# The Supervisor passes the add-on version.
ARG BUILD_VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=${BUILD_VERSION}" -o /sentinel .

FROM alpine:3.24

# Supervisor passes the target architecture (aarch64 / amd64).
ARG BUILD_ARCH=aarch64

# python3 + onnxruntime: the object detector (a separate, low-priority worker process).
RUN apk add --no-cache ffmpeg tzdata ca-certificates python3 py3-numpy py3-onnxruntime

# go2rtc (live view only; recording never depends on it), pinned by checksum.
RUN set -eux; \
    case "${BUILD_ARCH}" in \
      aarch64) arch=arm64; sha=359fabade8a7a51e81a55fe6df6b0ef81764a5e1d63179577534eaaa71904b50 ;; \
      amd64)   arch=amd64; sha=32d616af226bd731678ffde328b94cfb94e30339bfefc469cfb76323144615a6 ;; \
      *) echo "unsupported arch ${BUILD_ARCH}"; exit 1 ;; \
    esac; \
    wget -qO /usr/local/bin/go2rtc "https://github.com/AlexxIT/go2rtc/releases/download/v1.9.14/go2rtc_linux_${arch}"; \
    echo "${sha}  /usr/local/bin/go2rtc" | sha256sum -c -; \
    chmod +x /usr/local/bin/go2rtc

# YOLOX-s (scan) and YOLOX-m (verify), Apache-2.0, pinned by checksum.
RUN set -eux; mkdir -p /app/detect; \
    base=https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0; \
    wget -qO /app/detect/yolox_s.onnx "$base/yolox_s.onnx"; \
    wget -qO /app/detect/yolox_m.onnx "$base/yolox_m.onnx"; \
    echo "c5c2d13e59ae883e6af3b45daea64af4833a4951c92d116ec270d9ddbe998063  /app/detect/yolox_s.onnx" | sha256sum -c -; \
    echo "21ff6cfdeb53b013bac2249599e55f00bff3cfdfdab37ed7a4620818c1d15b3f  /app/detect/yolox_m.onnx" | sha256sum -c -
# Faces: YuNet finds them (OpenCV Zoo, MIT) and InsightFace's MobileFaceNet (w600k_mbf,
# from buffalo_s; non-commercial use, which a home system is) fingerprints them.
RUN set -eux;     wget -qO /app/detect/yunet.onnx "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx";     echo "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4  /app/detect/yunet.onnx" | sha256sum -c -;     wget -qO /tmp/buffalo_s.zip "https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_s.zip";     echo "d85a87f503f691807cd8bb97128bdf7a0660326cd9cd02657127fa978bab8b5e  /tmp/buffalo_s.zip" | sha256sum -c -;     unzip -p /tmp/buffalo_s.zip w600k_mbf.onnx > /app/detect/w600k_mbf.onnx;     rm /tmp/buffalo_s.zip;     echo "9cc6e4a75f0e2bf0b1aed94578f144d15175f357bdc05e815e5c4a02b319eb4f  /app/detect/w600k_mbf.onnx" | sha256sum -c -
COPY detect/detect.py /app/detect/

COPY --from=build /sentinel /usr/local/bin/sentinel
# Prebuilt UI (source in frontend/, built with `npm run build`).
COPY www/ /app/www/

CMD ["/usr/local/bin/sentinel"]
