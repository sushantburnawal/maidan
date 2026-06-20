from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Mapping, Sequence
from contextlib import suppress
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Protocol, cast

from maidan_ai.domain_events import (
    DomainEvent,
    DomainEventValidationError,
    DomainEventValidator,
    JsonObject,
    JsonValue,
)
from maidan_ai.handlers import DomainEventHandler
from maidan_ai.jobs import EventProcessingState
from maidan_ai.observability import correlation_context

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class EventConsumerConfig:
    stream_name: str = "maidan.events"
    group_name: str = "maidan-ai"
    consumer_name: str = "maidan-ai-1"
    stream_start_id: str = "0-0"
    batch_size: int = 25
    block_ms: int = 5000
    max_attempts: int = 3
    retry_delay_seconds: float = 1.0
    dead_letter_stream: str = "maidan.events.dead-letter"


@dataclass(frozen=True)
class StreamEntry:
    entry_id: str
    fields: object


class RedisStreamClient(Protocol):
    async def xgroup_create(
        self,
        name: str,
        groupname: str,
        id: str = "$",
        mkstream: bool = False,
    ) -> object:
        pass

    async def xreadgroup(
        self,
        groupname: str,
        consumername: str,
        streams: dict[str, str],
        count: int | None = None,
        block: int | None = None,
    ) -> object:
        pass

    async def xack(self, name: str, groupname: str, *ids: str) -> int:
        pass

    async def xadd(self, name: str, fields: Mapping[str, str], id: str = "*") -> object:
        pass


class EventJobStore(Protocol):
    async def begin_event(self, event: DomainEvent, stream_entry_id: str) -> EventProcessingState:
        pass

    async def mark_succeeded(self, event: DomainEvent, result: JsonObject) -> None:
        pass

    async def mark_failed(self, event: DomainEvent, error: str, attempts: int) -> None:
        pass

    async def mark_dead_letter(
        self,
        event: DomainEvent,
        error: str,
        attempts: int,
        dead_letter_entry_id: str,
    ) -> None:
        pass

    async def record_invalid_event(
        self,
        ref_id: str,
        payload: JsonObject,
        reason: str,
        dead_letter_entry_id: str,
    ) -> None:
        pass


class StreamEventDecodeError(ValueError):
    pass


class MissingDomainEventHandlerError(RuntimeError):
    pass


