Implement the **social graph** (`follows`) — a `follows` module plus its migration, shared-contract
event, and profile/feed integration. Follows are public, directed edges: `follower_id -> followee_id`.
This is a v1 feature. Treat every existing table, column, DTO, queue name, and the `withTransaction` /
`domain_events` outbox pattern as a FROZEN contract — extend, never rename or restructure. All response
additions below are ADDITIVE: keep every existing field byte-for-byte.

## Migration (new, numbered next in sequence)
Add `db/migrations/00000000000007_social_graph.sql` and its `db/rollbacks/00000000000007_social_graph.rollback.sql`,
matching the exact DDL + RLS style of `00000000000001_initial_fact_plane.sql` (lowercase, no `IF NOT EXISTS`
in the forward migration, `if exists` in the rollback):

```sql
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
```
Follows are immutable — no update policy. Composite PK gives natural idempotency.

## Shared contract (`packages/shared`) — MANDATORY, do this before wiring the API
In `src/schemas/domain-events.ts`, register a new event by mirroring `postCreatedEventSchema` exactly:

```ts
export const followCreatedPayloadSchema = z
  .object({
    follower_id: uuidSchema,
    followee_id: uuidSchema,
    created_at: timestampSchema
  })
  .strict();

export const followCreatedEventSchema = domainEventEnvelopeSchema
  .extend({
    aggregate_type: z.literal('follow'),
    event_type: z.literal('follow.created'),
    payload: followCreatedPayloadSchema
  })
  .strict();
```
Add `followCreatedEventSchema` to the `domainEventSchema` discriminated union, add `'follow.created'`
to the `domainEventTypeSchema` enum, and export `FollowCreatedPayload`. Envelope `aggregate_id` = the
`followee_id` (the profile gaining the follower). Add follow entity/DTO/response types to `entities.ts` /
`dtos.ts` so the API imports compile-checked field names. Then run `pnpm --filter @maidan/shared build`
— this regenerates `packages/shared/contracts/events.schema.json`, which the FastAPI consumer validates
against. **If `follow.created` is not in the regenerated JSON schema, the AI event-bus dead-letters it as
invalid** (same class as the `correlation_id` / `additionalProperties:false` failure already solved in the
meaning plane). Do NOT hand-add `correlation_id` to the payload anywhere — the outbox relay adds and the
consumer strips it via the existing projection; the repository writes the clean domain payload only.

## API — new `follows` module (mirror the `posts` module structure exactly)
Controller/service/repository/dto/types under `apps/api/src/follows`, using the shared DB helper
(`withTransaction` / `getPool`) and the same connection/role the `posts` and `profiles` repositories use —
introduce no new DB client or auth-context mechanism. Auth via `JwtAuthGuard` + `@CurrentUser('profileId')`.

- `POST /profiles/:id/follow` (auth) — current user follows `:id`. Idempotent: `insert into follows ...
  on conflict (follower_id, followee_id) do nothing`. In the SAME transaction, only when a row was newly
  inserted, `insert into domain_events (aggregate_type, aggregate_id, event_type, payload)` with
  `('follow', <followee_id>, 'follow.created', {follower_id, followee_id, created_at})`. Self-follow → 400.
  Following someone who doesn't exist → 404. Return `204`. No event on the no-op re-follow.
- `DELETE /profiles/:id/follow` (auth) — unfollow. Delete if present, `204` regardless (idempotent).
  No domain event (mirrors `DELETE /posts/:id` emitting nothing).
- `GET /profiles/:id/followers` — cursor-paginated public profile summaries of who follows `:id`,
  ordered `follows.created_at desc`. Reuse the `PostsPageQueryDto` cursor/limit convention. When the
  request is authenticated, include `is_following` per row (does the caller follow that profile).
- `GET /profiles/:id/following` — same shape, the profiles `:id` follows.

## API — additive profile + feed integration (extend, do not restructure)
- Add an `OptionalJwtAuthGuard` to `apps/api/src/auth` that resolves `@CurrentUser('profileId')` when a
  valid Bearer token is present and NEVER rejects when it is absent. Apply it to the existing
  `GET /profiles/:id` route only.
