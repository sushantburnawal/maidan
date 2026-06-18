create table ai_jobs (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (length(kind) > 0),
  ref_id text not null check (length(ref_id) > 0),
  status text not null check (status in ('processing', 'succeeded', 'failed', 'dead_letter')),
  payload jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint ai_jobs_kind_ref_id_unique unique (kind, ref_id),
  constraint ai_jobs_payload_object_check check (jsonb_typeof(payload) = 'object'),
  constraint ai_jobs_result_object_check check (jsonb_typeof(result) = 'object')
);

create table demand_signals (
  id uuid primary key default gen_random_uuid(),
  area text not null check (length(area) > 0),
  pillar activity_pillar not null,
  signal_strength numeric(5, 4) not null check (signal_strength >= 0 and signal_strength <= 1),
  "window" tstzrange not null,
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint demand_signals_evidence_object_check check (jsonb_typeof(evidence) = 'object')
);

create table match_scores (
  profile_id uuid not null references profiles (id) on delete cascade,
  activity_id uuid not null references activities (id) on delete cascade,
  score numeric(5, 4) not null check (score >= 0 and score <= 1),
  reason text not null,
  created_at timestamptz not null default now(),
  primary key (profile_id, activity_id)
);

create index ai_jobs_status_created_at_idx on ai_jobs (status, created_at);
create index demand_signals_area_pillar_created_at_idx
  on demand_signals (area, pillar, created_at desc);
create index match_scores_activity_id_score_idx on match_scores (activity_id, score desc);

alter table ai_jobs enable row level security;
alter table demand_signals enable row level security;
alter table match_scores enable row level security;

create policy ai_jobs_service_role_only
  on ai_jobs for all
  to service_role
  using (true)
  with check (true);

create policy demand_signals_service_role_only
  on demand_signals for all
  to service_role
  using (true)
  with check (true);

create policy match_scores_service_role_only
  on match_scores for all
  to service_role
  using (true)
  with check (true);

grant select, insert, update, delete on ai_jobs, demand_signals, match_scores
  to service_role;