class RedisDomainEventConsumer:
    def __init__(
        self,
        redis: RedisStreamClient,
        jobs: EventJobStore,
        validator: DomainEventValidator,
        handlers: Mapping[str, DomainEventHandler],
        config: EventConsumerConfig,
    ) -> None:
        self._redis = redis
        self._jobs = jobs
        self._validator = validator
        self._handlers = dict(handlers)
        self._config = config
        self._running = False
        self._task: asyncio.Task[None] | None = None

    @property
    def running(self) -> bool:
        return self._running

    async def start(self) -> None:
        await self.ensure_group()
        self._running = True
        self._task = asyncio.create_task(self.run_forever(), name="maidan-ai-event-consumer")

    async def stop(self) -> None:
        self._running = False
        task = self._task
        if task is None:
            return
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task

    async def ensure_group(self) -> None:
        try:
            await self._redis.xgroup_create(
                self._config.stream_name,
                self._config.group_name,
                id=self._config.stream_start_id,
                mkstream=True,
            )
            logger.info(
                "redis_stream_group_created stream=%s group=%s start_id=%s",
                self._config.stream_name,
                self._config.group_name,
                self._config.stream_start_id,
            )
        except Exception as error:
            if "BUSYGROUP" not in str(error):
                raise
            logger.info(
                "redis_stream_group_exists stream=%s group=%s",
                self._config.stream_name,
                self._config.group_name,
            )

    async def run_forever(self) -> None:
        while self._running:
            try:
                processed = await self.process_once(block_ms=self._config.block_ms)
                if processed == 0:
                    await asyncio.sleep(0)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("domain_event_consumer_loop_error")
                await asyncio.sleep(1.0)

    async def process_once(self, block_ms: int | None = None) -> int:
        pending = await self._read_entries(stream_id="0", block_ms=None)
        if pending:
            await self._process_entries(pending)
            return len(pending)

        entries = await self._read_entries(stream_id=">", block_ms=block_ms)
        if entries:
            await self._process_entries(entries)
        return len(entries)

    async def _read_entries(self, stream_id: str, block_ms: int | None) -> list[StreamEntry]:
        response = await self._redis.xreadgroup(
            self._config.group_name,
            self._config.consumer_name,
            {self._config.stream_name: stream_id},
            count=self._config.batch_size,
            block=block_ms,
        )
        return parse_xreadgroup_response(response)

    async def _process_entries(self, entries: Sequence[StreamEntry]) -> None:
        for entry in entries:
            await self._process_entry(entry)

    async def _process_entry(self, entry: StreamEntry) -> None:
        try:
            event = stream_entry_to_domain_event(entry.fields)
            self._validator.validate(event_for_domain_validation(event))
        except (StreamEventDecodeError, DomainEventValidationError) as error:
            reason = str(error)
            payload = invalid_event_payload(entry, reason)
            dead_letter_entry_id = await self._dead_letter(payload)
            await self._jobs.record_invalid_event(
                invalid_event_ref_id(entry, payload),
                payload,
                reason,
                dead_letter_entry_id,
            )
            await self._ack(entry.entry_id)
            logger.warning(
                "domain_event_dead_letter_invalid entry_id=%s dead_letter_entry_id=%s reason=%s",
                entry.entry_id,
                dead_letter_entry_id,
                reason,
            )
            return

        with correlation_context(correlation_id_from_event(event)):
            await self._process_valid_entry(entry, event)

    async def _process_valid_entry(self, entry: StreamEntry, event: DomainEvent) -> None:
        state = await self._jobs.begin_event(event, entry.entry_id)
        if state.already_finished:
            await self._ack(entry.entry_id)
            logger.info("domain_event_already_finished event_id=%s", event["id"])
            return

        try:
            handler = self._handler_for(event)
            result = await handler.handle(event)
            await self._jobs.mark_succeeded(event, result)
            await self._ack(entry.entry_id)
            logger.info(
                "domain_event_handled event_id=%s event_type=%s stream_entry_id=%s",
                event["id"],
                event["event_type"],
                entry.entry_id,
            )
        except Exception as error:
            error_message = f"{type(error).__name__}: {error}"
            if state.attempts >= self._config.max_attempts:
                payload = valid_event_dead_letter_payload(
                    entry,
                    event,
                    error_message,
                    state.attempts,
                )
                dead_letter_entry_id = await self._dead_letter(payload)
                await self._jobs.mark_dead_letter(
                    event,
                    error_message,
                    state.attempts,
                    dead_letter_entry_id,
                )
                await self._ack(entry.entry_id)
                logger.exception(
                    "domain_event_dead_letter_failed event_id=%s attempts=%s "
                    "dead_letter_entry_id=%s",
                    event["id"],
                    state.attempts,
                    dead_letter_entry_id,
                )
                return

            await self._jobs.mark_failed(event, error_message, state.attempts)
            logger.exception(
                "domain_event_handler_failed event_id=%s attempts=%s",
                event["id"],
                state.attempts,
            )
            if self._config.retry_delay_seconds > 0:
                await asyncio.sleep(self._config.retry_delay_seconds)

    def _handler_for(self, event: DomainEvent) -> DomainEventHandler:
        handler = self._handlers.get(event["event_type"])
        if handler is None:
            raise MissingDomainEventHandlerError(f"No handler for {event['event_type']}")
        return handler

    async def _dead_letter(self, payload: JsonObject) -> str:
        entry_id = await self._redis.xadd(
            self._config.dead_letter_stream,
            {
                "payload": json.dumps(payload),
                "created_at": utc_now_iso(),
            },
        )
        return to_text(entry_id)

    async def _ack(self, entry_id: str) -> None:
        acked = await self._redis.xack(
            self._config.stream_name,
            self._config.group_name,
            entry_id,
        )
        if acked != 1:
            logger.warning("domain_event_ack_unexpected entry_id=%s acked=%s", entry_id, acked)


