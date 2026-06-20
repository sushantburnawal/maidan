from __future__ import annotations

import json
import logging
import os
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import UTC, datetime
from typing import TextIO

correlation_id_var: ContextVar[str | None] = ContextVar("correlation_id", default=None)
request_id_var: ContextVar[str | None] = ContextVar("request_id", default=None)


class JsonLogFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, object] = {
            "timestamp": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            "level": record.levelname.lower(),
            "message": record.getMessage(),
            "logger": record.name,
        }
        correlation_id = correlation_id_var.get()
        request_id = request_id_var.get()
        if correlation_id is not None:
            payload["correlation_id"] = correlation_id
        if request_id is not None:
            payload["request_id"] = request_id
        if record.exc_info is not None:
            payload["exception"] = self.formatException(record.exc_info)
        for field in (
            "method",
            "path",
            "status_code",
            "duration_ms",
            "model",
            "call_kind",
            "cost_usd",
        ):
            if hasattr(record, field):
                payload[field] = getattr(record, field)
        return json.dumps(payload, default=str)


class JsonStreamHandler(logging.StreamHandler[TextIO]):
    def __init__(self) -> None:
        super().__init__(sys.stdout)
        self.setFormatter(JsonLogFormatter())


def configure_json_logging() -> None:
    level_name = os.getenv("LOG_LEVEL", "INFO").upper()
    level = getattr(logging, level_name, logging.INFO)
    root_logger = logging.getLogger()
    root_logger.handlers = [JsonStreamHandler()]
    root_logger.setLevel(level)


def set_request_context(*, request_id: str | None, correlation_id: str | None) -> None:
    if request_id is not None:
        request_id_var.set(request_id)
    if correlation_id is not None:
        correlation_id_var.set(correlation_id)


@contextmanager
def request_context(*, request_id: str, correlation_id: str) -> Iterator[None]:
    request_token = request_id_var.set(request_id)
    correlation_token = correlation_id_var.set(correlation_id)
    try:
        yield
    finally:
        request_id_var.reset(request_token)
        correlation_id_var.reset(correlation_token)


@contextmanager
def correlation_context(correlation_id: str | None) -> Iterator[None]:
    token = correlation_id_var.set(correlation_id)
    try:
        yield
    finally:
        correlation_id_var.reset(token)


def current_correlation_id() -> str | None:
    return correlation_id_var.get()


def normalize_header_id(value: str | None) -> str | None:
    if value is None:
        return None
    trimmed = value.strip()
    if not trimmed or len(trimmed) > 160:
        return None
    if not all(character.isalnum() or character in "._:/=@+-" for character in trimmed):
        return None
    return trimmed
