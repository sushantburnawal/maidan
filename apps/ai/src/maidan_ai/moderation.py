from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from collections.abc import Mapping, Sequence
from contextlib import suppress
from dataclasses import dataclass
from datetime import UTC, datetime
from secrets import token_urlsafe
from typing import Literal, Protocol, cast

from maidan_ai.db import DbPool
from maidan_ai.domain_events import DomainEvent, JsonObject, JsonValue
from maidan_ai.embedding_queue import (
    BullMqJob,
    BullMqRedisClient,
    json_object,
    now_ms,
    redis_hash_to_map,
    redis_text,
)
from maidan_ai.jobs import EventProcessingState, json_object_from_db
from maidan_ai.jobs import json_int as job_json_int

logger = logging.getLogger(__name__)

SUPPORTED_MODERATION_EVENTS = {"post.created", "message.created"}
MODERATION_DECISION_JOB_KIND = "moderation_decision"
MODERATION_QUEUE_JOB_KIND = "moderation_queue"

ModerationTargetType = Literal["post", "message"]

MODERATION_RUBRIC = "\n".join(
    [
        "You are Maidan's conservative safety moderator for a Bengaluru wellness and lifestyle "
        "marketplace.",
        "",
        "Classify user-generated posts and chat messages. Allow ordinary coordination, "
        "disagreement, questions, feedback, cancellations, logistics, and mild frustration. "
        "Disallow harassment, bullying, hate or identity attacks, sexual content, sexual content "
        "involving minors, threats, encouragement of self-harm, dangerous illegal activity, "
        "scams, spam, doxxing or private personal data, and unsafe medical or wellness "
        "instructions that could plausibly harm someone.",
        "",
        "Severity:",
        "0 = clearly safe.",
        "1 = borderline or low-risk policy concern, but still allow if no direct harm is likely.",
        "2 = disallowed content that should be blocked.",
        "3 = severe disallowed content: credible threat, targeted hate, sexual minors, "
        "self-harm instruction, doxxing, scam, or dangerous instruction. Severe items must be "
        "hidden and notify the author.",
        "",
        "Categories must be short lowercase strings from this set when relevant: harassment, "
        "hate, sexual, sexual_minors, violence, self_harm, illegal, spam, privacy, "
        "unsafe_wellness, other.",
        "",
        "Be conservative: if the content is ambiguous and could reasonably harm a user or "
        "community trust, set allow=false. Return only valid JSON. Do not wrap it in Markdown "
        "or add commentary.",
    ]
)


class CheapModerationClient(Protocol):
    async def cheap_call(
        self,
        prompt: str,
        *,
        system: str | None = None,
        max_tokens: int = 512,
    ) -> str:
        pass


class ModerationStore(Protocol):
    async def fetch_content(self, event: DomainEvent) -> ModerationContent | None:
        pass

    async def begin_decision(self, item: ModerationItem) -> EventProcessingState:
        pass

    async def apply_decision(
        self,
        item: ModerationItem,
        decision: ModerationDecision,
    ) -> JsonObject:
        pass

    async def mark_decision_failed(
        self,
        item: ModerationItem,
        error: str,
        attempts: int,
        *,
        dead_letter_entry_id: str | None = None,
    ) -> None:
        pass

    async def record_queue_failure(
        self,
        job: BullMqJob,
        error: str,
        action: BullMqFailureAction,
    ) -> None:
        pass


@dataclass(frozen=True)
class ModerationQueueConfig:
    queue_name: str = "maidan.moderation"
    prefix: str = "maidan"
    block_timeout_seconds: int = 5
    lock_duration_ms: int = 300_000
    batch_size: int = 8
    batch_window_seconds: float = 0.25
    severe_threshold: int = 3


@dataclass(frozen=True)
class ModerationContent:
    target_type: ModerationTargetType
    target_id: str
    author_id: str
    body: str
    moderation_status: str
    is_hidden: bool

    @property
    def ref_id(self) -> str:
        return f"{self.target_type}:{self.target_id}"

    @property
    def table_name(self) -> str:
        return "posts" if self.target_type == "post" else "messages"