def parse_xreadgroup_response(response: object) -> list[StreamEntry]:
    if response is None:
        return []
    if not isinstance(response, Sequence) or isinstance(response, (str, bytes, bytearray)):
        return []

    entries: list[StreamEntry] = []
    for stream_response in response:
        if not isinstance(stream_response, Sequence) or len(stream_response) != 2:
            continue
        stream_entries = stream_response[1]
        if not isinstance(stream_entries, Sequence) or isinstance(
            stream_entries,
            (str, bytes, bytearray),
        ):
            continue
        for raw_entry in stream_entries:
            if not isinstance(raw_entry, Sequence) or len(raw_entry) != 2:
                continue
            entries.append(StreamEntry(entry_id=to_text(raw_entry[0]), fields=raw_entry[1]))
    return entries


def stream_entry_to_domain_event(fields: object) -> DomainEvent:
    values = stream_fields_to_map(fields)
    payload_raw = required_field(values, "payload")

    try:
        payload = json.loads(payload_raw)
    except json.JSONDecodeError as error:
        raise StreamEventDecodeError(f"payload is not valid JSON: {error.msg}") from error

    if not isinstance(payload, dict):
        raise StreamEventDecodeError("payload must be a JSON object")

    raw_id = required_field(values, "id")
    try:
        event_id = int(raw_id)
    except ValueError as error:
        raise StreamEventDecodeError("id must be an integer") from error

    return {
        "id": event_id,
        "aggregate_type": required_field(values, "aggregate_type"),
        "aggregate_id": required_field(values, "aggregate_id"),
        "event_type": required_field(values, "event_type"),
        "payload": cast(JsonObject, payload),
        "created_at": required_field(values, "created_at"),
    }


def stream_fields_to_map(fields: object) -> dict[str, str]:
    if isinstance(fields, Mapping):
        return {to_text(key): to_text(value) for key, value in fields.items()}

    if isinstance(fields, Sequence) and not isinstance(fields, (str, bytes, bytearray)):
        values: dict[str, str] = {}
        for index in range(0, len(fields), 2):
            if index + 1 >= len(fields):
                break
            values[to_text(fields[index])] = to_text(fields[index + 1])
        return values

    raise StreamEventDecodeError("stream entry fields must be a mapping or field/value list")


def required_field(values: Mapping[str, str], key: str) -> str:
    value = values.get(key)
    if value is None or value == "":
        raise StreamEventDecodeError(f"missing required field {key}")
    return value


def correlation_id_from_event(event: DomainEvent) -> str | None:
    value = event["payload"].get("correlation_id")
    return value if isinstance(value, str) and value else None


def event_for_domain_validation(event: DomainEvent) -> DomainEvent:
    domain_payload: JsonObject = dict(event["payload"])
    domain_payload.pop("correlation_id", None)

    return {
        "id": event["id"],
        "aggregate_type": event["aggregate_type"],
        "aggregate_id": event["aggregate_id"],
        "event_type": event["event_type"],
        "payload": domain_payload,
        "created_at": event["created_at"],
    }


def invalid_event_payload(entry: StreamEntry, reason: str) -> JsonObject:
    raw_fields: JsonObject = {}
    with suppress(StreamEventDecodeError):
        raw_fields = cast(JsonObject, stream_fields_to_map(entry.fields))

    return {
        "stream_entry_id": entry.entry_id,
        "reason": reason,
        "raw_fields": raw_fields,
    }


def valid_event_dead_letter_payload(
    entry: StreamEntry,
    event: DomainEvent,
    reason: str,
    attempts: int,
) -> JsonObject:
    return {
        "stream_entry_id": entry.entry_id,
        "event_id": event["id"],
        "event_type": event["event_type"],
        "reason": reason,
        "attempts": attempts,
        "event": cast(JsonValue, event),
    }


def invalid_event_ref_id(entry: StreamEntry, payload: JsonObject) -> str:
    raw_fields = payload.get("raw_fields")
    if isinstance(raw_fields, dict):
        raw_id = raw_fields.get("id")
        if isinstance(raw_id, str) and raw_id:
            return raw_id
    return entry.entry_id


def utc_now_iso() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def to_text(value: object) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8")
    return str(value)
