create table follows (
  follower_id uuid not null references profiles (id) on delete cascade,
  followee_id uuid not null references profiles (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (follower_id, followee_id),
  constraint follows_no_self check (follower_id <> followee_id)
);
create index follows_followee_id_created_at_idx on follows (followee_id, created_at desc);
create index follows_follower_id_created_at_idx on follows (follower_id, created_at desc);

alter table follows enable row level security;

create policy follows_select_public
  on follows for select to anon, authenticated
  using (true);

create policy follows_insert_owned
  on follows for insert to authenticated
  with check (follower_id = auth.uid());

create policy follows_delete_owned
  on follows for delete to authenticated
  using (follower_id = auth.uid());

grant select on follows to anon, authenticated;
grant insert, delete on follows to authenticated;
grant select, insert, delete on follows to service_role;
