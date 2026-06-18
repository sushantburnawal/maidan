from __future__ import annotations

import asyncio
import math
from collections.abc import Callable, Sequence
from importlib import import_module
from typing import Protocol, cast


class Embedder(Protocol):
    @property
    def dimensions(self) -> int:
        pass

    async def embed(self, texts: Sequence[str]) -> list[list[float]]:
        pass


class SentenceTransformerEmbedder:
    def __init__(self, model_name: str, dimensions: int = 768, device: str | None = None) -> None:
        module = import_module("sentence_transformers")
        model_factory = cast(Callable[..., object], module.__dict__["SentenceTransformer"])
        kwargs: dict[str, object] = {}
        if device:
            kwargs["device"] = device

        self._model = model_factory(model_name, **kwargs)
        self._dimensions = dimensions

        dimension_getter = getattr(self._model, "get_sentence_embedding_dimension", None)
        if callable(dimension_getter):
            actual_dimensions = dimension_getter()
            if actual_dimensions is not None and int(actual_dimensions) != dimensions:
                raise ValueError(
                    f"Embedding model {model_name} returns {actual_dimensions} dimensions; "
                    f"expected {dimensions}"
                )

    @property
    def dimensions(self) -> int:
        return self._dimensions

    async def embed(self, texts: Sequence[str]) -> list[list[float]]:
        if not texts:
            return []

        raw_embeddings = await asyncio.to_thread(self._encode, list(texts))
        if not isinstance(raw_embeddings, Sequence):
            raise ValueError("Embedding model returned a non-sequence result")

        return [coerce_embedding(value, self._dimensions) for value in raw_embeddings]

    def _encode(self, texts: list[str]) -> object:
        encode = getattr(self._model, "encode", None)
        if not callable(encode):
            raise RuntimeError("Embedding model does not expose encode()")

        return encode(
            texts,
            normalize_embeddings=True,
            convert_to_numpy=False,
            show_progress_bar=False,
        )


def coerce_embedding(value: object, dimensions: int) -> list[float]:
    to_list = getattr(value, "tolist", None)
    if callable(to_list):
        value = to_list()

    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        raise ValueError("Embedding value must be a numeric sequence")

    embedding: list[float] = []
    for item in value:
        if isinstance(item, bool) or not isinstance(item, (int, float)):
            raise ValueError("Embedding value must contain only numbers")
        number = float(item)
        if not math.isfinite(number):
            raise ValueError("Embedding value must contain only finite numbers")
        embedding.append(number)

    if len(embedding) != dimensions:
        raise ValueError(f"Embedding has {len(embedding)} dimensions; expected {dimensions}")

    return embedding


def pgvector_literal(embedding: Sequence[float], dimensions: int = 768) -> str:
    coerced = coerce_embedding(embedding, dimensions)
    return "[" + ",".join(format(value, ".9g") for value in coerced) + "]"