@dataclass(frozen=True)
class ModerationItem:
    job_id: str
    event: DomainEvent
    content: ModerationContent

    @property
    def key(self) -> str:
        return self.content.ref_id


@dataclass(frozen=True)
class ModerationDecision:
    allow: bool
    categories: tuple[str, ...]
    severity: int
    reason: str

    def to_json(self) -> JsonObject:
        return {
            "allow": self.allow,
            "categories": list(self.categories),
            "severity": self.severity,
            "reason": self.reason,
        }


@dataclass(frozen=True)
class ModerationJobResult:
    job_id: str
    result: JsonObject


@dataclass(frozen=True)
class BullMqFailureAction:
    job_id: str
    attempts_made: int
    dead_lettered: bool
    dead_letter_entry_id: str | None


class ModerationModelOutputError(ValueError):
    pass


class ModerationBatchProcessingError(RuntimeError):
    def __init__(self, message: str, items: Sequence[ModerationItem]) -> None:
        super().__init__(message)
        self.items = list(items)


class ModerationRepository:
    def __init__(self, pool: DbPool, severe_threshold: int = 3) -> None:
        self._pool = pool
        self._severe_threshold = severe_threshold

    async def fetch_content(self, event: DomainEvent) -> ModerationContent | None:
        target_type, target_id = target_from_event(event)
        if target_type == "post":
            query = """
                select
                  id::text,
                  author_id::text as author_id,
                  body,
                  moderation_status::text as moderation_status,
                  is_hidden
                from posts
                where id = $1::uuid
            """
        else:
            query = """
                select
                  id::text,
                  sender_id::text as author_id,
                  body,
                  moderation_status::text as moderation_status,
                  is_hidden
                from messages
                where id = $1::uuid
            """

        async with self._pool.acquire() as connection:
            row = await connection.fetchrow(query, target_id)

        if row is None:
            return None

        return ModerationContent(
            target_type=target_type,
            target_id=str(row["id"]),
            author_id=str(row["author_id"]),
            body=str(row["body"]),
            moderation_status=str(row["moderation_status"]),
            is_hidden=bool(row["is_hidden"]),
        )

    async def begin_decision(
        self,
        item: ModerationItem,
    ) -> EventProcessingState:
        payload = moderation_job_payload(item)
        result: JsonObject = {"attempts": 1, "queue_job_id": item.job_id}

        async with self._pool.acquire() as connection:
            async with connection.transaction():
                inserted = await connection.fetchrow(
                    """
                    insert into ai_jobs (kind, ref_id, status, payload, result)
                    values ($1, $2, 'processing', $3::jsonb, $4::jsonb)
                    on conflict (kind, ref_id) do nothing
                    returning status, result
                    """,
                    MODERATION_DECISION_JOB_KIND,
                    item.key,
                    json.dumps(payload),
                    json.dumps(result),
                )
                if inserted is not None:
                    return EventProcessingState(already_finished=False, attempts=1)

                row = await connection.fetchrow(
                    """
                    select status, result
                    from ai_jobs
                    where kind = $1 and ref_id = $2
                    for update
                    """,
                    MODERATION_DECISION_JOB_KIND,
                    item.key,
                )
                if row is None:
                    raise RuntimeError(f"ai_jobs row disappeared for moderation {item.key}")

                status = str(row["status"])
                previous_result = json_object_from_db(row["result"])
                attempts = job_json_int(previous_result.get("attempts"), fallback=0)

                if status in {"succeeded", "dead_letter"}:
                    return EventProcessingState(already_finished=True, attempts=attempts)

                attempts += 1
                next_result: JsonObject = {
                    **previous_result,
                    "attempts": attempts,
                    "queue_job_id": item.job_id,
                }
                await connection.execute(
                    """
                    update ai_jobs
                    set status = 'processing',
                        payload = $3::jsonb,
                        result = $4::jsonb
                    where kind = $1 and ref_id = $2
                    """,
                    MODERATION_DECISION_JOB_KIND,
                    item.key,
                    json.dumps(payload),
                    json.dumps(next_result),
                )

        return EventProcessingState(already_finished=False, attempts=attempts)

    async def apply_decision(
        self,
        item: ModerationItem,
        decision: ModerationDecision,
    ) -> JsonObject:
        moderation_status = "ok" if decision.allow else "blocked"
        should_hide = not decision.allow and decision.severity >= self._severe_threshold
        notification_event_id: int | None = None

        async with self._pool.acquire() as connection:
            async with connection.transaction():
                locked = await connection.fetchrow(
                    f"""
                    select moderation_status::text as moderation_status, is_hidden
                    from {item.content.table_name}
                    where id = $1::uuid
                    for update
                    """,
                    item.content.target_id,
                )
                if locked is None:
                    raise RuntimeError(f"Moderation target disappeared: {item.key}")

                await connection.execute(
                    f"""
                    update {item.content.table_name}
                    set moderation_status = $2::moderation_status,
                        is_hidden = is_hidden or $3
                    where id = $1::uuid
                    """,
                    item.content.target_id,
                    moderation_status,
                    should_hide,
                )

                was_hidden = bool(locked["is_hidden"])
                if should_hide and not was_hidden:
                    notification = await connection.fetchrow(
                        """
                        insert into domain_events (
                          aggregate_type,
                          aggregate_id,
                          event_type,
                          payload
                        )
                        values ('moderation', $1::uuid, 'moderation.blocked', $2::jsonb)
                        returning id
                        """,
                        item.content.target_id,
                        json.dumps(moderation_blocked_payload(item, decision)),
                    )
                    raw_event_id = None if notification is None else notification["id"]
                    notification_event_id = (
                        int(str(raw_event_id)) if raw_event_id is not None else None
                    )

                result = moderation_decision_result(
                    item,
                    decision,
                    moderation_status=moderation_status,
                    hidden=should_hide or was_hidden,
                    notification_event_id=notification_event_id,
                )
                await connection.execute(
                    """
                    update ai_jobs
                    set status = 'succeeded',
                        result = result || $3::jsonb
                    where kind = $1 and ref_id = $2
                    """,
                    MODERATION_DECISION_JOB_KIND,
                    item.key,
                    json.dumps(result),
                )

        return result

    async def mark_decision_failed(
        self,
        item: ModerationItem,
        error: str,
        attempts: int,
        *,
        dead_letter_entry_id: str | None = None,
    ) -> None:
        status = "dead_letter" if dead_letter_entry_id is not None else "failed"
        result: JsonObject = {
            "attempts": attempts,
            "last_error": error,
            "queue_job_id": item.job_id,
        }
        if dead_letter_entry_id is not None:
            result["dead_letter_entry_id"] = dead_letter_entry_id

        await self._pool.execute(
            """
            update ai_jobs
            set status = $3,
                result = result || $4::jsonb
            where kind = $1 and ref_id = $2
            """,
            MODERATION_DECISION_JOB_KIND,
            item.key,
            status,
            json.dumps(result),
        )

    async def record_queue_failure(
        self,
        job: BullMqJob,
        error: str,
        action: BullMqFailureAction,
    ) -> None:
        payload: JsonObject = {
            "queue_job_id": job.id,
            "job_name": job.name,
            "job_data": cast(JsonValue, job.data),
        }
        result: JsonObject = {
            "attempts": action.attempts_made,
            "last_error": error,
        }
        if action.dead_letter_entry_id is not None:
            result["dead_letter_entry_id"] = action.dead_letter_entry_id

        status = "dead_letter" if action.dead_lettered else "failed"
        await self._pool.execute(
            """
            insert into ai_jobs (kind, ref_id, status, payload, result)
            values ($1, $2, $3, $4::jsonb, $5::jsonb)
            on conflict (kind, ref_id) do update
            set status = excluded.status,
                payload = excluded.payload,
                result = excluded.result
            """,
            MODERATION_QUEUE_JOB_KIND,
            job.id,
            status,
            json.dumps(payload),
            json.dumps(result),
        )


