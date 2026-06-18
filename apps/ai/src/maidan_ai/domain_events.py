from __future__ import annotations

import json
from pathlib import Path
from typing import TypedDict, cast

from jsonschema import Draft202012Validator, FormatChecker, ValidationError

type JsonPrimitive = str | int | float | bool | None
type JsonValue = JsonPrimitive | list[JsonValue] | dict[str, JsonValue]
type JsonObject = dict[str, JsonValue]


class DomainEvent(TypedDict):
    id: int
    aggregate_type: str
    aggregate_id: str
    event_type: str
    payload: JsonObject
    created_at: str


class DomainEventValidationError(ValueError):
    pass


def default_events_schema_path() -> Path:
    return Path(__file__).resolve().parents[4] / "packages/shared/contracts/events.schema.json"


def load_json_object(path: Path) -> JsonObject:
    with path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)

    if not isinstance(data, dict):
        raise ValueError(f"Expected JSON object in {path}")

    return cast(JsonObject, data)


class DomainEventValidator:
    def __init__(self, schema: JsonObject) -> None:
        Draft202012Validator.check_schema(schema)
        self._validator = Draft202012Validator(schema, format_checker=FormatChecker())

    @classmethod
    def from_schema_path(cls, schema_path: Path) -> DomainEventValidator:
        return cls(load_json_object(schema_path))

    def validate(self, event: DomainEvent) -> None:
        try:
            self._validator.validate(event)
        except ValidationError as error:
            path = ".".join(str(part) for part in error.absolute_path)
            prefix = f"{path}: " if path else ""
            raise DomainEventValidationError(f"{prefix}{error.message}") from error
