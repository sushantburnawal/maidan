import {
  BadRequestException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  OnModuleDestroy
} from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';

import type {
  ActivityPublishedPayload,
  ActivityPillar,
  ActivityUpdatedField,
  ActivityUpdatedPayload,
  JsonValue
} from '@maidan/shared';
import type {
  ActivitiesRepository,
  ActivityDetailResponse,
  ActivityFairness,
  ActivityMedia,
  ActivityRecord,
  ActivityResponse,
  ActivitySlotRecord,
  CreateActivityInput,
  CreateSlotInput,
  FairnessComputation,
  HostedActivityResponse,
  NearbyActivitiesQuery,
  NearbyActivityResponse,
  UpdateActivityInput,
  UpdateSlotInput
} from './activities.types';
import { withCurrentCorrelation } from '../observability/request-context';

interface ActivityRow {
  id: string;
  host_id: string;
  title: string;
  description: string;
  pillar: ActivityPillar;
  category: string;
  meeting_point: string;
  location_lat: number | string;
  location_lng: number | string;
  base_price_inr: number;
  currency: 'INR';
  capacity: number;
  fairness_score: number | string;
  status: ActivityRecord['status'];
  media: JsonValue;
  created_at: Date | string;
  updated_at: Date | string;
  fairness_median_inr?: number | string | null;
}

interface ActivityWithNextSlotRow extends ActivityRow {
  next_slot_id: string | null;
  next_slot_activity_id: string | null;
  next_slot_starts_at: Date | string | null;
  next_slot_ends_at: Date | string | null;
  next_slot_capacity: number | null;
  next_slot_booked_count: number | null;
  next_slot_status: ActivitySlotRecord['status'] | null;
  next_slot_created_at: Date | string | null;
  next_slot_updated_at: Date | string | null;
}

interface NearbyActivityRow extends ActivityWithNextSlotRow {
  distance_m: number | string | null;
}

interface ActivitySlotRow {
  id: string;
  activity_id: string;
  starts_at: Date | string;
  ends_at: Date | string;
  capacity: number;
  booked_count: number;
  status: ActivitySlotRecord['status'];
  created_at: Date | string;
  updated_at: Date | string;
}

interface FairnessMedianRow {
  category_median: number | string | null;
  pillar_median: number | string | null;
}

@Injectable()
export class PostgresActivitiesRepository implements ActivitiesRepository, OnModuleDestroy {
  private pool: Pool | undefined;

  async createActivity(
    hostId: string,
    input: CreateActivityInput
  ): Promise<ActivityResponse | undefined> {
    return this.withTransaction(async (client) => {
      const fairness = await computeFairness(client, input);
      const result = await client.query<ActivityRow>(
        `
          insert into activities (
            host_id,
            title,
            description,
            pillar,
            category,
            meeting_point,
            location,
            base_price_inr,
            capacity,
            fairness_score,
            media
          )
          select
            $1,
            $2,
            $3,
            $4::activity_pillar,
            $5,
            $6,
            st_setsrid(st_makepoint($7, $8), 4326)::geography,
            $9,
            $10,
            $11,
            $12::jsonb
          where exists (
            select 1
            from host_profiles hp
            where hp.profile_id = $1
          )
          returning ${activityColumns()}
        `,
        [
          hostId,
          input.title,
          input.description,
          input.pillar,
          input.category,
          input.meeting_point,
          input.location.lng,
          input.location.lat,
          input.base_price_inr,
          input.capacity,
          fairness.score,
          JSON.stringify(input.media)
        ]
      );
      const activity = mapActivity(result.rows[0]);

      return activity === undefined
        ? undefined
        : toActivityResponse(activity, fairness.category_median_inr);
    }, 'Failed to create activity');
  }

  async updateActivity(
    activityId: string,
    ownerId: string,
    input: UpdateActivityInput
  ): Promise<ActivityResponse | undefined> {
    return this.withTransaction(async (client) => {
      const current = await selectOwnedActivityForUpdate(client, activityId, ownerId);

      if (current === undefined) {
        return undefined;
      }

      const nextActivity = applyActivityInput(current, input);
      const fairness = await computeFairness(client, nextActivity, activityId);
      const changedFields = getChangedActivityFields(current, nextActivity, input);
      const updatedActivity = await updateActivityRow(client, activityId, ownerId, input, fairness);

      if (changedFields.length > 0) {
        await insertActivityUpdatedEvent(client, updatedActivity, changedFields);
      }

      return toActivityResponse(updatedActivity, fairness.category_median_inr);
    }, 'Failed to update activity');
  }

