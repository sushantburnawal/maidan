create type moderation_status as enum ('pending', 'ok', 'blocked');

alter table posts
  add column moderation_status moderation_status not null default 'pending',
  add column is_hidden boolean not null default false;

alter table messages
  add column moderation_status moderation_status not null default 'pending',
  add column is_hidden boolean not null default false;

create index posts_moderation_status_idx on posts (moderation_status, created_at desc);
create index messages_moderation_status_idx on messages (moderation_status, created_at desc);
create index posts_visible_created_at_idx on posts (created_at desc, id desc)
  where is_hidden = false;
create index messages_visible_chat_created_at_idx on messages (chat_id, created_at desc, id desc)
  where is_hidden = false;

create or replace function profile_has_public_post(_profile_id uuid)
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
      and p.is_hidden = false
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

drop policy posts_select_public_or_owned on posts;
create policy posts_select_public_or_owned
  on posts for select
  to anon, authenticated
  using (
    author_id = auth.uid()
    or (
      is_hidden = false
      and (
        linked_activity_id is null
        or is_activity_published(linked_activity_id)
        or is_activity_host(linked_activity_id, auth.uid())
      )
    )
  );

drop policy messages_select_chat_member on messages;
create policy messages_select_chat_member
  on messages for select
  to authenticated
  using (
    is_hidden = false
    and is_chat_member(chat_id, auth.uid())
  );
