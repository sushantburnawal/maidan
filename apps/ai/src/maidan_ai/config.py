from __future__ import annotations

from pathlib import Path

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

from maidan_ai.domain_events import default_events_schema_path


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        case_sensitive=False,
        env_file=(".env", "../../.env"),
        extra="ignore",
    )

    database_url: str = Field(
        default="postgresql://postgres:postgres@localhost:54322/postgres",
        validation_alias="DATABASE_URL",
    )
    postgres_ssl: bool = Field(default=False, validation_alias="POSTGRES_SSL")
    db_pool_min_size: int = Field(default=1, validation_alias="AI_DB_POOL_MIN_SIZE")
    db_pool_max_size: int = Field(default=5, validation_alias="AI_DB_POOL_MAX_SIZE")

    redis_url: str = Field(default="redis://localhost:6379", validation_alias="REDIS_URL")
    stream_domain_events: str = Field(
        default="maidan.events",
        validation_alias="STREAM_DOMAIN_EVENTS",
    )
    ai_consumer_group: str = Field(default="maidan-ai", validation_alias="AI_CONSUMER_GROUP")
    ai_consumer_name: str = Field(default="maidan-ai-1", validation_alias="AI_CONSUMER_NAME")
    ai_consumer_disabled: bool = Field(default=False, validation_alias="AI_CONSUMER_DISABLED")
    ai_stream_start_id: str = Field(default="0-0", validation_alias="AI_STREAM_START_ID")
    ai_consumer_batch_size: int = Field(default=25, validation_alias="AI_CONSUMER_BATCH_SIZE")
    ai_consumer_block_ms: int = Field(default=5000, validation_alias="AI_CONSUMER_BLOCK_MS")
    ai_event_max_attempts: int = Field(default=3, validation_alias="AI_EVENT_MAX_ATTEMPTS")
    ai_event_retry_delay_seconds: float = Field(
        default=1.0,
        validation_alias="AI_EVENT_RETRY_DELAY_SECONDS",
    )
    ai_dead_letter_stream: str = Field(
        default="maidan.events.dead-letter",
        validation_alias="AI_DEAD_LETTER_STREAM",
    )

    bullmq_prefix: str = Field(default="maidan", validation_alias="BULLMQ_PREFIX")
    queue_embeddings: str = Field(
        default="maidan.embeddings",
        validation_alias="QUEUE_EMBEDDINGS",
    )
    queue_moderation: str = Field(
        default="maidan.moderation",
        validation_alias="QUEUE_MODERATION",
    )
    embeddings_worker_disabled: bool = Field(
        default=False,
        validation_alias="EMBEDDINGS_WORKER_DISABLED",
    )
    moderation_worker_disabled: bool = Field(
        default=False,
        validation_alias="MODERATION_WORKER_DISABLED",
    )
    embeddings_queue_block_seconds: int = Field(
        default=5,
        validation_alias="EMBEDDINGS_QUEUE_BLOCK_SECONDS",
    )
    moderation_queue_block_seconds: int = Field(
        default=5,
        validation_alias="MODERATION_QUEUE_BLOCK_SECONDS",
    )
    moderation_batch_size: int = Field(default=8, validation_alias="MODERATION_BATCH_SIZE")
    moderation_batch_window_seconds: float = Field(
        default=0.25,
        validation_alias="MODERATION_BATCH_WINDOW_SECONDS",
    )
    demand_sensing_worker_disabled: bool = Field(
        default=False,
        validation_alias="DEMAND_SENSING_WORKER_DISABLED",
    )
    demand_sensing_window_days: int = Field(
        default=14,
        validation_alias="DEMAND_SENSING_WINDOW_DAYS",
    )
    demand_sensing_supply_horizon_days: int = Field(
        default=30,
        validation_alias="DEMAND_SENSING_SUPPLY_HORIZON_DAYS",
    )
    demand_sensing_batch_size: int = Field(
        default=12,
        validation_alias="DEMAND_SENSING_BATCH_SIZE",
    )
    demand_sensing_strong_threshold: float = Field(
        default=0.7,
        validation_alias="DEMAND_SENSING_STRONG_THRESHOLD",
    )
    demand_sensing_thin_open_slot_threshold: int = Field(
        default=0,
        validation_alias="DEMAND_SENSING_THIN_OPEN_SLOT_THRESHOLD",
    )
    demand_sensing_initial_delay_seconds: float = Field(
        default=60.0,
        validation_alias="DEMAND_SENSING_INITIAL_DELAY_SECONDS",
    )
    demand_sensing_interval_seconds: float = Field(
        default=86_400.0,
        validation_alias="DEMAND_SENSING_INTERVAL_SECONDS",
    )
    matchmaker_worker_disabled: bool = Field(
        default=False,
        validation_alias="MATCHMAKER_WORKER_DISABLED",
    )
    matchmaker_batch_size: int = Field(default=100, validation_alias="MATCHMAKER_BATCH_SIZE")
    matchmaker_initial_delay_seconds: float = Field(
        default=60.0,
        validation_alias="MATCHMAKER_INITIAL_DELAY_SECONDS",
    )
    matchmaker_interval_seconds: float = Field(
        default=86_400.0,
        validation_alias="MATCHMAKER_INTERVAL_SECONDS",
    )
    embeddings_model: str = Field(
        default="sentence-transformers/all-mpnet-base-v2",
        validation_alias="EMBEDDINGS_MODEL",
    )
    embeddings_dimensions: int = Field(default=768, validation_alias="EMBEDDINGS_DIMENSIONS")
    embeddings_device: str = Field(default="", validation_alias="EMBEDDINGS_DEVICE")
    embeddings_batch_size: int = Field(default=16, validation_alias="EMBEDDINGS_BATCH_SIZE")

    sutradhar_disabled: bool = Field(default=False, validation_alias="SUTRADHAR_DISABLED")
    sutradhar_memory_ttl_seconds: int = Field(
        default=86_400,
        validation_alias="SUTRADHAR_MEMORY_TTL_SECONDS",
    )
    sutradhar_max_memory_messages: int = Field(
        default=8,
        validation_alias="SUTRADHAR_MAX_MEMORY_MESSAGES",
    )
    ai_internal_token: SecretStr | None = Field(
        default=None,
        validation_alias="AI_INTERNAL_TOKEN",
    )
    ai_provider: str = Field(default="openrouter", validation_alias="AI_PROVIDER")

    events_schema_path: Path = Field(
        default_factory=default_events_schema_path,
        validation_alias="EVENTS_SCHEMA_PATH",
    )

    openrouter_api_key: SecretStr | None = Field(
        default=None,
        validation_alias="OPENROUTER_API_KEY",
    )
    openrouter_base_url: str = Field(
        default="https://openrouter.ai/api/v1",
        validation_alias="OPENROUTER_BASE_URL",
    )
    openrouter_model_conversational: str = Field(
        default="google/gemma-4-31b-it:free",
        validation_alias="OPENROUTER_MODEL_CONVERSATIONAL",
    )
    openrouter_model_moderation: str = Field(
        default="google/gemma-4-31b-it:free",
        validation_alias="OPENROUTER_MODEL_MODERATION",
    )
    openrouter_max_retries: int = Field(default=2, validation_alias="OPENROUTER_MAX_RETRIES")
    openrouter_timeout_seconds: float = Field(
        default=30.0,
        validation_alias="OPENROUTER_TIMEOUT_SECONDS",
    )

    anthropic_api_key: SecretStr | None = Field(
        default=None,
        validation_alias="ANTHROPIC_API_KEY",
    )
    anthropic_haiku_model: str = Field(
        default="claude-3-5-haiku-latest",
        validation_alias="ANTHROPIC_HAIKU_MODEL",
    )
    anthropic_sonnet_model: str = Field(
        default="claude-sonnet-4-20250514",
        validation_alias="ANTHROPIC_SONNET_MODEL",
    )
    anthropic_base_url: str = Field(
        default="https://api.anthropic.com",
        validation_alias="ANTHROPIC_BASE_URL",
    )
    anthropic_version: str = Field(
        default="2023-06-01",
        validation_alias="ANTHROPIC_VERSION",
    )
    anthropic_max_retries: int = Field(default=2, validation_alias="ANTHROPIC_MAX_RETRIES")
    anthropic_timeout_seconds: float = Field(
        default=30.0,
        validation_alias="ANTHROPIC_TIMEOUT_SECONDS",
    )
    anthropic_haiku_input_usd_per_mtok: float = Field(
        default=1.0,
        validation_alias="ANTHROPIC_HAIKU_INPUT_USD_PER_MTOK",
    )
    anthropic_haiku_output_usd_per_mtok: float = Field(
        default=5.0,
        validation_alias="ANTHROPIC_HAIKU_OUTPUT_USD_PER_MTOK",
    )
    anthropic_haiku_cache_write_usd_per_mtok: float = Field(
        default=1.25,
        validation_alias="ANTHROPIC_HAIKU_CACHE_WRITE_USD_PER_MTOK",
    )
    anthropic_haiku_cache_read_usd_per_mtok: float = Field(
        default=0.10,
        validation_alias="ANTHROPIC_HAIKU_CACHE_READ_USD_PER_MTOK",
    )
    anthropic_sonnet_input_usd_per_mtok: float = Field(
        default=3.0,
        validation_alias="ANTHROPIC_SONNET_INPUT_USD_PER_MTOK",
    )
    anthropic_sonnet_output_usd_per_mtok: float = Field(
        default=15.0,
        validation_alias="ANTHROPIC_SONNET_OUTPUT_USD_PER_MTOK",
    )
    anthropic_sonnet_cache_write_usd_per_mtok: float = Field(
        default=3.75,
        validation_alias="ANTHROPIC_SONNET_CACHE_WRITE_USD_PER_MTOK",
    )
    anthropic_sonnet_cache_read_usd_per_mtok: float = Field(
        default=0.30,
        validation_alias="ANTHROPIC_SONNET_CACHE_READ_USD_PER_MTOK",
    )
