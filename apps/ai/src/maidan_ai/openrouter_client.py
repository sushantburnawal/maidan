from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Literal, TypedDict, cast, overload

import httpx

from maidan_ai.anthropic_metrics import ClaudeFamily, ClaudeUsageMetrics, pricing_from_settings
from maidan_ai.config import Settings
from maidan_ai.domain_events import JsonObject, JsonValue
from maidan_ai.llm_provider import (
    LLMContentBlock,
    LLMMessage,
    LLMResponse,
    LLMTextBlock,
    LLMTool,
    LLMToolCall,
    LLMToolResultBlock,
    LLMToolUseBlock,
    required_secret_value,
)

logger = logging.getLogger(__name__)


class OpenRouterConfigurationError(RuntimeError):
    pass


class OpenRouterFunction(TypedDict):
    name: str
    arguments: str


class OpenRouterToolCall(TypedDict):
    id: str
    type: Literal["function"]
    function: OpenRouterFunction


@dataclass(frozen=True)
class OpenRouterTokenUsage:
    input_tokens: int
    output_tokens: int


class OpenRouterClient:
    def __init__(
        self,
        settings: Settings,
        http_client: httpx.AsyncClient | None = None,
        metrics: ClaudeUsageMetrics | None = None,
    ) -> None:
        self._settings = settings
        self._client = http_client
        self.metrics = metrics or ClaudeUsageMetrics(pricing_from_settings(settings))

    async def cheap_call(
        self,
        prompt: str,
        *,
        system: str | None = None,
        max_tokens: int = 512,
    ) -> str:
        response_json = await self._chat_completion_json(
            model=self._settings.openrouter_model_moderation,
            messages=[{"role": "user", "content": prompt}],
            system=system,
            max_tokens=max_tokens,
            call_kind="cheap",
            family="haiku",
            tools=None,
            json_response=True,
        )
        return extract_final_text(response_json)

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
        response_json = await self._chat_completion_json(
            model=self._settings.openrouter_model_conversational,
            messages=messages,
            system=system,
            max_tokens=max_tokens,
            call_kind="chat",
            family="sonnet",
            tools=tools,
            json_response=False,
        )
        if tools is None:
            return extract_final_text(response_json)

        return openrouter_response_from_json(response_json)

    async def check_reachability(self) -> None:
        headers = self._headers()
        client = self._client or httpx.AsyncClient(
            base_url=self._settings.openrouter_base_url,
            timeout=min(self._settings.openrouter_timeout_seconds, 5.0),
        )
        should_close = self._client is None
        try:
            response = await request_with_retries(
                lambda: client.get("/models", headers=headers),
                max_retries=self._settings.openrouter_max_retries,
                call_kind="readiness",
            )
            raise_for_provider_status(response, provider="OpenRouter")
        finally:
            if should_close:
                await client.aclose()

    async def _chat_completion_json(
        self,
        *,
        model: str,
        messages: Sequence[LLMMessage],
        system: str | None,
        max_tokens: int,
        call_kind: str,
        family: ClaudeFamily,
        tools: Sequence[LLMTool] | None,
        json_response: bool,
    ) -> JsonObject:
        payload: JsonObject = {
            "model": model,
            "messages": cast(JsonValue, openrouter_messages(messages, system=system)),
            "max_tokens": max_tokens,
        }
        if tools is not None:
            payload["tools"] = cast(JsonValue, openrouter_tools(tools))
            payload["tool_choice"] = "auto"
        if json_response:
            payload["response_format"] = {"type": "json_object"}
            payload["reasoning"] = {"enabled": False}

        headers = self._headers()
        client = self._client or httpx.AsyncClient(
            base_url=self._settings.openrouter_base_url,
            timeout=self._settings.openrouter_timeout_seconds,
        )
        should_close = self._client is None
        try:
            response = await request_with_retries(
                lambda: client.post("/chat/completions", json=payload, headers=headers),
                max_retries=self._settings.openrouter_max_retries,
                call_kind=call_kind,
            )
            raise_for_provider_status(response, provider="OpenRouter")
            response_json = response.json()
            if not isinstance(response_json, dict):
                raise RuntimeError("OpenRouter returned a non-object response")

            usage = token_usage_from_response(response_json)
            cost_usd = self.metrics.record(
                family=family,
                input_tokens=usage.input_tokens,
                output_tokens=usage.output_tokens,
                cache_creation_input_tokens=0,
                cache_read_input_tokens=0,
            )
            logger.info(
                "openrouter_call_tokens model=%s kind=%s input=%s output=%s cost_usd=%.8f",
                model,
                call_kind,
                usage.input_tokens,
                usage.output_tokens,
                cost_usd,
            )
            return cast(JsonObject, response_json)
        finally:
            if should_close:
                await client.aclose()

    def _headers(self) -> dict[str, str]:
        return {
            "authorization": f"Bearer {self._api_key()}",
            "content-type": "application/json",
        }

    def _api_key(self) -> str:
        try:
            return required_secret_value(self._settings.openrouter_api_key, "OPENROUTER_API_KEY")
        except Exception as error:
            raise OpenRouterConfigurationError(str(error)) from error