  async publishActivity(
    activityId: string,
    ownerId: string
  ): Promise<ActivityResponse | undefined> {
    return this.withTransaction(async (client) => {
      const current = await selectOwnedActivityForUpdate(client, activityId, ownerId);

      if (current === undefined) {
        return undefined;
      }

      if (current.status === 'published') {
        const fairness = await computeFairness(client, current, activityId);

        return toActivityResponse(current, fairness.category_median_inr);
      }

      const fairness = await computeFairness(client, current, activityId);
      const updatedActivity = await updateActivityStatusRow(
        client,
        activityId,
        ownerId,
        'published',
        fairness
      );

      await insertActivityPublishedEvent(client, updatedActivity);

      return toActivityResponse(updatedActivity, fairness.category_median_inr);
    }, 'Failed to publish activity');
  }

  async pauseActivity(activityId: string, ownerId: string): Promise<ActivityResponse | undefined> {
    return this.setActivityStatus(activityId, ownerId, 'paused', 'Failed to pause activity');
  }

  async archiveActivity(
    activityId: string,
    ownerId: string
  ): Promise<ActivityResponse | undefined> {
    return this.setActivityStatus(activityId, ownerId, 'archived', 'Failed to archive activity');
  }

  async createSlot(
    activityId: string,
    ownerId: string,
    input: CreateSlotInput
  ): Promise<ActivitySlotRecord | undefined> {
    return this.withTransaction(async (client) => {
      const result = await client.query<ActivitySlotRow>(
        `
          insert into activity_slots (activity_id, starts_at, ends_at, capacity)
          select $1, $3::timestamptz, $4::timestamptz, $5
          from activities a
          where a.id = $1
            and a.host_id = $2
          returning ${slotColumns()}
        `,
        [activityId, ownerId, input.starts_at, input.ends_at, input.capacity]
      );

      return mapSlot(result.rows[0]);
    }, 'Failed to create activity slot');
  }

  async updateSlot(
    activityId: string,
    slotId: string,
    ownerId: string,
    input: UpdateSlotInput
  ): Promise<ActivitySlotRecord | undefined> {
    return this.withTransaction(async (client) => {
      const currentResult = await client.query<ActivitySlotRow>(
        `
          select ${slotColumns('s')}
          from activity_slots s
          join activities a on a.id = s.activity_id
          where s.id = $1
            and s.activity_id = $2
            and a.host_id = $3
          for update of s
        `,
        [slotId, activityId, ownerId]
      );
      const current = mapSlot(currentResult.rows[0]);

      if (current === undefined) {
        return undefined;
      }

      const nextStartsAt = input.starts_at ?? current.starts_at;
      const nextEndsAt = input.ends_at ?? current.ends_at;

      if (new Date(nextEndsAt).getTime() <= new Date(nextStartsAt).getTime()) {
        throw new BadRequestException('endsAt must be after startsAt');
      }

      if (input.capacity !== undefined && input.capacity < current.booked_count) {
        throw new BadRequestException('capacity cannot be below booked_count');
      }

      const { assignments, values } = buildUpdateSlotAssignments(input, slotId);
      const updateResult = await client.query<ActivitySlotRow>(
        `
          update activity_slots
          set ${assignments.join(', ')}
          where id = $1
          returning ${slotColumns()}
        `,
        values
      );

      return mapSlot(updateResult.rows[0]);
    }, 'Failed to update activity slot');
  }