class ModerationService:
    def __init__(self, client: CheapModerationClient) -> None:
        self._client = client

    async def moderate(
        self,
        items: Sequence[ModerationItem],
    ) -> dict[str, ModerationDecision]:
        if not items:
            return {}

        prompt = build_moderation_prompt(items)
        raw_response = await self._client.cheap_call(
            prompt,
            system=MODERATION_RUBRIC,
            max_tokens=max_tokens_for_items(items),
        )
        return parse_moderation_response(raw_response, items)


class ModerationQueueProcessor:
    def __init__(
        self,
        repository: ModerationStore,
        moderation_service: ModerationService,
    ) -> None:
        self._repository = repository
        self._moderation_service = moderation_service

    async def process_batch(self, jobs: Sequence[BullMqJob]) -> list[ModerationJobResult]:
        results: list[ModerationJobResult] = []
        pending_items: list[ModerationItem] = []

        for job in jobs:
            event = domain_event_from_moderation_job(job)
            if event["event_type"] not in SUPPORTED_MODERATION_EVENTS:
                results.append(
                    ModerationJobResult(
                        job.id,
                        {
                            "handler": "moderation_queue",
                            "status": "ignored",
                            "event_type": event["event_type"],
                        },
                    )
                )
                continue

            content = await self._repository.fetch_content(event)
            if content is None:
                results.append(
                    ModerationJobResult(
                        job.id,
                        {
                            "handler": "moderation_queue",
                            "status": "missing_content",
                            "event_type": event["event_type"],
                        },
                    )
                )
                continue

            item = ModerationItem(job_id=job.id, event=event, content=content)
            state = await self._repository.begin_decision(item)
            if state.already_finished:
                results.append(
                    ModerationJobResult(
                        job.id,
                        {
                            "handler": "moderation_queue",
                            "status": "already_finished",
                            "event_type": event["event_type"],
                            "target_type": content.target_type,
                            "target_id": content.target_id,
                        },
                    )
                )
                continue

            pending_items.append(item)

        if not pending_items:
            return results

        try:
            decisions = await self._moderation_service.moderate(pending_items)
        except Exception as error:
            raise ModerationBatchProcessingError(str(error), pending_items) from error

        for item in pending_items:
            decision = decisions[item.key]
            result = await self._repository.apply_decision(item, decision)
            results.append(ModerationJobResult(item.job_id, result))

        return results

    async def record_batch_failure(
        self,
        error: Exception,
        items: Sequence[ModerationItem],
        actions: Mapping[str, BullMqFailureAction],
    ) -> None:
        error_message = f"{type(error).__name__}: {error}"
        for item in items:
            action = actions.get(item.job_id)
            if action is None:
                continue
            await self._repository.mark_decision_failed(
                item,
                error_message,
                action.attempts_made,
                dead_letter_entry_id=action.dead_letter_entry_id,
            )

    async def record_queue_failure(
        self,
        job: BullMqJob,
        error: Exception,
        action: BullMqFailureAction,
    ) -> None:
        await self._repository.record_queue_failure(
            job,
            f"{type(error).__name__}: {error}",
            action,
        )


