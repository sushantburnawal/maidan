import os

from fastapi import FastAPI

app = FastAPI(title="Maidan AI", version="0.0.0")


@app.get("/health")
async def health() -> dict[str, str]:
    return {
        "status": "ok",
        "service": "ai",
        "commit": os.getenv("COMMIT_SHA", os.getenv("RAILWAY_GIT_COMMIT_SHA", "unknown")),
    }
