from __future__ import annotations

from typing import Protocol

from maidan_ai.domain_events import DomainEvent, JsonObject

DOMAIN_EVENT_TYPES = (
    "activity.published",
    "activity.updated",
    "booking.created",
    "booking.confirmed",
    "booking.cancelled",
    "payment.succeeded",
    "payment.failed",
    "review.created",
    "post.created",
    "message.created",
)


class DomainEventHandler(Protocol):
    async def handle(self, event: DomainEvent) -> JsonObject:
        pass


class NoopDomainEventHandler:
    async def handle(self, event: DomainEvent) -> JsonObject:
        return {"handler": "noop", "event_type": event["event_type"]}


def build_default_handlers() -> dict[str, DomainEventHandler]:
    noop = NoopDomainEventHandler()
    return {event_type: noop for event_type in DOMAIN_EVENT_TYPES}
