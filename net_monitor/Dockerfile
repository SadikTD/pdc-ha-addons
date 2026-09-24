FROM python:3.12-alpine

# Supervisor passes the target architecture (aarch64 / amd64).
ARG BUILD_ARCH=aarch64

RUN apk add --no-cache tzdata

# Official Ookla Speedtest CLI, pinned by checksum.
RUN set -eux; \
    case "${BUILD_ARCH}" in \
      aarch64) arch=aarch64; sha=3953d231da3783e2bf8904b6dd72767c5c6e533e163d3742fd0437affa431bd3 ;; \
      amd64)   arch=x86_64;  sha=5690596c54ff9bed63fa3732f818a05dbc2db19ad36ed68f21ca5f64d5cfeeb7 ;; \
      *) echo "unsupported arch ${BUILD_ARCH}"; exit 1 ;; \
    esac; \
    wget -qO /tmp/speedtest.tgz "https://install.speedtest.net/app/cli/ookla-speedtest-1.2.0-linux-${arch}.tgz"; \
    echo "${sha}  /tmp/speedtest.tgz" | sha256sum -c -; \
    tar -xzf /tmp/speedtest.tgz -C /usr/local/bin speedtest; \
    rm /tmp/speedtest.tgz; \
    speedtest --version

WORKDIR /app
COPY app/ ./

# Ookla stores its licence acceptance under $HOME; keep it in persistent /data.
ENV HOME=/data PYTHONUNBUFFERED=1
CMD ["python3", "/app/main.py"]