  async findNearby(query: NearbyActivitiesQuery): Promise<NearbyActivityResponse[]> {
    try {
      const { whereSql, values, distanceSql, orderRadiusParameter } = buildNearbySqlParts(query);
      const result = await this.getPool().query<NearbyActivityRow>(
        `
          select
            ${activityColumns('a')},
            fairness.fairness_median_inr,
            ${distanceSql} as distance_m,
            next_slot.id as next_slot_id,
            next_slot.activity_id as next_slot_activity_id,
            next_slot.starts_at as next_slot_starts_at,
            next_slot.ends_at as next_slot_ends_at,
            next_slot.capacity as next_slot_capacity,
            next_slot.booked_count as next_slot_booked_count,
            next_slot.status as next_slot_status,
            next_slot.created_at as next_slot_created_at,
            next_slot.updated_at as next_slot_updated_at
          from activities a
          left join lateral (${nextOpenSlotSql('a')}) next_slot on true
          left join lateral (${fairnessMedianSql('a')}) fairness on true
          where ${whereSql}
          order by ${nearbyOrderSql(distanceSql, orderRadiusParameter)} asc,
          a.created_at desc
          limit 100
        `,
        values
      );

      return result.rows.map(mapNearbyActivity);
    } catch (error) {
      throw toRepositoryError(error, 'Failed to find nearby activities');
    }
  }

  async findByHost(hostId: string): Promise<HostedActivityResponse[]> {
    try {
      const result = await this.getPool().query<ActivityWithNextSlotRow>(
        `
          select
            ${activityColumns('a')},
            fairness.fairness_median_inr,
            next_slot.id as next_slot_id,
            next_slot.activity_id as next_slot_activity_id,
            next_slot.starts_at as next_slot_starts_at,
            next_slot.ends_at as next_slot_ends_at,
            next_slot.capacity as next_slot_capacity,
            next_slot.booked_count as next_slot_booked_count,
            next_slot.status as next_slot_status,
            next_slot.created_at as next_slot_created_at,
            next_slot.updated_at as next_slot_updated_at
          from activities a
          left join lateral (${nextOpenSlotSql('a')}) next_slot on true
          left join lateral (${fairnessMedianSql('a')}) fairness on true
          where a.host_id = $1
          order by a.created_at desc
        `,
        [hostId]
      );

      return result.rows.map(mapHostedActivity);
    } catch (error) {
      throw toRepositoryError(error, 'Failed to find hosted activities');
    }
  }

  async getActivityDetail(activityId: string): Promise<ActivityDetailResponse | undefined> {
    try {
      const activityResult = await this.getPool().query<ActivityRow>(
        `
          select
            ${activityColumns('a')},
            fairness.fairness_median_inr
          from activities a
          left join lateral (${fairnessMedianSql('a')}) fairness on true
          where a.id = $1
            and a.status = 'published'
        `,
        [activityId]
      );
      const activity = mapActivity(activityResult.rows[0]);

      if (activity === undefined) {
        return undefined;
      }

      const slotsResult = await this.getPool().query<ActivitySlotRow>(
        `
          select ${slotColumns('s')}
          from activity_slots s
          where s.activity_id = $1
            and s.status = 'open'
            and s.starts_at >= now()
            and s.booked_count < s.capacity
          order by s.starts_at asc
        `,
        [activityId]
      );

      return {
        ...toActivityResponse(
          activity,
          toNullableNumber(activityResult.rows[0]?.fairness_median_inr)
        ),
        upcoming_open_slots: slotsResult.rows.map((row) => mapSlot(row)).filter(isDefined)
      };
    } catch (error) {
      throw toRepositoryError(error, 'Failed to read activity detail');
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pool !== undefined) {
      await this.pool.end();
    }
  }

  private async setActivityStatus(
    activityId: string,
    ownerId: string,
    status: 'paused' | 'archived',
    errorMessage: string
  ): Promise<ActivityResponse | undefined> {
    return this.withTransaction(async (client) => {
      const current = await selectOwnedActivityForUpdate(client, activityId, ownerId);

      if (current === undefined) {
        return undefined;
      }

      if (current.status === status) {
        const fairness = await computeFairness(client, current, activityId);

        return toActivityResponse(current, fairness.category_median_inr);
      }

      const fairness = await computeFairness(client, current, activityId);
      const updatedActivity = await updateActivityStatusRow(
        client,
        activityId,
        ownerId,
        status,
        fairness
      );

      await insertActivityUpdatedEvent(client, updatedActivity, ['status']);

      return toActivityResponse(updatedActivity, fairness.category_median_inr);
    }, errorMessage);
  }

