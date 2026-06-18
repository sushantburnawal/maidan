from __future__ import annotations

import json
from dataclasses import dataclass
from typing import cast

from maidan_ai.db import DbPool
from maidan_ai.domain_events import DomainEvent, JsonObject, JsonValue

DOMAIN_EVENT_JOB_KIND = "domain_event"
INVALID_DOMAIN_EVENT_JOB_KIND = "domain_event_invalid"


@dataclass(frozen=True)
class EventProcessingState:
    already_finished: bool
    attempts: int


class AiJobRepository:
    def __init__(self, pool: DbPool) -> None:
        self._pool = pool

    async def begin_event(self, event: DomainEvent, stream_entry_id: str) -> EventProcessingState:
        ref_id = str(event["id"])
        payload: JsonObject = {"stream_entry_id": stream_entry_id, "event": cast(JsonValue, event)}
        result: JsonObject = {"attempts": 1, "stream_entry_id": stream_entry_id}

        async with self._pool.acquire() as connection:
            async with connection.transaction():
                inserted = await connection.fetchrow(
                    """
                    insert into ai_jobs (kind, ref_id, status, payload, result)
                    values ($1, $2, 'processing', $3::jsonb, $4::jsonb)
                    on conflict (kind, ref_id) do nothing
                    returning status, result
                    """,
                    DOMAIN_EVENT_JOB_KIND,
                    ref_id,
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
                    DOMAIN_EVENT_JOB_KIND,
                    ref_id,
                )
                if row is None:
                    raise RuntimeError(f"ai_jobs row disappeared for domain event {ref_id}")

                status = str(row["status"])
                previous_result = json_object_from_db(row["result"])
                attempts = json_int(previous_result.get("attempts"), fallback=0)

                if status in {"succeeded", "dead_letter"}:
                    return EventProcessingState(already_finished=True, attempts=attempts)

                attempts += 1
                next_result: JsonObject = {
                    **previous_result,
                    "attempts": attempts,
                    "stream_entry_id": stream_entry_id,
                }
                await connection.execute(
                    """
                    update ai_jobs
                    set status = 'processing',
                        payload = $3::jsonb,
                        result = $4::jsonb
                    where kind = $1 and ref_id = $2
                    """,
                    DOMAIN_EVENT_JOB_KIND,
                    ref_id,
                    json.dumps(payload),
                    json.dumps(next_result),
                )

        return EventProcessingState(already_finished=False, attempts=attempts)

    async def mark_succeeded(self, event: DomainEvent, result: JsonObject) -> None:
        await self._merge_result(event, "succeeded", result)

    async def mark_failed(self, event: DomainEvent, error: str, attempts: int) -> None:
        result: JsonObject = {"attempts": attempts, "last_error": error}
        await self._merge_result(event, "failed", result)

    async def mark_dead_letter(
        self,
        event: DomainEvent,
        error: str,
        attempts: int,
        dead_letter_entry_id: str,
    ) -> None:
        result: JsonObject = {
            "attempts": attempts,
            "last_error": error,
            "dead_letter_entry_id": dead_letter_entry_id,
        }
        await self._merge_result(event, "dead_letter", result)

    async def record_invalid_event(
        self,
        ref_id: str,
        payload: JsonObject,
        reason: str,
        dead_letter_entry_id: str,
    ) -> None:
        result: JsonObject = {
            "attempts": 1,
            "last_error": reason,
            "dead_letter_entry_id": dead_letter_entry_id,
        }
        await self._pool.execute(
            """
            insert into ai_jobs (kind, ref_id, status, payload, result)
            values ($1, $2, 'dead_letter', $3::jsonb, $4::jsonb)
            on conflict (kind, ref_id) do update
            set status = 'dead_letter',
                payload = excluded.payload,
                result = excluded.result
            """,
            INVALID_DOMAIN_EVENT_JOB_KIND,
            ref_id,
            json.dumps(payload),
            json.dumps(result),
        )

    async def _merge_result(self, event: DomainEvent, status: str, result: JsonObject) -> None:
        await self._pool.execute(
            """
            update ai_jobs
            set status = $3,
                result = result || $4::jsonb
            where kind = $1 and ref_id = $2
            """,
            DOMAIN_EVENT_JOB_KIND,
            str(event["id"]),
            status,
            json.dumps(result),
        )


def json_object_from_db(value: object) -> JsonObject:
    if isinstance(value, str):
        loaded = json.loads(value)
    else:
        loaded = value

    if not isinstance(loaded, dict):
        return {}

    return cast(JsonObject, loaded)


def json_int(value: JsonValue | None, fallback: int) -> int:
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return fallback
    return fallback
