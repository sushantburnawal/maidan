export interface DomainEventEnvelope {
  id: number;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface DomainEventJobData extends DomainEventEnvelope {
  stream_entry_id: string;
}

export interface OutboxRelayTickResult {
  processed: number;
  stream_entries: string[];
  jobs_enqueued: number;
}

export interface OutboxHealthMetric {
  unprocessed_count: number;
  oldest_unprocessed_age_seconds: number | null;
}

export interface OutboxRelayRepository {
  relayBatch(
    batchSize: number,
    dispatch: (event: DomainEventEnvelope) => Promise<void>
  ): Promise<number>;
  getHealth(): Promise<OutboxHealthMetric>;
}