async def request_with_retries(
    request: Callable[[], Awaitable[httpx.Response]],
    *,
    max_retries: int,
    call_kind: str,
) -> httpx.Response:
    for attempt in range(max_retries + 1):
        response: httpx.Response | None = None
        try:
            response = await request()
            if response.status_code not in RETRYABLE_STATUS_CODES:
                return response
        except (httpx.TimeoutException, httpx.TransportError):
            if attempt >= max_retries:
                raise

        if attempt >= max_retries:
            if response is not None and response.status_code == 429:
                raise RuntimeError("OpenRouter rate limit persisted after retries (429)")
            if response is not None:
                return response
            raise RuntimeError("OpenRouter request failed after retries")

        delay_seconds = min(2.0**attempt, 8.0)
        logger.warning(
            "openrouter_call_retry kind=%s attempt=%s delay_seconds=%s",
            call_kind,
            attempt + 1,
            delay_seconds,
        )
        await asyncio.sleep(delay_seconds)

    raise RuntimeError("OpenRouter retry loop exited unexpectedly")


RETRYABLE_STATUS_CODES = {408, 409, 429, 500, 502, 503, 504}


def raise_for_provider_status(response: httpx.Response, *, provider: str) -> None:
    if response.status_code in {401, 403}:
        raise OpenRouterConfigurationError(
            f"{provider} auth failed with status {response.status_code}"
        )
    if response.status_code == 429:
        raise RuntimeError(f"{provider} rate limit returned 429")
    response.raise_for_status()


def openrouter_messages(messages: Sequence[LLMMessage], *, system: str | None) -> list[JsonObject]:
    api_messages: list[JsonObject] = []
    if system is not None:
        api_messages.append({"role": "system", "content": system})

    for message in messages:
        content = message["content"]
        if isinstance(content, str):
            api_messages.append({"role": message["role"], "content": content})
            continue

        api_messages.extend(messages_from_blocks(message["role"], content))

    return api_messages


def messages_from_blocks(
    role: Literal["user", "assistant"],
    blocks: Sequence[LLMContentBlock],
) -> list[JsonObject]:
    text_parts: list[str] = []
    tool_calls: list[OpenRouterToolCall] = []
    tool_messages: list[JsonObject] = []

    for block in blocks:
        block_type = block.get("type")
        if block_type == "text":
            text = block.get("text")
            if isinstance(text, str):
                text_parts.append(text)
            continue

        if block_type == "tool_use":
            tool_use = cast(LLMToolUseBlock, block)
            tool_calls.append(
                {
                    "id": str(tool_use["id"]),
                    "type": "function",
                    "function": {
                        "name": str(tool_use["name"]),
                        "arguments": json.dumps(
                            tool_use["input"],
                            ensure_ascii=True,
                            separators=(",", ":"),
                        ),
                    },
                }
            )
            continue

        if block_type == "tool_result":
            tool_result = cast(LLMToolResultBlock, block)
            tool_messages.append(
                {
                    "role": "tool",
                    "tool_call_id": str(tool_result["tool_use_id"]),
                    "content": str(tool_result["content"]),
                }
            )

    if role == "assistant" and tool_calls:
        return [
            {
                "role": "assistant",
                "content": "".join(text_parts) if text_parts else None,
                "tool_calls": cast(JsonValue, tool_calls),
            }
        ]

    if tool_messages:
        return tool_messages

    return [{"role": role, "content": "".join(text_parts)}]


