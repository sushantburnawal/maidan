from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Mapping, Sequence
from contextlib import suppress
from dataclasses import dataclass
from datetime import UTC, datetime
from secrets import token_urlsafe
from typing import Protocol, cast

from maidan_ai.activity_embeddings import ActivityEmbeddingService
from maidan_ai.domain_events import DomainEvent, JsonObject, JsonValue

logger = logging.getLogger(__name__)

SUPPORTED_EMBEDDING_EVENTS = {"activity.published", "activity.updated"}


@dataclass(frozen=True)
class BullMqQueueConfig:
    queue_name: str = "maidan.embeddings"
    prefix: str = "maidan"
    block_timeout_seconds: int = 5
    lock_duration_ms: int = 300_000


@dataclass(frozen=True)
class BullMqJob:
    id: str
    name: str
    data: JsonObject
    opts: JsonObject


class BullMqRedisClient(Protocol):
    async def execute_command(self, *args: object, **options: object) -> object:
        pass


class ActivityEmbeddingQueueProcessor:
    def __init__(self, service: ActivityEmbeddingService) -> None:
        self._service = service

    async def process(self, job: BullMqJob) -> JsonObject:
        event = domain_event_from_job(job)
        if event["event_type"] not in SUPPORTED_EMBEDDING_EVENTS:
            return {
                "handler": "embedding_queue",
                "status": "ignored",
                "event_type": event["event_type"],
            }

        activity_id = event["payload"].get("activity_id")
        if not isinstance(activity_id, str) or not activity_id:
            raise ValueError("Embedding job payload is missing activity_id")

        result = await self._service.embed_activity(activity_id)
        return {
            "handler": "embedding_queue",
            "event_type": event["event_type"],
            **result.to_json(),
        }


class BullMqEmbeddingsConsumer:
    def __init__(
        self,
        redis: BullMqRedisClient,
        processor: ActivityEmbeddingQueueProcessor,
        config: BullMqQueueConfig,
    ) -> None:
        self._redis = redis
        self._processor = processor
        self._config = config
        self._queue_key = f"{config.prefix}:{config.queue_name}"
        self._running = False
        self._task: asyncio.Task[None] | None = None

    @property
    def running(self) -> bool:
        return self._running

    async def start(self) -> None:
        self._running = True
        self._task = asyncio.create_task(
            self.run_forever(),
            name="maidan-ai-embeddings-queue-consumer",
        )

    async def stop(self) -> None:
        self._running = False
        task = self._task
        if task is None:
            return
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task

    async def run_forever(self) -> None:
        while self._running:
            try:
                await self.process_once()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("embedding_queue_consumer_loop_error")
                await asyncio.sleep(1.0)

    async def process_once(self) -> int:
        job_id = await self._move_next_job_to_active()
        if job_id is None:
            return 0
        if job_id.startswith("0:"):
            await self._remove_active(job_id)
            return 0

        try:
            job = await self._load_job(job_id)
            if job is None:
                await self._remove_active(job_id)
                logger.warning("embedding_queue_job_missing job_id=%s", job_id)
                return 1

            result = await self._processor.process(job)
            await self._mark_completed(job_id, result)
            logger.info("embedding_queue_job_completed job_id=%s name=%s", job.id, job.name)
        except Exception as error:
            await self._mark_failed_or_retry(job_id, error)
            logger.exception("embedding_queue_job_failed job_id=%s", job_id)

        return 1

    async def _move_next_job_to_active(self) -> str | None:
        result = await self._redis.execute_command(
            "BRPOPLPUSH",
            self._key("wait"),
            self._key("active"),
            self._config.block_timeout_seconds,
        )
        if result is None:
            return None

        job_id = redis_text(result)
        job_key = self._job_key(job_id)
        lock_token = token_urlsafe(16)
        processed_on = str(now_ms())
        await self._redis.execute_command(
            "SET",
            f"{job_key}:lock",
            lock_token,
            "PX",
            self._config.lock_duration_ms,
        )
        await self._redis.execute_command("HSET", job_key, "processedOn", processed_on)
        await self._redis.execute_command("HINCRBY", job_key, "ats", 1)
        await self._redis.execute_command(
            "XADD",
            self._key("events"),
            "*",
            "event",
            "active",
            "jobId",
            job_id,
            "prev",
            "waiting",
        )
        return job_id

    async def _load_job(self, job_id: str) -> BullMqJob | None:
        raw_hash = await self._redis.execute_command("HGETALL", self._job_key(job_id))
        values = redis_hash_to_map(raw_hash)
        if not values:
            return None

        data = json_object(values.get("data"), "data")
        opts = json_object(values.get("opts"), "opts")
        name = values.get("name")
        if name is None:
            raise ValueError(f"BullMQ job {job_id} is missing name")

        return BullMqJob(id=job_id, name=name, data=data, opts=opts)

    async def _mark_completed(self, job_id: str, result: JsonObject) -> None:
        finished_on = str(now_ms())
        returnvalue = json.dumps(result)
        await self._remove_active(job_id)
        await self._redis.execute_command(
            "HSET",
            self._job_key(job_id),
            "returnvalue",
            returnvalue,
            "finishedOn",
            finished_on,
        )
        await self._redis.execute_command("ZADD", self._key("completed"), finished_on, job_id)
        await self._redis.execute_command(
            "XADD",
            self._key("events"),
            "*",
            "event",
            "completed",
            "jobId",
            job_id,
            "returnvalue",
            returnvalue,
            "prev",
            "active",
        )
        await self._redis.execute_command("DEL", f"{self._job_key(job_id)}:lock")

    async def _mark_failed_or_retry(self, job_id: str, error: Exception) -> None:
        job_key = self._job_key(job_id)
        raw_hash = await self._redis.execute_command("HGETALL", job_key)
        values = redis_hash_to_map(raw_hash)
        opts = json_object(values.get("opts"), "opts") if values else {}
        attempts = json_int(opts.get("attempts"), fallback=1)
        attempts_made = await self._redis.execute_command("HINCRBY", job_key, "atm", 1)
        attempts_made_int = json_int(redis_text(attempts_made), fallback=1)

        await self._remove_active(job_id)
        await self._redis.execute_command("DEL", f"{job_key}:lock")

        if attempts_made_int < attempts:
            await self._redis.execute_command("LPUSH", self._key("wait"), job_id)
            await self._redis.execute_command(
                "XADD",
                self._key("events"),
                "*",
                "event",
                "waiting",
                "jobId",
                job_id,
                "prev",
                "active",
            )
            return

        finished_on = str(now_ms())
        error_message = f"{type(error).__name__}: {error}"
        await self._redis.execute_command(
            "HSET",
            job_key,
            "failedReason",
            error_message,
            "finishedOn",
            finished_on,
        )
        await self._redis.execute_command("ZADD", self._key("failed"), finished_on, job_id)
        await self._redis.execute_command(
            "XADD",
            self._key("events"),
            "*",
            "event",
            "failed",
            "jobId",
            job_id,
            "failedReason",
            error_message,
            "prev",
            "active",
        )

    async def _remove_active(self, job_id: str) -> None:
        await self._redis.execute_command("LREM", self._key("active"), 1, job_id)

    def _key(self, suffix: str) -> str:
        return f"{self._queue_key}:{suffix}"

    def _job_key(self, job_id: str) -> str:
        return f"{self._queue_key}:{job_id}"


