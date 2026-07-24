# Build the frontend, then serve it from the API so everything is one origin.
FROM node:20-alpine AS frontend
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/ ./backend/
COPY --from=frontend /build/dist ./frontend/dist

ENV FRONTEND_DIST=/app/frontend/dist \
    PYTHONUNBUFFERED=1

EXPOSE 8000
# cwd must be backend/: main.py imports its siblings flat (`from models import`).
# Shell form on purpose, so hosts that inject $PORT (Render, Cloud Run) work.
# `exec` hands uvicorn PID 1 so it actually receives SIGTERM and shuts down
# gracefully, instead of sitting behind sh until the platform force-kills it.
WORKDIR /app/backend
CMD exec uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}
