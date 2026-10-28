FROM python:3.12-alpine

RUN apk add --no-cache tzdata

WORKDIR /app
COPY app/ ./

ENV PYTHONUNBUFFERED=1
CMD ["python3", "/app/main.py"]