def domain_event_from_job(job: BullMqJob) -> DomainEvent:
    data = job.data
    payload = data.get("payload")
    if not isinstance(payload, dict):
        raise ValueError(f"Embedding job {job.id} payload must be an object")

    event_id = data.get("id")
    if not isinstance(event_id, int) or isinstance(event_id, bool):
        raise ValueError(f"Embedding job {job.id} id must be an integer")

    return {
        "id": event_id,
        "aggregate_type": required_text(data, "aggregate_type"),
        "aggregate_id": required_text(data, "aggregate_id"),
        "event_type": required_text(data, "event_type"),
        "payload": payload,
        "created_at": required_text(data, "created_at"),
    }


def required_text(data: Mapping[str, JsonValue], key: str) -> str:
    value = data.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError(f"Embedding job data is missing {key}")
    return value


def redis_hash_to_map(value: object) -> dict[str, str]:
    if isinstance(value, Mapping):
        return {redis_text(key): redis_text(item) for key, item in value.items()}

    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        mapped: dict[str, str] = {}
        for index in range(0, len(value), 2):
            if index + 1 >= len(value):
                break
            mapped[redis_text(value[index])] = redis_text(value[index + 1])
        return mapped

    return {}


def json_object(value: str | None, field_name: str) -> JsonObject:
    if value is None:
        return {}

    loaded = json.loads(value)
    if not isinstance(loaded, dict):
        raise ValueError(f"BullMQ job {field_name} must be a JSON object")
    return cast(JsonObject, loaded)


def json_int(value: JsonValue | str | None, fallback: int) -> int:
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return fallback
    return fallback


def redis_text(value: object) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8")
    return str(value)


def now_ms() -> int:
    return int(datetime.now(UTC).timestamp() * 1000)