def openrouter_tools(tools: Sequence[LLMTool]) -> list[JsonObject]:
    return [
        {
            "type": "function",
            "function": {
                "name": tool["name"],
                "description": tool["description"],
                "parameters": cast(JsonValue, tool["input_schema"]),
            },
        }
        for tool in tools
    ]


def extract_final_text(response: JsonObject) -> str:
    message = first_choice_message(response)
    if message is None:
        return ""
    return text_from_openrouter_content(message.get("content"))


def openrouter_response_from_json(response: JsonObject) -> LLMResponse:
    message = first_choice_message(response)
    if message is None:
        return LLMResponse(content=(), stop_reason=None, text="", tool_calls=(), raw=response)

    text = text_from_openrouter_content(message.get("content"))
    blocks: list[LLMTextBlock | LLMToolUseBlock] = []
    if text:
        blocks.append({"type": "text", "text": text})

    tool_calls = tool_calls_from_message(message)
    for tool_call in tool_calls:
        blocks.append(
            {
                "type": "tool_use",
                "id": tool_call.id,
                "name": tool_call.name,
                "input": tool_call.input,
            }
        )

    stop_reason = first_choice_finish_reason(response)
    return LLMResponse(
        content=tuple(blocks),
        stop_reason=stop_reason,
        text=text,
        tool_calls=tuple(tool_calls),
        raw=response,
    )


def first_choice_message(response: JsonObject) -> Mapping[str, JsonValue] | None:
    choices = response.get("choices")
    if not isinstance(choices, list) or not choices:
        return None
    first_choice = choices[0]
    if not isinstance(first_choice, dict):
        return None
    message = first_choice.get("message")
    if not isinstance(message, dict):
        return None
    return message


def first_choice_finish_reason(response: JsonObject) -> str | None:
    choices = response.get("choices")
    if not isinstance(choices, list) or not choices:
        return None
    first_choice = choices[0]
    if not isinstance(first_choice, dict):
        return None
    finish_reason = first_choice.get("finish_reason")
    return finish_reason if isinstance(finish_reason, str) else None


def text_from_openrouter_content(content: object) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""

    parts: list[str] = []
    for item in content:
        if isinstance(item, str):
            parts.append(item)
            continue
        if not isinstance(item, dict):
            continue
        text = item.get("text")
        if isinstance(text, str):
            parts.append(text)
    return "".join(parts)


def tool_calls_from_message(message: Mapping[str, JsonValue]) -> list[LLMToolCall]:
    raw_tool_calls = message.get("tool_calls")
    if not isinstance(raw_tool_calls, list):
        return []

    tool_calls: list[LLMToolCall] = []
    for raw_tool_call in raw_tool_calls:
        if not isinstance(raw_tool_call, dict):
            continue
        function = raw_tool_call.get("function")
        if not isinstance(function, dict):
            continue
        name = function.get("name")
        arguments = function.get("arguments")
        if not isinstance(name, str):
            continue
        tool_calls.append(
            LLMToolCall(
                id=str(raw_tool_call.get("id") or f"tool-{len(tool_calls) + 1}"),
                name=name,
                input=json_object_from_arguments(arguments),
            )
        )
    return tool_calls


def json_object_from_arguments(arguments: object) -> JsonObject:
    if isinstance(arguments, dict):
        return cast(JsonObject, arguments)
    if not isinstance(arguments, str) or not arguments.strip():
        return {}
    try:
        parsed = json.loads(arguments)
    except json.JSONDecodeError:
        logger.warning("openrouter_tool_arguments_invalid_json")
        return {}
    if not isinstance(parsed, dict):
        logger.warning("openrouter_tool_arguments_not_object")
        return {}
    return cast(JsonObject, parsed)


def token_usage_from_response(response: JsonObject) -> OpenRouterTokenUsage:
    usage = response.get("usage")
    if not isinstance(usage, dict):
        return OpenRouterTokenUsage(0, 0)

    return OpenRouterTokenUsage(
        input_tokens=json_int(usage.get("prompt_tokens") or usage.get("input_tokens")),
        output_tokens=json_int(usage.get("completion_tokens") or usage.get("output_tokens")),
    )


def json_int(value: object) -> int:
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return 0
    return 0
