FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV UV_COMPILE_BYTECODE=1
ENV UV_LINK_MODE=copy
ENV PYTHONPATH="/app/apps/ai/src"

WORKDIR /app

COPY apps/ai/pyproject.toml apps/ai/uv.lock apps/ai/
COPY packages/shared/contracts/events.schema.json packages/shared/contracts/events.schema.json

WORKDIR /app/apps/ai
RUN uv sync --locked --no-dev

WORKDIR /app
COPY apps/ai apps/ai

WORKDIR /app/apps/ai
ENV PATH="/app/apps/ai/.venv/bin:$PATH"

EXPOSE 8000

CMD ["uvicorn", "maidan_ai.main:app", "--host", "0.0.0.0", "--port", "8000"]
