from __future__ import annotations

import asyncio
import logging
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal, NotRequired, TypedDict, cast

import httpx

from maidan_ai.config import Settings
from maidan_ai.domain_events import JsonObject, JsonValue

logger = logging.getLogger(__name__)


class AnthropicConfigurationError(RuntimeError):
    pass


class AnthropicMessage(TypedDict):
    role: Literal["user", "assistant"]
    content: str


class AnthropicApiMessage(TypedDict):
    role: Literal["user", "assistant"]
    content: str | list[AnthropicTextBlock]


class AnthropicTextBlock(TypedDict):
    type: Literal["text"]
    text: str
    cache_control: NotRequired[JsonObject]


@dataclass(frozen=True)
class AnthropicTokenUsage:
    input_tokens: int
    output_tokens: int
    cache_creation_input_tokens: int
    cache_read_input_tokens: int


class AnthropicClient:
    def __init__(
        self,
        settings: Settings,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self._settings = settings
        self._client = http_client

    async def cheap_call(
        self,
        prompt: str,
        *,
        system: str | None = None,
        max_tokens: int = 512,
    ) -> str:
        return await self._messages_call(
            model=self._settings.anthropic_haiku_model,
            messages=[{"role": "user", "content": prompt}],
            system=system,
            max_tokens=max_tokens,
            prompt_cache=True,
            call_kind="cheap",
        )

    async def chat_call(
        self,
        messages: Sequence[AnthropicMessage],
        *,
        system: str | None = None,
        max_tokens: int = 1024,
    ) -> str:
        return await self._messages_call(
            model=self._settings.anthropic_sonnet_model,
            messages=messages,
            system=system,
            max_tokens=max_tokens,
            prompt_cache=False,
            call_kind="chat",
        )

    async def _messages_call(
        self,
        *,
        model: str,
        messages: Sequence[AnthropicMessage],
        system: str | None,
        max_tokens: int,
        prompt_cache: bool,
        call_kind: str,
    ) -> str:
        api_key = self._api_key()
        api_messages = self._api_messages(messages, prompt_cache and system is None)
        payload: JsonObject = {
            "model": model,
            "max_tokens": max_tokens,
            "messages": cast(JsonValue, api_messages),
        }
        if system is not None:
            payload["system"] = cast(JsonValue, self._system_blocks(system, prompt_cache))

        headers = {
            "x-api-key": api_key,
            "anthropic-version": self._settings.anthropic_version,
            "content-type": "application/json",
        }
        if prompt_cache:
            headers["anthropic-beta"] = "prompt-caching-2024-07-31"

        response_json = await self._post_with_retries(
            path="/v1/messages",
            payload=payload,
            headers=headers,
            model=model,
            call_kind=call_kind,
        )
        usage = token_usage_from_response(response_json)
        logger.info(
            "anthropic_call_tokens model=%s kind=%s input=%s output=%s "
            "cache_create=%s cache_read=%s",
            model,
            call_kind,
            usage.input_tokens,
            usage.output_tokens,
            usage.cache_creation_input_tokens,
            usage.cache_read_input_tokens,
        )
        return extract_text(response_json)

    async def _post_with_retries(
        self,
        *,
        path: str,
        payload: JsonObject,
        headers: dict[str, str],
        model: str,
        call_kind: str,
    ) -> JsonObject:
        client = self._client or httpx.AsyncClient(
            base_url=self._settings.anthropic_base_url,
            timeout=self._settings.anthropic_timeout_seconds,
        )
        should_close = self._client is None
        try:
            for attempt in range(self._settings.anthropic_max_retries + 1):
                try:
                    response = await client.post(path, json=payload, headers=headers)
                    if response.status_code < 400:
                        data = response.json()
                        if not isinstance(data, dict):
                            raise RuntimeError("Anthropic returned a non-object response")
                        return cast(JsonObject, data)

                    if response.status_code not in {408, 409, 429, 500, 502, 503, 504}:
                        response.raise_for_status()
                except (httpx.TimeoutException, httpx.TransportError):
                    if attempt >= self._settings.anthropic_max_retries:
                        raise

                if attempt >= self._settings.anthropic_max_retries:
                    response.raise_for_status()

                delay_seconds = min(2.0**attempt, 8.0)
                logger.warning(
                    "anthropic_call_retry model=%s kind=%s attempt=%s delay_seconds=%s",
                    model,
                    call_kind,
                    attempt + 1,
                    delay_seconds,
                )
                await asyncio.sleep(delay_seconds)
        finally:
            if should_close:
                await client.aclose()

        raise RuntimeError("Anthropic retry loop exited unexpectedly")

    def _api_key(self) -> str:
        secret = self._settings.anthropic_api_key
        value = "" if secret is None else secret.get_secret_value()
        if value == "" or value == "replace-me":
            raise AnthropicConfigurationError("ANTHROPIC_API_KEY is not configured")
        return value

    @staticmethod
    def _system_blocks(system: str, prompt_cache: bool) -> list[AnthropicTextBlock]:
        block: AnthropicTextBlock = {"type": "text", "text": system}
        if prompt_cache:
            block["cache_control"] = {"type": "ephemeral"}
        return [block]

    @staticmethod
    def _api_messages(
        messages: Sequence[AnthropicMessage],
        prompt_cache: bool,
    ) -> list[AnthropicApiMessage]:
        api_messages: list[AnthropicApiMessage] = []
        cache_applied = False
        for message in messages:
            content: str | list[AnthropicTextBlock] = message["content"]
            if prompt_cache and not cache_applied:
                content = [
                    {
                        "type": "text",
                        "text": message["content"],
                        "cache_control": {"type": "ephemeral"},
                    }
                ]
                cache_applied = True
            api_messages.append({"role": message["role"], "content": content})
        return api_messages


def token_usage_from_response(response: JsonObject) -> AnthropicTokenUsage:
    usage = response.get("usage")
    if not isinstance(usage, dict):
        return AnthropicTokenUsage(0, 0, 0, 0)

    return AnthropicTokenUsage(
        input_tokens=json_int(usage.get("input_tokens")),
        output_tokens=json_int(usage.get("output_tokens")),
        cache_creation_input_tokens=json_int(usage.get("cache_creation_input_tokens")),
        cache_read_input_tokens=json_int(usage.get("cache_read_input_tokens")),
    )


def extract_text(response: JsonObject) -> str:
    content = response.get("content")
    if not isinstance(content, list):
        return ""

    parts: list[str] = []
    for item in content:
        if not isinstance(item, dict):
            continue
        text = item.get("text")
        if item.get("type") == "text" and isinstance(text, str):
            parts.append(text)
    return "".join(parts)


def json_int(value: object) -> int:
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return 0
    return 0