- Extend the `GET /profiles/:id` (public) response with `follower_count`, `following_count`, and
  `is_following` (present only when a viewer is resolved; false/absent for anonymous). Extend
  `GET /profiles/me` with `follower_count` and `following_count` (no `is_following` for self). Compute
  these via the follows repository — `ProfilesModule` imports `FollowsModule` and injects the follows
  service; keep every existing `PublicProfileRecord` / `PrivateProfileRecord` field unchanged.
- Extend `GET /feed`: add an optional `scope` of `'global' | 'following'` to `PostsPageQueryDto`,
  defaulting to `'global'` so the existing feed path is byte-for-byte unchanged. When `scope=following`
  (require auth), return only posts authored by profiles the current user follows — same reverse-chron
  order, same cursor pagination, same embedded activity-card payload as today. `PostsModule` imports
  `FollowsModule` for the follow lookup. No circular imports (`follows` depends on neither `posts` nor
  the profiles service).

## Known facts / landmines
- Unregistered event types dead-letter at the AI consumer — the shared-contract step above is not optional.
- Every business write the AI plane cares about goes to `domain_events` in the SAME transaction as the row;
  services never call the queue directly (AGENTS.md). `follow.created` follows this rule.
- RLS is enabled on all tables and policies use `auth.uid()`; replicate the `posts` policy style exactly
  and use the identical DB-access path the existing modules use so follow behaves identically under RLS.
- The migration runner has no `schema_migrations` ledger (it replays raw SQL); ship the numbered forward +
  rollback files in the existing style and apply via the project's existing migration workflow. Do not add
  divergent `IF NOT EXISTS` guards to the forward migration.

## Out of scope — do NOT build (STOP when DoD passes)
- No "Find People" discovery/ranking endpoint (separate follow-on).
- No AI matchmaking or demand-sensing on the graph — that belongs to the matchmaker. This prompt only
  requires that the FastAPI consumer ACCEPTS `follow.created` as valid and ACKS it as a no-op (it must not
  appear in the dead-letter stream); add no handler logic.
- No reviews/reliability wiring, no notifications on follow.

## Definition of Done — `apps/api/test/follows.e2e-spec.ts` (mirror `posts.e2e-spec.ts`), using the
canonical profiles Hemant (host of the Nandi Hills sunrise trail ride), Sneha (explorer), and Priya (non-follower):
1. Sneha `POST /profiles/{hemant}/follow` → 204; `GET /profiles/{hemant}/followers` includes Sneha;
   `GET /profiles/{sneha}/following` includes Hemant; `GET /profiles/{hemant}` as Sneha shows
   `follower_count === 1` and `is_following === true`; the same call anonymous shows `follower_count === 1`
   and no/`false` `is_following`.
2. Idempotent re-follow: Sneha follows Hemant again → 204; `follower_count` stays 1; exactly ONE
   `domain_events` row exists with `event_type = 'follow.created'`, `aggregate_type = 'follow'`,
   `aggregate_id = {hemant}`, and payload `{follower_id: {sneha}, followee_id: {hemant}, ...}`.
3. Self-follow: Hemant `POST /profiles/{hemant}/follow` → 400; no row, no event.
4. Following feed: Hemant creates a post linked to the Nandi ride; Sneha `GET /feed?scope=following`
   returns it with the embedded activity card; Priya `GET /feed?scope=following` does not; `GET /feed`
   (no scope) returns it for all three (unchanged global behavior).
5. Unfollow: Sneha `DELETE /profiles/{hemant}/follow` → 204; followers list excludes Sneha;
   `follower_count === 0`; Sneha `GET /feed?scope=following` no longer returns Hemant's post.
6. `follow.created` is accepted by the AI event consumer and does not land in the dead-letter stream.

Leave the repo green: `pnpm --filter @maidan/shared build`, the new e2e spec, and the existing suites all pass.