  private async withTransaction<T>(
    operation: (client: PoolClient) => Promise<T>,
    errorMessage: string
  ): Promise<T> {
    const client = await this.getPool().connect();

    try {
      await client.query('begin');
      const result = await operation(client);
      await client.query('commit');

      return result;
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw toRepositoryError(error, errorMessage);
    } finally {
      client.release();
    }
  }

  private getPool(): Pool {
    if (this.pool !== undefined) {
      return this.pool;
    }

    const connectionString = process.env.DATABASE_URL;

    if (connectionString === undefined || connectionString.length === 0) {
      throw new InternalServerErrorException('DATABASE_URL is not configured');
    }

    this.pool = new Pool({
      connectionString,
      ssl: process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : undefined
    });

    return this.pool;
  }
}

function activityColumns(alias?: string): string {
  const prefix = alias === undefined ? '' : `${alias}.`;

  return `
    ${prefix}id,
    ${prefix}host_id,
    ${prefix}title,
    ${prefix}description,
    ${prefix}pillar,
    ${prefix}category,
    ${prefix}meeting_point,
    st_y(${prefix}location::geometry) as location_lat,
    st_x(${prefix}location::geometry) as location_lng,
    ${prefix}base_price_inr,
    ${prefix}currency,
    ${prefix}capacity,
    ${prefix}fairness_score::float8 as fairness_score,
    ${prefix}status,
    ${prefix}media,
    ${prefix}created_at,
    ${prefix}updated_at
  `;
}

function slotColumns(alias?: string): string {
  const prefix = alias === undefined ? '' : `${alias}.`;

  return `
    ${prefix}id,
    ${prefix}activity_id,
    ${prefix}starts_at,
    ${prefix}ends_at,
    ${prefix}capacity,
    ${prefix}booked_count,
    ${prefix}status,
    ${prefix}created_at,
    ${prefix}updated_at
  `;
}

function nextOpenSlotSql(activityAlias: string): string {
  return `
    select ${slotColumns('s')}
    from activity_slots s
    where s.activity_id = ${activityAlias}.id
      and s.status = 'open'
      and s.starts_at >= now()
      and s.booked_count < s.capacity
    order by s.starts_at asc
    limit 1
  `;
}

function fairnessMedianSql(activityAlias: string): string {
  return `
    select coalesce(
      (
        select percentile_cont(0.5) within group (order by category_activity.base_price_inr)::float8
        from activities category_activity
        where category_activity.status = 'published'
          and category_activity.category = ${activityAlias}.category
          and category_activity.id <> ${activityAlias}.id
      ),
      (
        select percentile_cont(0.5) within group (order by pillar_activity.base_price_inr)::float8
        from activities pillar_activity
        where pillar_activity.status = 'published'
          and pillar_activity.pillar = ${activityAlias}.pillar
          and pillar_activity.id <> ${activityAlias}.id
      )
    ) as fairness_median_inr
  `;
}

async function selectOwnedActivityForUpdate(
  client: PoolClient,
  activityId: string,
  ownerId: string
): Promise<ActivityRecord | undefined> {
  const result = await client.query<ActivityRow>(
    `
      select ${activityColumns('a')}
      from activities a
      where a.id = $1
        and a.host_id = $2
      for update of a
    `,
    [activityId, ownerId]
  );

  return mapActivity(result.rows[0]);
}

