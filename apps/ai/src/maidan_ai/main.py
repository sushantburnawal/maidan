import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import cast

from fastapi import FastAPI
from redis import asyncio as redis

from maidan_ai.activity_embeddings import ActivityEmbeddingRepository, ActivityEmbeddingService
from maidan_ai.anthropic_client import AnthropicClient
from maidan_ai.config import Settings
from maidan_ai.db import create_db_pool
from maidan_ai.domain_events import DomainEventValidator
from maidan_ai.embedding_queue import (
    ActivityEmbeddingQueueProcessor,
    BullMqEmbeddingsConsumer,
    BullMqQueueConfig,
    BullMqRedisClient,
)
from maidan_ai.embeddings import SentenceTransformerEmbedder
from maidan_ai.event_bus import EventConsumerConfig, RedisDomainEventConsumer, RedisStreamClient
from maidan_ai.handlers import build_default_handlers
from maidan_ai.jobs import AiJobRepository
from maidan_ai.moderation import (
    BullMqModerationConsumer,
    ModerationQueueConfig,
    ModerationQueueProcessor,
    ModerationRepository,
    ModerationService,
)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = Settings()
    app.state.settings = settings
    anthropic = AnthropicClient(settings)
    app.state.anthropic = anthropic

    if (
        settings.ai_consumer_disabled
        and settings.embeddings_worker_disabled
        and settings.moderation_worker_disabled
    ):
        yield
        return

    pool = await create_db_pool(settings)
    redis_client = cast(
        redis.Redis,
        redis.from_url(settings.redis_url, decode_responses=True),  # type: ignore[no-untyped-call]
    )
    activity_embedding_service: ActivityEmbeddingService | None = None
    if not settings.ai_consumer_disabled or not settings.embeddings_worker_disabled:
        embedder = SentenceTransformerEmbedder(
            settings.embeddings_model,
            dimensions=settings.embeddings_dimensions,
            device=settings.embeddings_device or None,
        )
        activity_embedding_service = ActivityEmbeddingService(
            ActivityEmbeddingRepository(pool, dimensions=settings.embeddings_dimensions),
            embedder,
        )
    consumer: RedisDomainEventConsumer | None = None
    embeddings_queue_consumer: BullMqEmbeddingsConsumer | None = None
    moderation_queue_consumer: BullMqModerationConsumer | None = None

    if not settings.ai_consumer_disabled:
        validator = DomainEventValidator.from_schema_path(settings.events_schema_path)
        consumer = RedisDomainEventConsumer(
            redis=cast(RedisStreamClient, redis_client),
            jobs=AiJobRepository(pool),
            validator=validator,
            handlers=build_default_handlers(activity_embedding_service),
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

    if not settings.embeddings_worker_disabled:
        if activity_embedding_service is None:
            raise RuntimeError("Activity embedding service was not initialized")
        embeddings_queue_consumer = BullMqEmbeddingsConsumer(
            redis=cast(BullMqRedisClient, redis_client),
            processor=ActivityEmbeddingQueueProcessor(activity_embedding_service),
            config=BullMqQueueConfig(
                queue_name=settings.queue_embeddings,
                prefix=settings.bullmq_prefix,
                block_timeout_seconds=settings.embeddings_queue_block_seconds,
            ),
        )
        await embeddings_queue_consumer.start()

    if not settings.moderation_worker_disabled:
        moderation_queue_consumer = BullMqModerationConsumer(
            redis=cast(BullMqRedisClient, redis_client),
            processor=ModerationQueueProcessor(
                ModerationRepository(pool),
                ModerationService(anthropic),
            ),
            config=ModerationQueueConfig(
                queue_name=settings.queue_moderation,
                prefix=settings.bullmq_prefix,
                block_timeout_seconds=settings.moderation_queue_block_seconds,
                batch_size=settings.moderation_batch_size,
                batch_window_seconds=settings.moderation_batch_window_seconds,
            ),
        )
        await moderation_queue_consumer.start()

    app.state.db_pool = pool
    app.state.redis = redis_client
    if activity_embedding_service is not None:
        app.state.activity_embedding_service = activity_embedding_service
    if consumer is not None:
        app.state.event_consumer = consumer
    if embeddings_queue_consumer is not None:
        app.state.embeddings_queue_consumer = embeddings_queue_consumer
    if moderation_queue_consumer is not None:
        app.state.moderation_queue_consumer = moderation_queue_consumer

    try:
        yield
    finally:
        if moderation_queue_consumer is not None:
            await moderation_queue_consumer.stop()
        if embeddings_queue_consumer is not None:
            await embeddings_queue_consumer.stop()
        if consumer is not None:
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
