from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal, NotRequired, Protocol, TypedDict, cast, overload

from pydantic import SecretStr

from maidan_ai.anthropic_metrics import ClaudeUsageMetrics
from maidan_ai.config import Settings
from maidan_ai.domain_events import JsonObject

AIProviderName = Literal["openrouter", "anthropic"]


class LLMConfigurationError(RuntimeError):
    pass


class LLMTextBlock(TypedDict):
    type: Literal["text"]
    text: str
    cache_control: NotRequired[JsonObject]


class LLMToolUseBlock(TypedDict):
    type: Literal["tool_use"]
    id: str
    name: str
    input: JsonObject


class LLMToolResultBlock(TypedDict):
    type: Literal["tool_result"]
    tool_use_id: str
    content: str
    is_error: NotRequired[bool]


LLMContentBlock = LLMTextBlock | LLMToolUseBlock | LLMToolResultBlock


class LLMMessage(TypedDict):
    role: Literal["user", "assistant"]
    content: str | list[LLMContentBlock]


class LLMTool(TypedDict):
    name: str
    description: str
    input_schema: JsonObject


@dataclass(frozen=True)
class LLMToolCall:
    id: str
    name: str
    input: JsonObject


@dataclass(frozen=True)
class LLMResponse:
    content: tuple[LLMTextBlock | LLMToolUseBlock, ...]
    stop_reason: str | None
    text: str
    tool_calls: tuple[LLMToolCall, ...]
    raw: JsonObject


class LLMProvider(Protocol):
    metrics: ClaudeUsageMetrics

    async def cheap_call(
        self,
        prompt: str,
        *,
        system: str | None = None,
        max_tokens: int = 512,
    ) -> str:
        pass

    @overload
    async def chat_call(
        self,
        messages: Sequence[LLMMessage],
        *,
        system: str | None = None,
        max_tokens: int = 1024,
        tools: None = None,
    ) -> str:
        pass

    @overload
    async def chat_call(
        self,
        messages: Sequence[LLMMessage],
        *,
        system: str | None = None,
        max_tokens: int = 1024,
        tools: Sequence[LLMTool],
    ) -> LLMResponse:
        pass

    async def chat_call(
        self,
        messages: Sequence[LLMMessage],
        *,
        system: str | None = None,
        max_tokens: int = 1024,
        tools: Sequence[LLMTool] | None = None,
    ) -> str | LLMResponse:
        pass

    async def check_reachability(self) -> None:
        pass


def build_llm_provider(settings: Settings) -> LLMProvider:
    provider = selected_provider_name(settings)
    if provider == "anthropic":
        from maidan_ai.anthropic_client import AnthropicClient

        return AnthropicClient(settings)

    from maidan_ai.openrouter_client import OpenRouterClient

    return OpenRouterClient(settings)


def selected_provider_name(settings: Settings) -> AIProviderName:
    value = settings.ai_provider.strip().lower()
    if value == "openrouter" or value == "anthropic":
        return cast(AIProviderName, value)

    raise LLMConfigurationError(
        f"AI_PROVIDER must be 'openrouter' or 'anthropic', got {settings.ai_provider!r}"
    )


def required_secret_value(secret: SecretStr | None, env_name: str) -> str:
    value = "" if secret is None else secret.get_secret_value().strip()
    if value == "" or value == "replace-me" or value.startswith("replace-me-"):
        raise LLMConfigurationError(f"{env_name} is not configured")
    return value