async function updateActivityRow(
  client: PoolClient,
  activityId: string,
  ownerId: string,
  input: UpdateActivityInput,
  fairness: FairnessComputation
): Promise<ActivityRecord> {
  const assignments = ['fairness_score = $3'];
  const values: unknown[] = [activityId, ownerId, fairness.score];
  let parameterIndex = 4;

  if (input.title !== undefined) {
    assignments.push(`title = $${parameterIndex}`);
    values.push(input.title);
    parameterIndex += 1;
  }

  if (input.description !== undefined) {
    assignments.push(`description = $${parameterIndex}`);
    values.push(input.description);
    parameterIndex += 1;
  }

  if (input.pillar !== undefined) {
    assignments.push(`pillar = $${parameterIndex}::activity_pillar`);
    values.push(input.pillar);
    parameterIndex += 1;
  }

  if (input.category !== undefined) {
    assignments.push(`category = $${parameterIndex}`);
    values.push(input.category);
    parameterIndex += 1;
  }

  if (input.meeting_point !== undefined) {
    assignments.push(`meeting_point = $${parameterIndex}`);
    values.push(input.meeting_point);
    parameterIndex += 1;
  }

  if (input.location !== undefined) {
    assignments.push(
      `location = st_setsrid(st_makepoint($${parameterIndex}, $${parameterIndex + 1}), 4326)::geography`
    );
    values.push(input.location.lng, input.location.lat);
    parameterIndex += 2;
  }

  if (input.base_price_inr !== undefined) {
    assignments.push(`base_price_inr = $${parameterIndex}`);
    values.push(input.base_price_inr);
    parameterIndex += 1;
  }

  if (input.capacity !== undefined) {
    assignments.push(`capacity = $${parameterIndex}`);
    values.push(input.capacity);
    parameterIndex += 1;
  }

  if (input.media !== undefined) {
    assignments.push(`media = $${parameterIndex}::jsonb`);
    values.push(JSON.stringify(input.media));
  }

  const result = await client.query<ActivityRow>(
    `
      update activities
      set ${assignments.join(', ')}
      where id = $1
        and host_id = $2
      returning ${activityColumns()}
    `,
    values
  );
  const activity = mapActivity(result.rows[0]);

  if (activity === undefined) {
    throw new InternalServerErrorException('Updated activity was not returned');
  }

  return activity;
}

async function updateActivityStatusRow(
  client: PoolClient,
  activityId: string,
  ownerId: string,
  status: ActivityRecord['status'],
  fairness: FairnessComputation
): Promise<ActivityRecord> {
  const result = await client.query<ActivityRow>(
    `
      update activities
      set status = $3::activity_status,
          fairness_score = $4
      where id = $1
        and host_id = $2
      returning ${activityColumns()}
    `,
    [activityId, ownerId, status, fairness.score]
  );
  const activity = mapActivity(result.rows[0]);

  if (activity === undefined) {
    throw new InternalServerErrorException('Updated activity was not returned');
  }

  return activity;
}

function buildUpdateSlotAssignments(
  input: UpdateSlotInput,
  slotId: string
): { assignments: string[]; values: unknown[] } {
  const assignments: string[] = [];
  const values: unknown[] = [slotId];
  let parameterIndex = 2;

  if (input.starts_at !== undefined) {
    assignments.push(`starts_at = $${parameterIndex}::timestamptz`);
    values.push(input.starts_at);
    parameterIndex += 1;
  }

  if (input.ends_at !== undefined) {
    assignments.push(`ends_at = $${parameterIndex}::timestamptz`);
    values.push(input.ends_at);
    parameterIndex += 1;
  }

  if (input.capacity !== undefined) {
    assignments.push(`capacity = $${parameterIndex}`);
    values.push(input.capacity);
    parameterIndex += 1;
  }

  if (input.status !== undefined) {
    assignments.push(`status = $${parameterIndex}::slot_status`);
    values.push(input.status);
  }

  return { assignments, values };
}

async function computeFairness(
  client: PoolClient,
  input: Pick<CreateActivityInput, 'base_price_inr' | 'category' | 'pillar'>,
  excludeActivityId?: string
): Promise<FairnessComputation> {
  const result = await client.query<FairnessMedianRow>(
    `
      select
        (
          select percentile_cont(0.5) within group (order by category_activity.base_price_inr)::float8
          from activities category_activity
          where category_activity.status = 'published'
            and category_activity.category = $1
            and ($3::uuid is null or category_activity.id <> $3::uuid)
        ) as category_median,
        (
          select percentile_cont(0.5) within group (order by pillar_activity.base_price_inr)::float8
          from activities pillar_activity
          where pillar_activity.status = 'published'
            and pillar_activity.pillar = $2::activity_pillar
            and ($3::uuid is null or pillar_activity.id <> $3::uuid)
        ) as pillar_median
    `,
    [input.category, input.pillar, excludeActivityId ?? null]
  );
  const row = result.rows[0];
  const categoryMedian = toNullableNumber(row?.category_median);
  const pillarMedian = toNullableNumber(row?.pillar_median);
  const median = categoryMedian ?? pillarMedian;

  return {
    score: computeFairnessScore(input.base_price_inr, median),
    category_median_inr: median
  };
}

