import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import cast

from fastapi import FastAPI
from redis import asyncio as redis

from maidan_ai.anthropic_client import AnthropicClient
from maidan_ai.config import Settings
from maidan_ai.db import create_db_pool
from maidan_ai.domain_events import DomainEventValidator
from maidan_ai.event_bus import EventConsumerConfig, RedisDomainEventConsumer, RedisStreamClient
from maidan_ai.handlers import build_default_handlers
from maidan_ai.jobs import AiJobRepository


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = Settings()
    app.state.settings = settings
    app.state.anthropic = AnthropicClient(settings)

    if settings.ai_consumer_disabled:
        yield
        return

    pool = await create_db_pool(settings)
    redis_client = cast(
        redis.Redis,
        redis.from_url(settings.redis_url, decode_responses=True),  # type: ignore[no-untyped-call]
    )
    validator = DomainEventValidator.from_schema_path(settings.events_schema_path)
    consumer = RedisDomainEventConsumer(
        redis=cast(RedisStreamClient, redis_client),
        jobs=AiJobRepository(pool),
        validator=validator,
        handlers=build_default_handlers(),
        config=EventConsumerConfig(
            stream_name=settings.stream_domain_events,
            group_name=settings.ai_consumer_group,
            consumer_name=settings.ai_consumer_name,
            stream_start_id=settings.ai_stream_start_id,
            batch_size=settings.ai_consumer_batch_size,
            block_ms=settings.ai_consumer_block_ms,
            max_attempts=settings.ai_event_max_attempts,
            retry_delay_seconds=settings.ai_event_retry_delay_seconds,
            dead_letter_stream=settings.ai_dead_letter_stream,
        ),
    )
    await consumer.start()
    app.state.db_pool = pool
    app.state.redis = redis_client
    app.state.event_consumer = consumer

    try:
        yield
    finally:
        await consumer.stop()
        await redis_client.aclose()
        await pool.close()


def create_app() -> FastAPI:
    app = FastAPI(title="Maidan AI", version="0.0.0", lifespan=lifespan)

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {
            "status": "ok",
            "service": "ai",
            "commit": os.getenv("COMMIT_SHA", os.getenv("RAILWAY_GIT_COMMIT_SHA", "unknown")),
        }

    return app


app = create_app()
