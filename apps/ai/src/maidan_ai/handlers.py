from __future__ import annotations

from typing import Protocol

from maidan_ai.activity_embeddings import ActivityEmbeddingService
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
    "moderation.blocked",
)


class DomainEventHandler(Protocol):
    async def handle(self, event: DomainEvent) -> JsonObject:
        pass


class NoopDomainEventHandler:
    async def handle(self, event: DomainEvent) -> JsonObject:
        return {"handler": "noop", "event_type": event["event_type"]}


class ActivityEmbeddingEventHandler:
    def __init__(self, service: ActivityEmbeddingService) -> None:
        self._service = service

    async def handle(self, event: DomainEvent) -> JsonObject:
        activity_id = event["payload"].get("activity_id")
        if not isinstance(activity_id, str) or not activity_id:
            raise ValueError("Activity event payload is missing activity_id")

        result = await self._service.embed_activity(activity_id)
        return {
            "handler": "activity_embedding",
            "event_type": event["event_type"],
            **result.to_json(),
        }


def build_default_handlers(
    activity_embedding_service: ActivityEmbeddingService | None = None,
) -> dict[str, DomainEventHandler]:
    noop = NoopDomainEventHandler()
    handlers: dict[str, DomainEventHandler] = {
        event_type: noop for event_type in DOMAIN_EVENT_TYPES
    }

    if activity_embedding_service is not None:
        embedding_handler = ActivityEmbeddingEventHandler(activity_embedding_service)
        handlers["activity.published"] = embedding_handler
        handlers["activity.updated"] = embedding_handler

    return handlers