function computeFairnessScore(basePriceInr: number, median: number | null): number {
  if (median === null || median <= 0 || basePriceInr <= median) {
    return 100;
  }

  if (basePriceInr <= 0) {
    return 100;
  }

  return Math.max(0, Math.min(100, Math.round((median / basePriceInr) * 100)));
}

export function buildNearbySqlParts(query: NearbyActivitiesQuery): {
  whereSql: string;
  values: unknown[];
  distanceSql: string;
  orderRadiusParameter: number;
} {
  const values: unknown[] = [];
  const filters = [`a.status = 'published'`];
  let distanceLat = query.lat;
  let distanceLng = query.lng;
  let orderRadiusMeters = query.radius_km * 1000;

  if (isBboxQuery(query)) {
    filters.push(
      `a.location::geometry && st_makeenvelope($1, $2, $3, $4, 4326)`,
      `st_covers(st_makeenvelope($1, $2, $3, $4, 4326), a.location::geometry)`
    );
    values.push(query.west, query.south, query.east, query.north);

    if (distanceLat === undefined || distanceLng === undefined) {
      distanceLat = (query.north + query.south) / 2;
      distanceLng = (query.east + query.west) / 2;
      orderRadiusMeters = estimateBboxRadiusMeters(query);
    }
  } else if (query.lat !== undefined && query.lng !== undefined) {
    values.push(query.lng, query.lat, query.radius_km * 1000);
    filters.push(`st_dwithin(a.location, st_setsrid(st_makepoint($1, $2), 4326)::geography, $3)`);
  }

  if (query.pillar !== undefined) {
    values.push(query.pillar);
    filters.push(`a.pillar = $${values.length}::activity_pillar`);
  }

  if (distanceLat === undefined || distanceLng === undefined) {
    throw new InternalServerErrorException('Nearby query has no distance origin');
  }

  values.push(distanceLng, distanceLat, orderRadiusMeters);
  const distanceLngParameter = values.length - 2;
  const distanceLatParameter = values.length - 1;
  const orderRadiusParameter = values.length;
  const distanceSql = `st_distance(a.location, st_setsrid(st_makepoint($${distanceLngParameter}, $${distanceLatParameter}), 4326)::geography)`;

  return {
    whereSql: filters.join('\n            and '),
    values,
    distanceSql,
    orderRadiusParameter
  };
}

export function nearbyOrderSql(distanceSql: string, orderRadiusParameter: number): string {
  return `(
            (coalesce(${distanceSql}, 0::float8) / greatest($${orderRadiusParameter}::float8, 1::float8)) * 0.75
            + (least(extract(epoch from (now() - a.created_at)) / 86400, 30) / 30) * 0.25
          )`;
}

function isBboxQuery(query: NearbyActivitiesQuery): query is NearbyActivitiesQuery & {
  north: number;
  south: number;
  east: number;
  west: number;
} {
  return (
    query.north !== undefined &&
    query.south !== undefined &&
    query.east !== undefined &&
    query.west !== undefined
  );
}

function estimateBboxRadiusMeters(query: {
  north: number;
  south: number;
  east: number;
  west: number;
}): number {
  const latKm = Math.abs(query.north - query.south) * 111;
  const lngKm =
    Math.abs(query.east - query.west) *
    111 *
    Math.cos((((query.north + query.south) / 2) * Math.PI) / 180);

  return Math.max(1000, (Math.sqrt(latKm * latKm + lngKm * lngKm) * 1000) / 2);
}

function applyActivityInput(current: ActivityRecord, input: UpdateActivityInput): ActivityRecord {
  return {
    ...current,
    title: input.title ?? current.title,
    description: input.description ?? current.description,
    pillar: input.pillar ?? current.pillar,
    category: input.category ?? current.category,
    meeting_point: input.meeting_point ?? current.meeting_point,
    location: input.location ?? current.location,
    base_price_inr: input.base_price_inr ?? current.base_price_inr,
    capacity: input.capacity ?? current.capacity,
    media: input.media ?? current.media
  };
}

