drop policy if exists messages_select_chat_member on messages;
create policy messages_select_chat_member
  on messages for select
  to authenticated
  using (is_chat_member(chat_id, auth.uid()));

drop policy if exists posts_select_public_or_owned on posts;
create policy posts_select_public_or_owned
  on posts for select
  to anon, authenticated
  using (
    author_id = auth.uid()
    or linked_activity_id is null
    or is_activity_published(linked_activity_id)
    or is_activity_host(linked_activity_id, auth.uid())
  );

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

drop index if exists messages_visible_chat_created_at_idx;
drop index if exists posts_visible_created_at_idx;
drop index if exists messages_moderation_status_idx;
drop index if exists posts_moderation_status_idx;

alter table messages
  drop column if exists is_hidden,
  drop column if exists moderation_status;

alter table posts
  drop column if exists is_hidden,
  drop column if exists moderation_status;

drop type if exists moderation_status;
