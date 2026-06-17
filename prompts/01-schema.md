In /db, author the initial Supabase migration (forward + rollback) for Maidan's Fact plane. Use
plain SQL migrations runnable by the Supabase CLI. Enable extensions: postgis, vector, pgcrypto.

Tables (use snake_case, uuid PKs via gen_random_uuid(), created_at/updated_at timestamptz):

profiles            -- 1:1 with auth user. id, phone (unique, e164), display_name, avatar_url, bio,
                       interests text[], home_location geography(Point,4326), created_at, updated_at
host_profiles       -- profile_id FK unique, is_verified bool, payout_ref text (PhonePe merchant/
                       sub-merchant handle), rating numeric, total_activities int
activities          -- id, host_id FK->profiles, title, description, pillar enum('move','learn','feel'),
                       category text, meeting_point text, location geography(Point,4326),
                       base_price_inr int, currency default 'INR', capacity int,
                       fairness_score numeric, status enum('draft','published','paused','archived'),
                       media jsonb default '[]', embedding vector(768), created_at, updated_at
activity_slots      -- id, activity_id FK, starts_at timestamptz, ends_at timestamptz,
                       capacity int, booked_count int default 0, status enum('open','full','closed','cancelled')
bookings            -- id, slot_id FK, explorer_id FK->profiles, headcount int default 1,
                       amount_inr int, status enum('pending','confirmed','cancelled','refunded'),
                       payment_id FK nullable, created_at, updated_at
payments            -- id, booking_id FK, phonepe_order_id text unique, phonepe_txn_id text,
                       amount_inr int, platform_fee_inr int, host_payout_inr int,
                       status enum('initiated','success','failed','refunded'),
                       raw_callback jsonb, created_at, updated_at
reviews             -- id, booking_id FK unique, rating int check 1..5, body text, created_at
posts               -- id, author_id FK->profiles, body text, media jsonb default '[]',
                       linked_activity_id FK->activities nullable, created_at
group_chats         -- id, activity_id FK unique, title text, created_at
chat_members        -- chat_id FK, profile_id FK, joined_at, PK(chat_id, profile_id)
messages            -- id, chat_id FK, sender_id FK->profiles, body text, created_at
domain_events       -- THE OUTBOX. id bigserial, aggregate_type text, aggregate_id uuid,
                       event_type text, payload jsonb, created_at timestamptz default now(),
                       processed_at timestamptz null

Indexes:
- GiST on activities.location and profiles.home_location.
- HNSW (or ivfflat) on activities.embedding for cosine ops.
- btree on activity_slots(activity_id, starts_at), bookings(explorer_id), messages(chat_id, created_at),
  partial index on domain_events(processed_at) WHERE processed_at IS NULL.

RLS:
- Enable RLS on all user-facing tables. Policies: a profile can read public/published data; can write
  only rows they own (host owns their activities/slots; explorer owns their bookings; sender owns
  their messages; chat reads require membership). Service-role bypasses RLS for the API.
- domain_events is service-role only.

Also add updated_at trigger function and attach it to tables with updated_at.

DoD:
- `supabase db reset` (or the CLI migration run in docker) applies forward cleanly and rolls back
  cleanly. Include a smoke SQL script proving PostGIS ST_DWithin and a vector <=> query both run.
Do NOT add seed data here.