function getChangedActivityFields(
  current: ActivityRecord,
  nextActivity: ActivityRecord,
  input: UpdateActivityInput
): ActivityUpdatedField[] {
  const changedFields: ActivityUpdatedField[] = [];

  pushChangedField(
    changedFields,
    'title',
    input.title !== undefined && current.title !== nextActivity.title
  );
  pushChangedField(
    changedFields,
    'description',
    input.description !== undefined && current.description !== nextActivity.description
  );
  pushChangedField(
    changedFields,
    'pillar',
    input.pillar !== undefined && current.pillar !== nextActivity.pillar
  );
  pushChangedField(
    changedFields,
    'category',
    input.category !== undefined && current.category !== nextActivity.category
  );
  pushChangedField(
    changedFields,
    'meeting_point',
    input.meeting_point !== undefined && current.meeting_point !== nextActivity.meeting_point
  );
  pushChangedField(
    changedFields,
    'location',
    input.location !== undefined &&
      (current.location.lat !== nextActivity.location.lat ||
        current.location.lng !== nextActivity.location.lng)
  );
  pushChangedField(
    changedFields,
    'base_price_inr',
    input.base_price_inr !== undefined && current.base_price_inr !== nextActivity.base_price_inr
  );
  pushChangedField(
    changedFields,
    'capacity',
    input.capacity !== undefined && current.capacity !== nextActivity.capacity
  );
  pushChangedField(
    changedFields,
    'media',
    input.media !== undefined &&
      JSON.stringify(current.media) !== JSON.stringify(nextActivity.media)
  );

  return changedFields;
}

function pushChangedField(
  changedFields: ActivityUpdatedField[],
  field: ActivityUpdatedField,
  changed: boolean
): void {
  if (changed) {
    changedFields.push(field);
  }
}

async function insertActivityPublishedEvent(
  client: PoolClient,
  activity: ActivityRecord
): Promise<void> {
  const payload: ActivityPublishedPayload = {
    activity_id: activity.id,
    host_id: activity.host_id,
    title: activity.title,
    description: activity.description,
    pillar: activity.pillar,
    category: activity.category,
    meeting_point: activity.meeting_point,
    location: activity.location,
    base_price_inr: activity.base_price_inr,
    published_at: activity.updated_at
  };

  await insertDomainEvent(client, activity.id, 'activity.published', payload);
}

async function insertActivityUpdatedEvent(
  client: PoolClient,
  activity: ActivityRecord,
  changedFields: ActivityUpdatedField[]
): Promise<void> {
  const payload: ActivityUpdatedPayload = {
    activity_id: activity.id,
    host_id: activity.host_id,
    changed_fields: changedFields,
    updated_at: activity.updated_at
  };

  if (changedFields.includes('title')) {
    payload.title = activity.title;
  }

  if (changedFields.includes('description')) {
    payload.description = activity.description;
  }

  if (changedFields.includes('pillar')) {
    payload.pillar = activity.pillar;
  }

  if (changedFields.includes('category')) {
    payload.category = activity.category;
  }

  if (changedFields.includes('meeting_point')) {
    payload.meeting_point = activity.meeting_point;
  }

  if (changedFields.includes('location')) {
    payload.location = activity.location;
  }

  if (changedFields.includes('base_price_inr')) {
    payload.base_price_inr = activity.base_price_inr;
  }

  if (changedFields.includes('capacity')) {
    payload.capacity = activity.capacity;
  }

  if (changedFields.includes('status')) {
    payload.status = activity.status;
  }

  await insertDomainEvent(client, activity.id, 'activity.updated', payload);
}

async function insertDomainEvent(
  client: PoolClient,
  aggregateId: string,
  eventType: 'activity.published' | 'activity.updated',
  payload: ActivityPublishedPayload | ActivityUpdatedPayload
): Promise<void> {
  await client.query(
    `
      insert into domain_events (aggregate_type, aggregate_id, event_type, payload)
      values ('activity', $1, $2, $3::jsonb)
    `,
    [aggregateId, eventType, JSON.stringify(withCurrentCorrelation(payload))]
  );
}

function mapNearbyActivity(row: NearbyActivityRow): NearbyActivityResponse {
  return {
    ...toActivityResponse(mapRequiredActivity(row), toNullableNumber(row.fairness_median_inr)),
    distance_m: row.distance_m === null ? null : Math.round(Number(row.distance_m)),
    next_open_slot: mapNextSlot(row)
  };
}

