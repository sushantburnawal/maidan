import asyncio
import logging
import os
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import cast
from uuid import uuid4

from fastapi import FastAPI, Header, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from redis import asyncio as redis

from maidan_ai.activity_embeddings import ActivityEmbeddingRepository, ActivityEmbeddingService
from maidan_ai.anthropic_metrics import ClaudeUsageMetrics, pricing_from_settings
from maidan_ai.config import Settings
from maidan_ai.db import DbPool, create_db_pool
from maidan_ai.demand_sensing import (
    DemandSensingRepository,
    DemandSensingRunner,
    DemandSensingScheduler,
    DemandSensingService,
    config_from_settings,
    scheduler_config_from_settings,
)
from maidan_ai.domain_events import DomainEventValidator, JsonObject, JsonValue
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
from maidan_ai.llm_provider import LLMProvider, build_llm_provider, selected_provider_name
from maidan_ai.matchmaking import (
    MatchmakingRepository,
    MatchmakingRunner,
    MatchmakingScheduler,
    MatchmakingSchedulerConfig,
    MatchmakingService,
)
from maidan_ai.moderation import (
    BullMqModerationConsumer,
    ModerationQueueConfig,
    ModerationQueueProcessor,
    ModerationRepository,
    ModerationService,
)
from maidan_ai.observability import (
    configure_json_logging,
    normalize_header_id,
    request_context,
)
from maidan_ai.sutradhar import (
    SutradharChatRequest,
    SutradharMemory,
    SutradharRedis,
    SutradharRepository,
    SutradharService,
)

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = Settings()
    app.state.settings = settings
    llm_provider = build_llm_provider(settings)
    app.state.llm_provider = llm_provider

    if (
        settings.ai_consumer_disabled
        and settings.embeddings_worker_disabled
        and settings.moderation_worker_disabled
        and settings.demand_sensing_worker_disabled
        and settings.matchmaker_worker_disabled
        and settings.sutradhar_disabled
    ):
        yield
        return

    pool = await create_db_pool(settings)
    redis_client = cast(
        redis.Redis,
        redis.from_url(settings.redis_url, decode_responses=True),  # type: ignore[no-untyped-call]
    )
    activity_embedding_service: ActivityEmbeddingService | None = None
    embedder: SentenceTransformerEmbedder | None = None
    if (
        not settings.ai_consumer_disabled
        or not settings.embeddings_worker_disabled
        or not settings.sutradhar_disabled
    ):
        embedder = SentenceTransformerEmbedder(
            settings.embeddings_model,
            dimensions=settings.embeddings_dimensions,
            device=settings.embeddings_device or None,
        )
    if not settings.ai_consumer_disabled or not settings.embeddings_worker_disabled:
        if embedder is None:
            raise RuntimeError("Embedding model was not initialized")
        activity_embedding_service = ActivityEmbeddingService(
            ActivityEmbeddingRepository(pool, dimensions=settings.embeddings_dimensions),
            embedder,
        )
    consumer: RedisDomainEventConsumer | None = None
    embeddings_queue_consumer: BullMqEmbeddingsConsumer | None = None
    moderation_queue_consumer: BullMqModerationConsumer | None = None
    demand_sensing_scheduler: DemandSensingScheduler | None = None
    matchmaking_repository: MatchmakingRepository | None = None
    matchmaking_service: MatchmakingService | None = None
    matchmaking_runner: MatchmakingRunner | None = None
    matchmaking_scheduler: MatchmakingScheduler | None = None

    if not settings.matchmaker_worker_disabled:
        matchmaking_repository = MatchmakingRepository(pool)
        matchmaking_service = MatchmakingService(matchmaking_repository)

    if not settings.ai_consumer_disabled:
        validator = DomainEventValidator.from_schema_path(settings.events_schema_path)
        consumer = RedisDomainEventConsumer(
            redis=cast(RedisStreamClient, redis_client),
            jobs=AiJobRepository(pool),
            validator=validator,
            handlers=build_default_handlers(activity_embedding_service, matchmaking_service),
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
                ModerationService(llm_provider),
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

    demand_sensing_runner = DemandSensingRunner(
        DemandSensingRepository(pool),
        DemandSensingService(llm_provider),
        config_from_settings(settings),
    )
    if not settings.demand_sensing_worker_disabled:
        demand_sensing_scheduler = DemandSensingScheduler(
            demand_sensing_runner,
            scheduler_config_from_settings(settings),
        )
        await demand_sensing_scheduler.start()

    if matchmaking_service is not None:
        if matchmaking_repository is None:
            raise RuntimeError("Matchmaking repository was not initialized")
        matchmaking_runner = MatchmakingRunner(
            matchmaking_repository,
            matchmaking_service,
            batch_size=settings.matchmaker_batch_size,
        )
        matchmaking_scheduler = MatchmakingScheduler(
            matchmaking_runner,
            MatchmakingSchedulerConfig(
                initial_delay_seconds=settings.matchmaker_initial_delay_seconds,
                interval_seconds=settings.matchmaker_interval_seconds,
            ),
        )
        await matchmaking_scheduler.start()

    if not settings.sutradhar_disabled:
        app.state.sutradhar_service = SutradharService(
            client=llm_provider,
            repository=SutradharRepository(
                pool,
                embedder=embedder,
                embedding_dimensions=settings.embeddings_dimensions,
            ),
            memory=SutradharMemory(
                cast(SutradharRedis, redis_client),
                ttl_seconds=settings.sutradhar_memory_ttl_seconds,
                max_messages=settings.sutradhar_max_memory_messages,
            ),
        )

    app.state.db_pool = pool
    app.state.redis = redis_client
    app.state.demand_sensing_runner = demand_sensing_runner
    if matchmaking_service is not None:
        app.state.matchmaking_service = matchmaking_service
    if matchmaking_runner is not None:
        app.state.matchmaking_runner = matchmaking_runner
    if activity_embedding_service is not None:
        app.state.activity_embedding_service = activity_embedding_service
    if consumer is not None:
        app.state.event_consumer = consumer
    if embeddings_queue_consumer is not None:
        app.state.embeddings_queue_consumer = embeddings_queue_consumer
    if moderation_queue_consumer is not None:
        app.state.moderation_queue_consumer = moderation_queue_consumer
    if demand_sensing_scheduler is not None:
        app.state.demand_sensing_scheduler = demand_sensing_scheduler
    if matchmaking_scheduler is not None:
        app.state.matchmaking_scheduler = matchmaking_scheduler

    try:
        yield
    finally:
        if matchmaking_scheduler is not None:
            await matchmaking_scheduler.stop()
        if demand_sensing_scheduler is not None:
            await demand_sensing_scheduler.stop()
        if moderation_queue_consumer is not None:
            await moderation_queue_consumer.stop()
        if embeddings_queue_consumer is not None:
            await embeddings_queue_consumer.stop()
        if consumer is not None:
            await consumer.stop()
        await redis_client.aclose()
        await pool.close()


def create_app() -> FastAPI:
    configure_json_logging()
    app = FastAPI(title="Maidan AI", version="0.0.0", lifespan=lifespan)

    @app.middleware("http")
    async def request_observability(
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        request_id = normalize_header_id(request.headers.get("x-request-id")) or str(uuid4())
        correlation_id = (
            normalize_header_id(request.headers.get("x-correlation-id")) or request_id
        )
        started_at = time.monotonic()

        with request_context(request_id=request_id, correlation_id=correlation_id):
            try:
                response = await call_next(request)
            except Exception:
                logger.exception(
                    "http_request_failed",
                    extra={
                        "method": request.method,
                        "path": request.url.path,
                        "duration_ms": round((time.monotonic() - started_at) * 1000),
                    },
                )
                raise

            response.headers["x-request-id"] = request_id
            response.headers["x-correlation-id"] = correlation_id
            logger.info(
                "http_request_completed",
                extra={
                    "method": request.method,
                    "path": request.url.path,
                    "status_code": response.status_code,
                    "duration_ms": round((time.monotonic() - started_at) * 1000),
                },
            )
            return response

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {
            "status": "ok",
            "service": "ai",
            "commit": os.getenv("COMMIT_SHA", os.getenv("RAILWAY_GIT_COMMIT_SHA", "unknown")),
        }

    @app.get("/health/ready")
    async def ready(response: Response) -> JsonObject:
        report = await readiness_report(app)
        if report["status"] != "ok":
            response.status_code = 503
        return report

    @app.get("/internal/metrics")
    async def internal_metrics() -> JsonObject:
        settings = settings_from_state(app)
        provider_state = getattr(app.state, "llm_provider", None)
        provider_metrics = getattr(provider_state, "metrics", None)
        metrics = (
            provider_metrics
            if isinstance(provider_metrics, ClaudeUsageMetrics)
            else ClaudeUsageMetrics(pricing_from_settings(settings))
        )
        return {
            "service": "ai",
            "provider": provider_name_for_response(settings),
            "generated_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            "claude": metrics.snapshot(),
        }

    @app.post("/internal/demand-sensing/run")
    async def run_demand_sensing() -> JsonObject:
        runner = getattr(app.state, "demand_sensing_runner", None)
        if not isinstance(runner, DemandSensingRunner):
            raise HTTPException(status_code=503, detail="Demand sensing is not initialized")

        return (await runner.run_once()).to_json()

    @app.get("/internal/activities/{activity_id}/vibe")
    async def activity_vibe(
        activity_id: str,
        authorization: str | None = Header(default=None),
    ) -> JsonObject:
        settings_state = getattr(app.state, "settings", None)
        settings = settings_state if isinstance(settings_state, Settings) else Settings()
        require_internal_token(settings, authorization)

        service = getattr(app.state, "matchmaking_service", None)
        if not isinstance(service, MatchmakingService):
            raise HTTPException(status_code=503, detail="Matchmaking is not initialized")

        vibe = await service.activity_vibe(activity_id)
        if vibe is None:
            raise HTTPException(status_code=404, detail="Activity not found")

        return vibe.to_json()

    @app.post("/sutradhar/chat")
    async def sutradhar_chat(
        payload: SutradharChatRequest,
        authorization: str | None = Header(default=None),
    ) -> StreamingResponse:
        settings_state = getattr(app.state, "settings", None)
        settings = settings_state if isinstance(settings_state, Settings) else Settings()
        require_internal_token(settings, authorization)

        service = getattr(app.state, "sutradhar_service", None)
        if not isinstance(service, SutradharService):
            raise HTTPException(status_code=503, detail="Sutradhar is not initialized")

        return StreamingResponse(
            service.stream_chat(payload),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache"},
        )

    return app


app = create_app()


def require_internal_token(settings: Settings, authorization: str | None) -> None:
    expected = configured_internal_token(settings)
    token = bearer_token(authorization)
    if token != expected:
        raise HTTPException(status_code=401, detail="Invalid internal token")


def configured_internal_token(settings: Settings) -> str:
    secret = settings.ai_internal_token
    value = "" if secret is None else secret.get_secret_value()
    if value == "" or value == "replace-me":
        raise HTTPException(status_code=503, detail="AI_INTERNAL_TOKEN is not configured")
    return value


def bearer_token(authorization: str | None) -> str:
    if authorization is None:
        raise HTTPException(status_code=401, detail="Missing internal token")

    scheme, _, token = authorization.partition(" ")
    if scheme != "Bearer" or token == "":
        raise HTTPException(status_code=401, detail="Invalid internal token")
    return token


def settings_from_state(app: FastAPI) -> Settings:
    settings_state = getattr(app.state, "settings", None)
    return settings_state if isinstance(settings_state, Settings) else Settings()


def provider_name_for_response(settings: Settings) -> str:
    try:
        return selected_provider_name(settings)
    except Exception:
        return settings.ai_provider


async def readiness_report(app: FastAPI) -> JsonObject:
    settings = settings_from_state(app)
    llm_check = await dependency_check(lambda: check_llm_provider(app, settings))
    llm_check["provider"] = provider_name_for_response(settings)
    checks: JsonObject = {
        "db": await dependency_check(lambda: check_db(app, settings)),
        "redis": await dependency_check(lambda: check_redis(app, settings)),
        "llm": llm_check,
    }
    status = "ok" if all(is_ok_check(check) for check in checks.values()) else "unhealthy"
    return {
        "status": status,
        "service": "ai",
        "checks": checks,
    }


async def dependency_check(check: Callable[[], Awaitable[None]]) -> JsonObject:
    started_at = time.monotonic()
    try:
        await asyncio.wait_for(check(), timeout=5.0)
        return {
            "status": "ok",
            "latency_ms": round((time.monotonic() - started_at) * 1000),
        }
    except Exception as error:
        return {
            "status": "unhealthy",
            "latency_ms": round((time.monotonic() - started_at) * 1000),
            "detail": str(error),
        }


def is_ok_check(value: JsonValue) -> bool:
    return isinstance(value, dict) and value.get("status") == "ok"


async def check_db(app: FastAPI, settings: Settings) -> None:
    pool_state = getattr(app.state, "db_pool", None)
    if pool_state is not None:
        await cast(DbPool, pool_state).execute("select 1")
        return

    pool = await create_db_pool(settings)
    try:
        await pool.execute("select 1")
    finally:
        await pool.close()


async def check_redis(app: FastAPI, settings: Settings) -> None:
    redis_state = getattr(app.state, "redis", None)
    if redis_state is not None:
        await cast(redis.Redis, redis_state).ping()
        return

    redis_client = cast(
        redis.Redis,
        redis.from_url(settings.redis_url, decode_responses=True),  # type: ignore[no-untyped-call]
    )
    try:
        await redis_client.ping()
    finally:
        await redis_client.aclose()


async def check_llm_provider(app: FastAPI, settings: Settings) -> None:
    provider_state = getattr(app.state, "llm_provider", None)
    provider = (
        cast(LLMProvider, provider_state)
        if provider_state is not None
        else build_llm_provider(settings)
    )
    await provider.check_reachability()
