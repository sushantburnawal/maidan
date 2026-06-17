create type activity_pillar as enum ('move', 'learn', 'feel');
create type activity_status as enum ('draft', 'published', 'paused', 'archived');
create type slot_status as enum ('open', 'full', 'closed', 'cancelled');
create type booking_status as enum ('pending', 'confirmed', 'cancelled', 'refunded');
create type payment_status as enum ('initiated', 'success', 'failed', 'refunded');

create table profiles (
  id uuid primary key default gen_random_uuid() references auth.users (id) on delete cascade,
  phone text not null unique check (phone ~ '^\+[1-9][0-9]{1,14}$'),
  display_name text not null,
  avatar_url text,
  bio text,
  interests text[] not null default '{}',
  home_location geography(Point, 4326),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table host_profiles (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null unique references profiles (id) on delete cascade,
  is_verified boolean not null default false,
  payout_ref text,
  rating numeric(3, 2) not null default 0 check (rating >= 0 and rating <= 5),
  total_activities int not null default 0 check (total_activities >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table activities (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references profiles (id) on delete restrict,
  title text not null,
  description text not null,
  pillar activity_pillar not null,
  category text not null,
  meeting_point text not null,
  location geography(Point, 4326) not null,
  base_price_inr int not null check (base_price_inr >= 0),
  currency text not null default 'INR' check (currency = 'INR'),
  capacity int not null check (capacity > 0),
  fairness_score numeric not null default 0 check (fairness_score >= 0),
  status activity_status not null default 'draft',
  media jsonb not null default '[]'::jsonb check (jsonb_typeof(media) = 'array'),
  embedding vector(768),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table activity_slots (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references activities (id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  capacity int not null check (capacity > 0),
  booked_count int not null default 0 check (booked_count >= 0),
  status slot_status not null default 'open',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint activity_slots_time_check check (ends_at > starts_at),
  constraint activity_slots_booked_count_capacity_check check (booked_count <= capacity)
);

create table bookings (
  id uuid primary key default gen_random_uuid(),
  slot_id uuid not null references activity_slots (id) on delete restrict,
  explorer_id uuid not null references profiles (id) on delete restrict,
  headcount int not null default 1 check (headcount > 0),
  amount_inr int not null check (amount_inr >= 0),
  status booking_status not null default 'pending',
  payment_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table payments (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings (id) on delete restrict,
  phonepe_order_id text not null unique,
  phonepe_txn_id text,
  amount_inr int not null check (amount_inr >= 0),
  platform_fee_inr int not null check (platform_fee_inr >= 0),
  host_payout_inr int not null check (host_payout_inr >= 0),
  status payment_status not null default 'initiated',
  raw_callback jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payments_amount_split_check check (platform_fee_inr + host_payout_inr = amount_inr)
);

alter table bookings
  add constraint bookings_payment_id_fkey foreign key (payment_id) references payments (id) on delete set null;

create table reviews (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null unique references bookings (id) on delete cascade,
  rating int not null check (rating >= 1 and rating <= 5),
  body text,
  created_at timestamptz not null default now()
);

create table posts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references profiles (id) on delete cascade,
  body text not null,
  media jsonb not null default '[]'::jsonb check (jsonb_typeof(media) = 'array'),
  linked_activity_id uuid references activities (id) on delete set null,
  created_at timestamptz not null default now()
);

create table group_chats (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null unique references activities (id) on delete cascade,
  title text not null,
  created_at timestamptz not null default now()
);

create table chat_members (
  chat_id uuid not null references group_chats (id) on delete cascade,
  profile_id uuid not null references profiles (id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (chat_id, profile_id)
);

create table messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references group_chats (id) on delete cascade,
  sender_id uuid not null references profiles (id) on delete restrict,
  body text not null,
  created_at timestamptz not null default now()
);

create table domain_events (
  id bigserial primary key,
  aggregate_type text not null,
  aggregate_id uuid not null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

create index profiles_home_location_gix on profiles using gist (home_location);
create index activities_location_gix on activities using gist (location);
create index activities_embedding_ivfflat_idx
  on activities using ivfflat (embedding vector_cosine_ops) with (lists = 100)
  where embedding is not null;
create index activity_slots_activity_id_starts_at_idx on activity_slots (activity_id, starts_at);
create index bookings_explorer_id_idx on bookings (explorer_id);
create index messages_chat_id_created_at_idx on messages (chat_id, created_at);
create index domain_events_unprocessed_idx on domain_events (processed_at) where processed_at is null;

create function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_set_updated_at
  before update on profiles
  for each row execute function set_updated_at();

create trigger host_profiles_set_updated_at
  before update on host_profiles
  for each row execute function set_updated_at();

create trigger activities_set_updated_at
  before update on activities
  for each row execute function set_updated_at();

create trigger activity_slots_set_updated_at
  before update on activity_slots
  for each row execute function set_updated_at();

create trigger bookings_set_updated_at
  before update on bookings
  for each row execute function set_updated_at();

create trigger payments_set_updated_at
  before update on payments
  for each row execute function set_updated_at();

create function profile_has_published_activity(_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from activities a
    where a.host_id = _profile_id
      and a.status = 'published'
  );
$$;

create function profile_has_public_post(_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from posts p
    where p.author_id = _profile_id
      and (
        p.linked_activity_id is null
        or exists (
          select 1
          from activities a
          where a.id = p.linked_activity_id
            and a.status = 'published'
        )
      )
  );
$$;

create function is_activity_published(_activity_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from activities a
    where a.id = _activity_id
      and a.status = 'published'
  );
$$;

create function is_activity_host(_activity_id uuid, _profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from activities a
    where a.id = _activity_id
      and a.host_id = _profile_id
  );
$$;

create function is_slot_activity_host(_slot_id uuid, _profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from activity_slots s
    join activities a on a.id = s.activity_id
    where s.id = _slot_id
      and a.host_id = _profile_id
  );
$$;

create function is_booking_explorer(_booking_id uuid, _profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from bookings b
    where b.id = _booking_id
      and b.explorer_id = _profile_id
  );
$$;

create function can_read_booking(_booking_id uuid, _profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from bookings b
    where b.id = _booking_id
      and (
        b.explorer_id = _profile_id
        or is_slot_activity_host(b.slot_id, _profile_id)
      )
  );
$$;

create function is_review_public(_booking_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from bookings b
    join activity_slots s on s.id = b.slot_id
    join activities a on a.id = s.activity_id
    where b.id = _booking_id
      and a.status = 'published'
  );
$$;

create function is_chat_member(_chat_id uuid, _profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from chat_members cm
    where cm.chat_id = _chat_id
      and cm.profile_id = _profile_id
  );
$$;

alter table profiles enable row level security;
alter table host_profiles enable row level security;
alter table activities enable row level security;
alter table activity_slots enable row level security;
alter table bookings enable row level security;
alter table payments enable row level security;
alter table reviews enable row level security;
alter table posts enable row level security;
alter table group_chats enable row level security;
alter table chat_members enable row level security;
alter table messages enable row level security;
alter table domain_events enable row level security;

create policy profiles_select_public_or_owned
  on profiles for select
  to anon, authenticated
  using (
    id = auth.uid()
    or profile_has_published_activity(id)
    or profile_has_public_post(id)
  );

create policy profiles_insert_owned
  on profiles for insert
  to authenticated
  with check (id = auth.uid());

create policy profiles_update_owned
  on profiles for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

create policy profiles_delete_owned
  on profiles for delete
  to authenticated
  using (id = auth.uid());

create policy host_profiles_select_public_or_owned
  on host_profiles for select
  to anon, authenticated
  using (
    profile_id = auth.uid()
    or profile_has_published_activity(profile_id)
  );

create policy host_profiles_insert_owned
  on host_profiles for insert
  to authenticated
  with check (profile_id = auth.uid());

create policy host_profiles_update_owned
  on host_profiles for update
  to authenticated
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

create policy host_profiles_delete_owned
  on host_profiles for delete
  to authenticated
  using (profile_id = auth.uid());

create policy activities_select_public_or_hosted
  on activities for select
  to anon, authenticated
  using (status = 'published' or host_id = auth.uid());

create policy activities_insert_hosted
  on activities for insert
  to authenticated
  with check (host_id = auth.uid());

create policy activities_update_hosted
  on activities for update
  to authenticated
  using (host_id = auth.uid())
  with check (host_id = auth.uid());

create policy activities_delete_hosted
  on activities for delete
  to authenticated
  using (host_id = auth.uid());

create policy activity_slots_select_public_or_hosted
  on activity_slots for select
  to anon, authenticated
  using (
    is_activity_published(activity_id)
    or is_activity_host(activity_id, auth.uid())
  );

create policy activity_slots_insert_hosted
  on activity_slots for insert
  to authenticated
  with check (is_activity_host(activity_id, auth.uid()));

create policy activity_slots_update_hosted
  on activity_slots for update
  to authenticated
  using (is_activity_host(activity_id, auth.uid()))
  with check (is_activity_host(activity_id, auth.uid()));

create policy activity_slots_delete_hosted
  on activity_slots for delete
  to authenticated
  using (is_activity_host(activity_id, auth.uid()));

create policy bookings_select_owned_or_hosted
  on bookings for select
  to authenticated
  using (
    explorer_id = auth.uid()
    or is_slot_activity_host(slot_id, auth.uid())
  );

create policy bookings_insert_owned
  on bookings for insert
  to authenticated
  with check (explorer_id = auth.uid());

create policy bookings_update_owned
  on bookings for update
  to authenticated
  using (explorer_id = auth.uid())
  with check (explorer_id = auth.uid());

create policy bookings_delete_owned
  on bookings for delete
  to authenticated
  using (explorer_id = auth.uid());

create policy payments_select_related
  on payments for select
  to authenticated
  using (can_read_booking(booking_id, auth.uid()));

create policy reviews_select_public_or_related
  on reviews for select
  to anon, authenticated
  using (
    is_review_public(booking_id)
    or can_read_booking(booking_id, auth.uid())
  );

create policy reviews_insert_owned
  on reviews for insert
  to authenticated
  with check (is_booking_explorer(booking_id, auth.uid()));

create policy reviews_update_owned
  on reviews for update
  to authenticated
  using (is_booking_explorer(booking_id, auth.uid()))
  with check (is_booking_explorer(booking_id, auth.uid()));

create policy reviews_delete_owned
  on reviews for delete
  to authenticated
  using (is_booking_explorer(booking_id, auth.uid()));

create policy posts_select_public_or_owned
  on posts for select
  to anon, authenticated
  using (
    author_id = auth.uid()
    or linked_activity_id is null
    or is_activity_published(linked_activity_id)
    or is_activity_host(linked_activity_id, auth.uid())
  );

create policy posts_insert_owned
  on posts for insert
  to authenticated
  with check (author_id = auth.uid());

create policy posts_update_owned
  on posts for update
  to authenticated
  using (author_id = auth.uid())
  with check (author_id = auth.uid());

create policy posts_delete_owned
  on posts for delete
  to authenticated
  using (author_id = auth.uid());

create policy group_chats_select_member
  on group_chats for select
  to authenticated
  using (is_chat_member(id, auth.uid()));

create policy group_chats_insert_activity_host
  on group_chats for insert
  to authenticated
  with check (is_activity_host(activity_id, auth.uid()));

create policy group_chats_update_activity_host
  on group_chats for update
  to authenticated
  using (is_activity_host(activity_id, auth.uid()))
  with check (is_activity_host(activity_id, auth.uid()));

create policy group_chats_delete_activity_host
  on group_chats for delete
  to authenticated
  using (is_activity_host(activity_id, auth.uid()));

create policy chat_members_select_chat_member
  on chat_members for select
  to authenticated
  using (
    profile_id = auth.uid()
    or is_chat_member(chat_id, auth.uid())
  );

create policy chat_members_insert_owned
  on chat_members for insert
  to authenticated
  with check (profile_id = auth.uid());

create policy chat_members_update_owned
  on chat_members for update
  to authenticated
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

create policy chat_members_delete_owned
  on chat_members for delete
  to authenticated
  using (profile_id = auth.uid());

create policy messages_select_chat_member
  on messages for select
  to authenticated
  using (is_chat_member(chat_id, auth.uid()));

create policy messages_insert_sender
  on messages for insert
  to authenticated
  with check (
    sender_id = auth.uid()
    and is_chat_member(chat_id, auth.uid())
  );

create policy messages_update_sender
  on messages for update
  to authenticated
  using (sender_id = auth.uid())
  with check (
    sender_id = auth.uid()
    and is_chat_member(chat_id, auth.uid())
  );

create policy messages_delete_sender
  on messages for delete
  to authenticated
  using (sender_id = auth.uid());

create policy domain_events_service_role_only
  on domain_events for all
  to service_role
  using (true)
  with check (true);

grant usage on schema public to anon, authenticated, service_role;

grant select on profiles, host_profiles, activities, activity_slots, reviews, posts
  to anon, authenticated;
grant select on bookings, payments, group_chats, chat_members, messages
  to authenticated;

grant insert, update, delete on profiles, host_profiles, activities, activity_slots,
  bookings, reviews, posts, group_chats, chat_members, messages
  to authenticated;

grant select, insert, update, delete on profiles, host_profiles, activities, activity_slots,
  bookings, payments, reviews, posts, group_chats, chat_members, messages
  to service_role;

grant select, insert, update, delete on domain_events to service_role;
grant usage, select on sequence domain_events_id_seq to service_role;
