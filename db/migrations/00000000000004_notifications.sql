create table notification_devices (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles (id) on delete cascade,
  token text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table notification_settings (
  profile_id uuid primary key references profiles (id) on delete cascade,
  push_muted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index notification_devices_profile_id_idx on notification_devices (profile_id);

create trigger notification_devices_set_updated_at
  before update on notification_devices
  for each row execute function set_updated_at();

create trigger notification_settings_set_updated_at
  before update on notification_settings
  for each row execute function set_updated_at();

alter table notification_devices enable row level security;
alter table notification_settings enable row level security;

create policy notification_devices_owned
  on notification_devices for all
  to authenticated
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

create policy notification_settings_owned
  on notification_settings for all
  to authenticated
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

create policy notification_devices_service_role_all
  on notification_devices for all
  to service_role
  using (true)
  with check (true);

create policy notification_settings_service_role_all
  on notification_settings for all
  to service_role
  using (true)
  with check (true);

grant select, insert, update, delete on notification_devices, notification_settings
  to authenticated, service_role;