function mapHostedActivity(row: ActivityWithNextSlotRow): HostedActivityResponse {
  return {
    ...toActivityResponse(mapRequiredActivity(row), toNullableNumber(row.fairness_median_inr)),
    next_open_slot: mapNextSlot(row)
  };
}

function mapActivity(row: ActivityRow | undefined): ActivityRecord | undefined {
  if (row === undefined) {
    return undefined;
  }

  return mapRequiredActivity(row);
}

function mapRequiredActivity(row: ActivityRow): ActivityRecord {
  return {
    id: row.id,
    host_id: row.host_id,
    title: row.title,
    description: row.description,
    pillar: row.pillar,
    category: row.category,
    meeting_point: row.meeting_point,
    location: {
      lat: Number(row.location_lat),
      lng: Number(row.location_lng)
    },
    base_price_inr: row.base_price_inr,
    currency: row.currency,
    capacity: row.capacity,
    fairness_score: Math.round(Number(row.fairness_score)),
    status: row.status,
    media: Array.isArray(row.media) ? (row.media as ActivityMedia) : [],
    created_at: toIsoTimestamp(row.created_at),
    updated_at: toIsoTimestamp(row.updated_at)
  };
}

function mapSlot(row: ActivitySlotRow | undefined): ActivitySlotRecord | undefined {
  if (row === undefined) {
    return undefined;
  }

  return {
    id: row.id,
    activity_id: row.activity_id,
    starts_at: toIsoTimestamp(row.starts_at),
    ends_at: toIsoTimestamp(row.ends_at),
    capacity: row.capacity,
    booked_count: row.booked_count,
    status: row.status,
    created_at: toIsoTimestamp(row.created_at),
    updated_at: toIsoTimestamp(row.updated_at)
  };
}

function mapNextSlot(row: ActivityWithNextSlotRow): ActivitySlotRecord | null {
  if (row.next_slot_id === null || row.next_slot_activity_id === null) {
    return null;
  }

  if (
    row.next_slot_starts_at === null ||
    row.next_slot_ends_at === null ||
    row.next_slot_capacity === null ||
    row.next_slot_booked_count === null ||
    row.next_slot_status === null ||
    row.next_slot_created_at === null ||
    row.next_slot_updated_at === null
  ) {
    return null;
  }

  return {
    id: row.next_slot_id,
    activity_id: row.next_slot_activity_id,
    starts_at: toIsoTimestamp(row.next_slot_starts_at),
    ends_at: toIsoTimestamp(row.next_slot_ends_at),
    capacity: row.next_slot_capacity,
    booked_count: row.next_slot_booked_count,
    status: row.next_slot_status,
    created_at: toIsoTimestamp(row.next_slot_created_at),
    updated_at: toIsoTimestamp(row.next_slot_updated_at)
  };
}

function toActivityResponse(
  activity: ActivityRecord,
  categoryMedianInr: number | null
): ActivityResponse {
  return {
    ...activity,
    fairness: toActivityFairness(activity.fairness_score, categoryMedianInr)
  };
}

function toActivityFairness(score: number, categoryMedianInr: number | null): ActivityFairness {
  const roundedMedian = categoryMedianInr === null ? null : Math.round(categoryMedianInr);

  return {
    score,
    category_median_inr: roundedMedian,
    suggestion: fairnessSuggestion(score, roundedMedian)
  };
}

function fairnessSuggestion(score: number, categoryMedianInr: number | null): string {
  if (categoryMedianInr === null) {
    return 'No comparable published activities yet; keep this as a starting point.';
  }

  if (score >= 90) {
    return `Pricing is in line with similar activities around INR ${categoryMedianInr}.`;
  }

  if (score >= 70) {
    return `Pricing is slightly above similar activities around INR ${categoryMedianInr}.`;
  }

  return `Similar activities are around INR ${categoryMedianInr}; consider reducing the base price.`;
}

function toNullableNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  return Number(value);
}

function toIsoTimestamp(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return new Date(value).toISOString();
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function toRepositoryError(error: unknown, message: string): HttpException {
  if (error instanceof HttpException) {
    return error;
  }

  return new InternalServerErrorException(message);
}
