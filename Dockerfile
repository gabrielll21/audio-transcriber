FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    AUDIO_TRANSCRIBER_HOST=0.0.0.0 \
    AUDIO_TRANSCRIBER_PORT=8000

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./

RUN pip install --upgrade pip \
    && pip install -r requirements.txt

COPY backend ./backend

RUN mkdir -p /app/backend/temp/uploads /app/backend/temp/processed

EXPOSE 8000

CMD ["python3", "-m", "backend.app"]