class BullMqModerationConsumer:
    def __init__(
        self,
        redis: BullMqRedisClient,
        processor: ModerationQueueProcessor,
        config: ModerationQueueConfig,
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
            name="maidan-ai-moderation-queue-consumer",
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
                logger.exception("moderation_queue_consumer_loop_error")
                await asyncio.sleep(1.0)

    async def process_once(self) -> int:
        first_job_id = await self._move_next_job_to_active(block=True)
        if first_job_id is None:
            return 0
        if first_job_id.startswith("0:"):
            await self._remove_active(first_job_id)
            return 0

        job_ids = [first_job_id]
        await self._collect_batch(job_ids)

        jobs: list[BullMqJob] = []
        for job_id in job_ids:
            job = await self._load_job(job_id)
            if job is None:
                await self._remove_active(job_id)
                logger.warning("moderation_queue_job_missing job_id=%s", job_id)
                continue
            jobs.append(job)

        if not jobs:
            return len(job_ids)

        try:
            results = await self._processor.process_batch(jobs)
            result_by_job_id = {result.job_id: result.result for result in results}
            for job in jobs:
                await self._mark_completed(job.id, result_by_job_id.get(job.id, {}))
                logger.info(
                    "moderation_queue_job_completed job_id=%s name=%s",
                    job.id,
                    job.name,
                )
        except ModerationBatchProcessingError as error:
            actions: dict[str, BullMqFailureAction] = {}
            for job in jobs:
                action = await self._mark_failed_or_retry(job, error)
                actions[job.id] = action
                await self._processor.record_queue_failure(job, error, action)
            await self._processor.record_batch_failure(error, error.items, actions)
            logger.exception("moderation_queue_batch_failed job_count=%s", len(jobs))
        except Exception as error:
            for job in jobs:
                action = await self._mark_failed_or_retry(job, error)
                await self._processor.record_queue_failure(job, error, action)
            logger.exception("moderation_queue_job_failed job_count=%s", len(jobs))

        return len(job_ids)

    async def _collect_batch(self, job_ids: list[str]) -> None:
        deadline = asyncio.get_running_loop().time() + self._config.batch_window_seconds
        while len(job_ids) < self._config.batch_size:
            job_id = await self._move_next_job_to_active(block=False)
            if job_id is not None:
                if job_id.startswith("0:"):
                    await self._remove_active(job_id)
                    continue
                job_ids.append(job_id)
                continue

            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                return
            await asyncio.sleep(min(0.05, remaining))

    async def _move_next_job_to_active(self, *, block: bool) -> str | None:
        if block:
            result = await self._redis.execute_command(
                "BRPOPLPUSH",
                self._key("wait"),
                self._key("active"),
                self._config.block_timeout_seconds,
            )
        else:
            result = await self._redis.execute_command(
                "RPOPLPUSH",
                self._key("wait"),
                self._key("active"),
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
        await self._redis.execute_command(
            "ZADD",
            self._key("completed"),
            finished_on,
            job_id,
        )
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

    async def _mark_failed_or_retry(
        self,
        job: BullMqJob,
        error: Exception,
    ) -> BullMqFailureAction:
        job_key = self._job_key(job.id)
        raw_hash = await self._redis.execute_command("HGETALL", job_key)
        values = redis_hash_to_map(raw_hash)
        opts = json_object(values.get("opts"), "opts") if values else {}
        attempts = queue_json_int(opts.get("attempts"), fallback=1)
        attempts_made = await self._redis.execute_command("HINCRBY", job_key, "atm", 1)
        attempts_made_int = queue_json_int(redis_text(attempts_made), fallback=1)

        await self._remove_active(job.id)
        await self._redis.execute_command("DEL", f"{job_key}:lock")

        if attempts_made_int < attempts:
            await self._redis.execute_command("LPUSH", self._key("wait"), job.id)
            await self._redis.execute_command(
                "XADD",
                self._key("events"),
                "*",
                "event",
                "waiting",
                "jobId",
                job.id,
                "prev",
                "active",
            )
            return BullMqFailureAction(
                job_id=job.id,
                attempts_made=attempts_made_int,
                dead_lettered=False,
                dead_letter_entry_id=None,
            )

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
        await self._redis.execute_command("ZADD", self._key("failed"), finished_on, job.id)
        await self._redis.execute_command(
            "XADD",
            self._key("events"),
            "*",
            "event",
            "failed",
            "jobId",
            job.id,
            "failedReason",
            error_message,
            "prev",
            "active",
        )
        dead_letter_entry_id = await self._redis.execute_command(
            "XADD",
            self._key("dead-letter"),
            "*",
            "jobId",
            job.id,
            "failedReason",
            error_message,
            "finishedOn",
            finished_on,
        )
        return BullMqFailureAction(
            job_id=job.id,
            attempts_made=attempts_made_int,
            dead_lettered=True,
            dead_letter_entry_id=redis_text(dead_letter_entry_id),
        )

    async def _remove_active(self, job_id: str) -> None:
        await self._redis.execute_command("LREM", self._key("active"), 1, job_id)

    def _key(self, suffix: str) -> str:
        return f"{self._queue_key}:{suffix}"

    def _job_key(self, job_id: str) -> str:
        return f"{self._queue_key}:{job_id}"


def domain_event_from_moderation_job(job: BullMqJob) -> DomainEvent:
    data = job.data
    payload = data.get("payload")
    if not isinstance(payload, dict):
        raise ValueError(f"Moderation job {job.id} payload must be an object")

    event_id = data.get("id")
    if not isinstance(event_id, int) or isinstance(event_id, bool):
        raise ValueError(f"Moderation job {job.id} id must be an integer")

    return {
        "id": event_id,
        "aggregate_type": required_text(data, "aggregate_type"),
        "aggregate_id": required_text(data, "aggregate_id"),
        "event_type": required_text(data, "event_type"),
        "payload": payload,
        "created_at": required_text(data, "created_at"),
    }


def target_from_event(event: DomainEvent) -> tuple[ModerationTargetType, str]:
    if event["event_type"] == "post.created":
        target_id = payload_id(event, "post_id")
        return "post", target_id
    if event["event_type"] == "message.created":
        target_id = payload_id(event, "message_id")
        return "message", target_id
    raise ValueError(f"Unsupported moderation event_type: {event['event_type']}")


def payload_id(event: DomainEvent, key: str) -> str:
    value = event["payload"].get(key)
    if isinstance(value, str) and value:
        return value
    return event["aggregate_id"]


def required_text(data: Mapping[str, JsonValue], key: str) -> str:
    value = data.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError(f"Moderation job data is missing {key}")
    return value


def build_moderation_prompt(items: Sequence[ModerationItem]) -> str:
    prompt_items = [
        {
            "id": item.key,
            "type": item.content.target_type,
            "content": item.content.body,
        }
        for item in items
    ]
    items_json = json.dumps(prompt_items, ensure_ascii=True, separators=(",", ":"))

    if len(items) == 1:
        return (
            "Moderate this single item using the cached rubric. Return ONLY one JSON object "
            "with exactly these keys: "
            '{"allow":bool,"categories":[],"severity":0-3,"reason":string}.\n'
            f"Item: {items_json}"
        )

    return (
        "Moderate these items using the cached rubric. Return ONLY one JSON object with a "
        '"decisions" array. Each decision must contain exactly these keys: '
        '{"id":string,"allow":bool,"categories":[],"severity":0-3,"reason":string}.\n'
        f"Items: {items_json}"
    )


def parse_moderation_response(
    raw_response: str,
    items: Sequence[ModerationItem],
) -> dict[str, ModerationDecision]:
    try:
        parsed = json.loads(raw_response)
    except json.JSONDecodeError as error:
        raise ModerationModelOutputError(
            f"moderation response is not JSON: {error.msg}"
        ) from error

    expected_ids = [item.key for item in items]
    if len(items) == 1 and isinstance(parsed, dict) and "decisions" not in parsed:
        return {expected_ids[0]: decision_from_json(parsed)}

    if not isinstance(parsed, dict):
        raise ModerationModelOutputError("moderation response must be a JSON object")

    raw_decisions = parsed.get("decisions")
    if not isinstance(raw_decisions, list):
        raise ModerationModelOutputError("moderation response is missing decisions array")

    decisions: dict[str, ModerationDecision] = {}
    for raw_decision in raw_decisions:
        if not isinstance(raw_decision, dict):
            raise ModerationModelOutputError("moderation decision must be an object")
        raw_id = raw_decision.get("id")
        if not isinstance(raw_id, str) or not raw_id:
            raise ModerationModelOutputError("moderation decision is missing id")
        if raw_id in decisions:
            raise ModerationModelOutputError(f"duplicate moderation decision id: {raw_id}")
        decisions[raw_id] = decision_from_json(raw_decision)

    missing_ids = [item_id for item_id in expected_ids if item_id not in decisions]
    extra_ids = [item_id for item_id in decisions if item_id not in set(expected_ids)]
    if missing_ids or extra_ids:
        raise ModerationModelOutputError(
            "moderation decisions do not match items "
            f"missing={missing_ids} extra={extra_ids}"
        )

    return decisions


def decision_from_json(raw: Mapping[str, object]) -> ModerationDecision:
    allow = raw.get("allow")
    if not isinstance(allow, bool):
        raise ModerationModelOutputError("moderation decision allow must be a boolean")

    raw_categories = raw.get("categories")
    if not isinstance(raw_categories, list):
        raise ModerationModelOutputError("moderation decision categories must be an array")
    categories = tuple(category for category in raw_categories if isinstance(category, str))
    if len(categories) != len(raw_categories):
        raise ModerationModelOutputError("moderation decision categories must be strings")

    severity = raw.get("severity")
    if (
        isinstance(severity, bool)
        or not isinstance(severity, int)
        or severity < 0
        or severity > 3
    ):
        raise ModerationModelOutputError("moderation decision severity must be an integer 0-3")

    reason = raw.get("reason")
    if not isinstance(reason, str) or not reason.strip():
        raise ModerationModelOutputError(
            "moderation decision reason must be a non-empty string"
        )

    effective_allow = allow and severity < 2
    effective_severity = severity
    if not effective_allow and effective_severity == 0:
        effective_severity = 1

    return ModerationDecision(
        allow=effective_allow,
        categories=categories,
        severity=effective_severity,
        reason=reason.strip(),
    )


def max_tokens_for_items(items: Sequence[ModerationItem]) -> int:
    return min(2048, 192 + (192 * len(items)))


def moderation_job_payload(item: ModerationItem) -> JsonObject:
    return {
        "queue_job_id": item.job_id,
        "event": cast(JsonValue, item.event),
        "target_type": item.content.target_type,
        "target_id": item.content.target_id,
        "author_id": item.content.author_id,
        "body_sha256": hashlib.sha256(item.content.body.encode("utf-8")).hexdigest(),
        "body_length": len(item.content.body),
    }


def moderation_decision_result(
    item: ModerationItem,
    decision: ModerationDecision,
    *,
    moderation_status: str,
    hidden: bool,
    notification_event_id: int | None,
) -> JsonObject:
    result: JsonObject = {
        "handler": "moderation_queue",
        "event_type": item.event["event_type"],
        "target_type": item.content.target_type,
        "target_id": item.content.target_id,
        "author_id": item.content.author_id,
        "moderation_status": moderation_status,
        "hidden": hidden,
        "notification_emitted": notification_event_id is not None,
        **decision.to_json(),
    }
    if notification_event_id is not None:
        result["notification_event_id"] = notification_event_id
    return result


def moderation_blocked_payload(
    item: ModerationItem,
    decision: ModerationDecision,
) -> JsonObject:
    return {
        "target_type": item.content.target_type,
        "target_id": item.content.target_id,
        "author_id": item.content.author_id,
        "severity": decision.severity,
        "categories": list(decision.categories),
        "reason": decision.reason,
        "created_at": utc_now_iso(),
    }


def queue_json_int(value: JsonValue | str | None, fallback: int) -> int:
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return fallback
    return fallback


def utc_now_iso() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")
