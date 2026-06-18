from __future__ import annotations

import argparse
import asyncio
import json

from maidan_ai.activity_embeddings import ActivityEmbeddingRepository, ActivityEmbeddingService
from maidan_ai.config import Settings
from maidan_ai.db import create_db_pool
from maidan_ai.embeddings import SentenceTransformerEmbedder


async def run_backfill(batch_size: int | None = None) -> int:
    settings = Settings()
    embedder = SentenceTransformerEmbedder(
        settings.embeddings_model,
        dimensions=settings.embeddings_dimensions,
        device=settings.embeddings_device or None,
    )
    pool = await create_db_pool(settings)
    try:
        service = ActivityEmbeddingService(
            ActivityEmbeddingRepository(pool, dimensions=settings.embeddings_dimensions),
            embedder,
        )
        result = await service.backfill_missing(batch_size or settings.embeddings_batch_size)
    finally:
        await pool.close()

    print(json.dumps(result.to_json(), sort_keys=True))
    return result.embedded_count


def main() -> None:
    parser = argparse.ArgumentParser(description="Backfill missing activity embeddings.")
    parser.add_argument("--batch-size", type=int, default=None)
    args = parser.parse_args()
    asyncio.run(run_backfill(batch_size=args.batch_size))


if __name__ == "__main__":
    main()
