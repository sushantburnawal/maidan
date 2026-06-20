from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from threading import Lock
from typing import Literal, cast

from maidan_ai.config import Settings
from maidan_ai.domain_events import JsonObject, JsonValue

ClaudeFamily = Literal["haiku", "sonnet"]


@dataclass(frozen=True)
class ClaudePrice:
    input_per_mtok: float
    output_per_mtok: float
    cache_write_per_mtok: float
    cache_read_per_mtok: float


@dataclass(frozen=True)
class ClaudePricing:
    haiku: ClaudePrice
    sonnet: ClaudePrice

    def price_for(self, family: ClaudeFamily) -> ClaudePrice:
        return self.haiku if family == "haiku" else self.sonnet


@dataclass
class ClaudeUsageBucket:
    calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cache_creation_input_tokens: int = 0
    cache_read_input_tokens: int = 0
    cost_usd: float = 0.0

    def to_json(self) -> JsonObject:
        return {
            "calls": self.calls,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "cache_creation_input_tokens": self.cache_creation_input_tokens,
            "cache_read_input_tokens": self.cache_read_input_tokens,
            "cost_usd": round(self.cost_usd, 8),
        }


class ClaudeUsageMetrics:
    def __init__(self, pricing: ClaudePricing) -> None:
        self._pricing = pricing
        self._lock = Lock()
        self._daily: dict[str, dict[ClaudeFamily, ClaudeUsageBucket]] = {}

    def record(
        self,
        *,
        family: ClaudeFamily,
        input_tokens: int,
        output_tokens: int,
        cache_creation_input_tokens: int,
        cache_read_input_tokens: int,
    ) -> float:
        price = self._pricing.price_for(family)
        cost_usd = (
            (input_tokens * price.input_per_mtok)
            + (output_tokens * price.output_per_mtok)
            + (cache_creation_input_tokens * price.cache_write_per_mtok)
            + (cache_read_input_tokens * price.cache_read_per_mtok)
        ) / 1_000_000
        day = datetime.now(UTC).date().isoformat()

        with self._lock:
            family_buckets = self._daily.setdefault(day, {})
            bucket = family_buckets.setdefault(family, ClaudeUsageBucket())
            bucket.calls += 1
            bucket.input_tokens += input_tokens
            bucket.output_tokens += output_tokens
            bucket.cache_creation_input_tokens += cache_creation_input_tokens
            bucket.cache_read_input_tokens += cache_read_input_tokens
            bucket.cost_usd += cost_usd

        return cost_usd

    def snapshot(self) -> JsonObject:
        with self._lock:
            days: JsonObject = {}
            today = datetime.now(UTC).date().isoformat()
            for day, family_buckets in sorted(self._daily.items()):
                days[day] = cast(
                    JsonValue,
                    {
                        "haiku": family_buckets.get("haiku", ClaudeUsageBucket()).to_json(),
                        "sonnet": family_buckets.get("sonnet", ClaudeUsageBucket()).to_json(),
                    },
                )

            today_buckets = self._daily.get(today, {})
            return {
                "daily": days,
                "today": {
                    "date": today,
                    "haiku": today_buckets.get("haiku", ClaudeUsageBucket()).to_json(),
                    "sonnet": today_buckets.get("sonnet", ClaudeUsageBucket()).to_json(),
                },
            }


def pricing_from_settings(settings: Settings) -> ClaudePricing:
    return ClaudePricing(
        haiku=ClaudePrice(
            input_per_mtok=settings.anthropic_haiku_input_usd_per_mtok,
            output_per_mtok=settings.anthropic_haiku_output_usd_per_mtok,
            cache_write_per_mtok=settings.anthropic_haiku_cache_write_usd_per_mtok,
            cache_read_per_mtok=settings.anthropic_haiku_cache_read_usd_per_mtok,
        ),
        sonnet=ClaudePrice(
            input_per_mtok=settings.anthropic_sonnet_input_usd_per_mtok,
            output_per_mtok=settings.anthropic_sonnet_output_usd_per_mtok,
            cache_write_per_mtok=settings.anthropic_sonnet_cache_write_usd_per_mtok,
            cache_read_per_mtok=settings.anthropic_sonnet_cache_read_usd_per_mtok,
        ),
    )
