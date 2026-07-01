import { UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';

import { ACTIVITIES_REPOSITORY } from '../src/activities/activities.constants';
import { ActivitiesModule } from '../src/activities/activities.module';
import type {
  ActivitiesRepository,
  ActivityDetailResponse,
  ActivityMedia,
  ActivityRecord,
  ActivityResponse,
  ActivitySlotRecord,
  ActivityVibeResponse,
  CreateActivityInput,
  CreateSlotInput,
  FairnessComputation,
  GeoPoint,
  HostedActivityResponse,
  NearbyActivitiesQuery,
  NearbyActivityResponse,
  UpdateActivityInput,
  UpdateSlotInput
} from '../src/activities/activities.types';
import { AuthService } from '../src/auth/auth.service';
import type { AuthenticatedUser } from '../src/auth/auth.types';

class FakeAuthService {
  constructor(private readonly profileIdsByToken: ReadonlyMap<string, string>) {}

  authenticateAccessToken(accessToken: string): AuthenticatedUser {
    const profileId = this.profileIdsByToken.get(accessToken);

    if (profileId === undefined) {
      throw new UnauthorizedException('Invalid access token');
    }

    return { profileId };
  }
}

interface FakeDomainEvent {
  aggregate_type: 'activity';
  aggregate_id: string;
  event_type: 'activity.published' | 'activity.updated';
  payload: Record<string, unknown>;
}

class FakeActivitiesRepository implements ActivitiesRepository {
  private readonly hostIds = new Set<string>();
  private readonly activities = new Map<string, ActivityRecord>();
  private readonly slots = new Map<string, ActivitySlotRecord>();
  private readonly domainEvents: FakeDomainEvent[] = [];

  reset(): void {
    this.hostIds.clear();
    this.activities.clear();
    this.slots.clear();
    this.domainEvents.length = 0;
  }

  addHost(profileId: string): void {
    this.hostIds.add(profileId);
  }

  addPublishedActivity(input: Omit<CreateActivityInput, 'media'> & { host_id: string }): string {
    const activity = this.newActivity(input.host_id, { ...input, media: [] }, 'published');

    this.activities.set(activity.id, cloneActivity(activity));

    return activity.id;
  }

  addSlot(activityId: string, input: CreateSlotInput): string {
    const slot = this.newSlot(activityId, input);

    this.slots.set(slot.id, cloneSlot(slot));

    return slot.id;
  }

  domainEventsFor(activityId: string): FakeDomainEvent[] {
    return this.domainEvents.filter((event) => event.aggregate_id === activityId);
  }

  async createActivity(
    hostId: string,
    input: CreateActivityInput
  ): Promise<ActivityResponse | undefined> {
    if (!this.hostIds.has(hostId)) {
      return undefined;
    }

    const activity = this.newActivity(hostId, input, 'draft');

    this.activities.set(activity.id, cloneActivity(activity));

    return this.toActivityResponse(activity, this.computeFairness(input).category_median_inr);
  }

  async updateActivity(
    activityId: string,
    ownerId: string,
    input: UpdateActivityInput
  ): Promise<ActivityResponse | undefined> {
    const activity = this.activities.get(activityId);

    if (activity === undefined || activity.host_id !== ownerId) {
      return undefined;
    }

    const updatedActivity: ActivityRecord = {
      ...activity,
      title: input.title ?? activity.title,
      description: input.description ?? activity.description,
      pillar: input.pillar ?? activity.pillar,
      category: input.category ?? activity.category,
      meeting_point: input.meeting_point ?? activity.meeting_point,
      location: input.location ?? activity.location,
      base_price_inr: input.base_price_inr ?? activity.base_price_inr,
      capacity: input.capacity ?? activity.capacity,
      media: input.media ?? activity.media,
      updated_at: '2026-06-17T06:00:00.000Z'
    };
    const fairness = this.computeFairness(updatedActivity, activityId);
    updatedActivity.fairness_score = fairness.score;
    this.activities.set(activityId, cloneActivity(updatedActivity));
    this.domainEvents.push({
      aggregate_type: 'activity',
      aggregate_id: activityId,
      event_type: 'activity.updated',
      payload: {
        activity_id: activityId,
        host_id: ownerId,
        changed_fields: Object.keys(input),
        updated_at: updatedActivity.updated_at
      }
    });

    return this.toActivityResponse(updatedActivity, fairness.category_median_inr);
  }

  async publishActivity(activityId: string, ownerId: string): Promise<ActivityResponse | undefined> {
    const activity = this.activities.get(activityId);

    if (activity === undefined || activity.host_id !== ownerId) {
      return undefined;
    }

    if (activity.status === 'published') {
      return this.toActivityResponse(activity, this.computeFairness(activity, activityId).category_median_inr);
    }

    const fairness = this.computeFairness(activity, activityId);
    const publishedActivity: ActivityRecord = {
      ...activity,
      fairness_score: fairness.score,
      status: 'published',
      updated_at: '2026-06-17T06:15:00.000Z'
    };

    this.activities.set(activityId, cloneActivity(publishedActivity));
    this.domainEvents.push({
      aggregate_type: 'activity',
      aggregate_id: activityId,
      event_type: 'activity.published',
      payload: {
        activity_id: activityId,
        host_id: ownerId,
        title: publishedActivity.title,
        published_at: publishedActivity.updated_at
      }
    });

    return this.toActivityResponse(publishedActivity, fairness.category_median_inr);
  }

  async pauseActivity(activityId: string, ownerId: string): Promise<ActivityResponse | undefined> {
    return this.setStatus(activityId, ownerId, 'paused');
  }

  async archiveActivity(activityId: string, ownerId: string): Promise<ActivityResponse | undefined> {
    return this.setStatus(activityId, ownerId, 'archived');
  }

  async createSlot(
    activityId: string,
    ownerId: string,
    input: CreateSlotInput
  ): Promise<ActivitySlotRecord | undefined> {
    const activity = this.activities.get(activityId);

    if (activity === undefined || activity.host_id !== ownerId) {
      return undefined;
    }

    const slot = this.newSlot(activityId, input);

    this.slots.set(slot.id, cloneSlot(slot));

    return cloneSlot(slot);
  }

  async updateSlot(
    activityId: string,
    slotId: string,
    ownerId: string,
    input: UpdateSlotInput
  ): Promise<ActivitySlotRecord | undefined> {
    const activity = this.activities.get(activityId);
    const slot = this.slots.get(slotId);

    if (activity === undefined || slot === undefined || activity.host_id !== ownerId) {
      return undefined;
    }

    const updatedSlot: ActivitySlotRecord = {
      ...slot,
      starts_at: input.starts_at ?? slot.starts_at,
      ends_at: input.ends_at ?? slot.ends_at,
      capacity: input.capacity ?? slot.capacity,
      status: input.status ?? slot.status,
      updated_at: '2026-06-17T06:20:00.000Z'
    };

    this.slots.set(slotId, cloneSlot(updatedSlot));

    return cloneSlot(updatedSlot);
  }

  async findNearby(query: NearbyActivitiesQuery): Promise<NearbyActivityResponse[]> {
    return Array.from(this.activities.values())
      .filter((activity) => activity.status === 'published')
      .filter((activity) => query.pillar === undefined || activity.pillar === query.pillar)
      .filter((activity) => isWithinQuery(activity.location, query))
      .map((activity) => {
        const distanceOrigin = getDistanceOrigin(query);
        const distance_m = Math.round(distanceMeters(activity.location, distanceOrigin));

        return {
          ...this.toActivityResponse(activity, this.computeFairness(activity, activity.id).category_median_inr),
          distance_m,
          next_open_slot: this.nextOpenSlot(activity.id)
        };
      })
      .sort((left, right) => (left.distance_m ?? 0) - (right.distance_m ?? 0));
  }

  async findByHost(hostId: string): Promise<HostedActivityResponse[]> {
    return Array.from(this.activities.values())
      .filter((activity) => activity.host_id === hostId)
      .sort((left, right) => right.created_at.localeCompare(left.created_at))
      .map((activity) => ({
        ...this.toActivityResponse(activity, this.computeFairness(activity, activity.id).category_median_inr),
        next_open_slot: this.nextOpenSlot(activity.id)
      }));
  }

  async getActivityDetail(activityId: string): Promise<ActivityDetailResponse | undefined> {
    const activity = this.activities.get(activityId);

    if (activity === undefined || activity.status !== 'published') {
      return undefined;
    }

    return {
      ...this.toActivityResponse(activity, this.computeFairness(activity, activityId).category_median_inr),
      upcoming_open_slots: Array.from(this.slots.values())
        .filter((slot) => slot.activity_id === activityId && slot.status === 'open')
        .map(cloneSlot)
    };
  }

  private setStatus(
    activityId: string,
    ownerId: string,
    status: ActivityRecord['status']
  ): ActivityResponse | undefined {
    const activity = this.activities.get(activityId);

    if (activity === undefined || activity.host_id !== ownerId) {
      return undefined;
    }

    const updatedActivity = {
      ...activity,
      status,
      updated_at: '2026-06-17T06:30:00.000Z'
    };

    this.activities.set(activityId, cloneActivity(updatedActivity));

    return this.toActivityResponse(updatedActivity, this.computeFairness(updatedActivity, activityId).category_median_inr);
  }

  private newActivity(
    hostId: string,
    input: CreateActivityInput,
    status: ActivityRecord['status']
  ): ActivityRecord {
    const fairness = this.computeFairness(input);
    const timestamp = '2026-06-17T05:30:00.000Z';

    return {
      id: randomUUID(),
      host_id: hostId,
      title: input.title,
      description: input.description,
      pillar: input.pillar,
      category: input.category,
      meeting_point: input.meeting_point,
      location: { ...input.location },
      base_price_inr: input.base_price_inr,
      currency: 'INR',
      capacity: input.capacity,
      fairness_score: fairness.score,
      status,
      media: cloneMedia(input.media),
      created_at: timestamp,
      updated_at: timestamp
    };
  }

  private newSlot(activityId: string, input: CreateSlotInput): ActivitySlotRecord {
    const timestamp = '2026-06-17T05:35:00.000Z';

    return {
      id: randomUUID(),
      activity_id: activityId,
      starts_at: input.starts_at,
      ends_at: input.ends_at,
      capacity: input.capacity,
      booked_count: 0,
      status: 'open',
      created_at: timestamp,
      updated_at: timestamp
    };
  }

  private computeFairness(
    input: Pick<CreateActivityInput, 'base_price_inr' | 'category' | 'pillar'>,
    excludeActivityId?: string
  ): FairnessComputation {
    const publishedActivities = Array.from(this.activities.values()).filter(
      (activity) => activity.status === 'published' && activity.id !== excludeActivityId
    );
    const categoryPrices = publishedActivities
      .filter((activity) => activity.category === input.category)
      .map((activity) => activity.base_price_inr);
    const pillarPrices = publishedActivities
      .filter((activity) => activity.pillar === input.pillar)
      .map((activity) => activity.base_price_inr);
    const medianPrice = median(categoryPrices) ?? median(pillarPrices);

    return {
      score: fairnessScore(input.base_price_inr, medianPrice),
      category_median_inr: medianPrice
    };
  }

  private toActivityResponse(
    activity: ActivityRecord,
    categoryMedianInr: number | null
  ): ActivityResponse {
    return {
      ...cloneActivity(activity),
      fairness: {
        score: activity.fairness_score,
        category_median_inr: categoryMedianInr,
        suggestion:
          categoryMedianInr === null
            ? 'No comparable published activities yet; keep this as a starting point.'
            : `Similar activities are around INR ${categoryMedianInr}.`
      }
    };
  }

  private nextOpenSlot(activityId: string): ActivitySlotRecord | null {
    const slot = Array.from(this.slots.values())
      .filter((candidate) => candidate.activity_id === activityId && candidate.status === 'open')
      .sort((left, right) => left.starts_at.localeCompare(right.starts_at))[0];

    return slot === undefined ? null : cloneSlot(slot);
  }
}

describe('Activities module', () => {
  let app: NestFastifyApplication;
  let activitiesRepository: FakeActivitiesRepository;
  let fetchMock: jest.Mock<Promise<Response>, Parameters<typeof fetch>>;

  const hostProfileId = randomUUID();
  const explorerProfileId = randomUUID();
  const hostToken = 'host-token';
  const explorerToken = 'explorer-token';
  const previousAiBaseUrl = process.env.AI_BASE_URL;
  const previousAiInternalToken = process.env.AI_INTERNAL_TOKEN;
  const originalFetch = global.fetch;

  beforeAll(async () => {
    process.env.AI_BASE_URL = 'http://ai.test';
    process.env.AI_INTERNAL_TOKEN = 'test-internal-token';

    fetchMock = jest.fn<Promise<Response>, Parameters<typeof fetch>>();
    global.fetch = fetchMock as typeof fetch;

    activitiesRepository = new FakeActivitiesRepository();

    const moduleRef = await Test.createTestingModule({
      imports: [ActivitiesModule]
    })
      .overrideProvider(AuthService)
      .useValue(
        new FakeAuthService(
          new Map([
            [hostToken, hostProfileId],
            [explorerToken, explorerProfileId]
          ])
        )
      )
      .overrideProvider(ACTIVITIES_REPOSITORY)
      .useValue(activitiesRepository)
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(
      new ValidationPipe({
        forbidNonWhitelisted: true,
        transform: true,
        whitelist: true
      })
    );

    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  beforeEach(() => {
    activitiesRepository.reset();
    activitiesRepository.addHost(hostProfileId);
    fetchMock.mockReset();
  });

  afterAll(async () => {
    global.fetch = originalFetch;
    restoreEnv('AI_BASE_URL', previousAiBaseUrl);
    restoreEnv('AI_INTERNAL_TOKEN', previousAiInternalToken);
    await app.close();
  });

  it('returns Nandi Hills within 30km and excludes far activities', async () => {
    const nandiActivityId = activitiesRepository.addPublishedActivity({
      host_id: hostProfileId,
      title: "Hemant's Nandi Hills sunrise trail ride",
      description: 'A supported early morning trail ride.',
      pillar: 'move',
      category: 'cycling',
      meeting_point: 'Nandi Hills base parking',
      location: { lat: 13.3702, lng: 77.6835 },
      base_price_inr: 1499,
      capacity: 12
    });
    activitiesRepository.addSlot(nandiActivityId, {
      starts_at: '2030-01-05T00:30:00.000Z',
      ends_at: '2030-01-05T04:00:00.000Z',
      capacity: 12
    });
    activitiesRepository.addPublishedActivity({
      host_id: hostProfileId,
      title: 'Mysuru palace yoga morning',
      description: 'A far-away control activity.',
      pillar: 'move',
      category: 'yoga',
      meeting_point: 'Mysuru Palace north gate',
      location: { lat: 12.3052, lng: 76.6552 },
      base_price_inr: 499,
      capacity: 15
    });

    const response = await app.inject({
      method: 'GET',
      url: '/activities/nearby?lat=13.3702&lng=77.6835&radiusKm=30&pillar=move'
    });

    expect(response.statusCode).toBe(200);

    const activities = response.json() as NearbyActivityResponse[];
    const titles = activities.map((activity) => activity.title);

    expect(titles).toContain("Hemant's Nandi Hills sunrise trail ride");
    expect(titles).not.toContain('Mysuru palace yoga morning');

    const nandiActivity = activities.find((activity) => activity.id === nandiActivityId);

    expect(nandiActivity?.distance_m).toBeLessThan(100);
    expect(nandiActivity?.next_open_slot).toMatchObject({
      activity_id: nandiActivityId,
      status: 'open'
    });
  });

  it('scores an over-priced activity lower than a median-priced one', async () => {
    activitiesRepository.addPublishedActivity({
      host_id: hostProfileId,
      title: 'Benchmark cycling ride',
      description: 'Published benchmark for cycling fairness.',
      pillar: 'move',
      category: 'cycling',
      meeting_point: 'Cubbon Park',
      location: { lat: 12.9763, lng: 77.5929 },
      base_price_inr: 1000,
      capacity: 10
    });

    const medianResponse = await app.inject({
      method: 'POST',
      url: '/activities',
      headers: {
        authorization: `Bearer ${hostToken}`
      },
      payload: activityPayload({
        title: 'Median cycling ride',
        basePriceInr: 1000
      })
    });
    const overpricedResponse = await app.inject({
      method: 'POST',
      url: '/activities',
      headers: {
        authorization: `Bearer ${hostToken}`
      },
      payload: activityPayload({
        title: 'Over-priced cycling ride',
        basePriceInr: 3000
      })
    });

    expect(medianResponse.statusCode).toBe(201);
    expect(overpricedResponse.statusCode).toBe(201);

    const medianActivity = medianResponse.json() as ActivityResponse;
    const overpricedActivity = overpricedResponse.json() as ActivityResponse;

    expect(medianActivity.fairness_score).toBe(100);
    expect(overpricedActivity.fairness_score).toBeLessThan(medianActivity.fairness_score);
    expect(overpricedActivity.fairness).toMatchObject({
      score: overpricedActivity.fairness_score,
      category_median_inr: 1000
    });
  });

  it('proxies activity vibe without leaking phone numbers', async () => {
    const activityId = randomUUID();
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          activity_id: activityId,
          title: 'Nandi Hills sunrise trail ride',
          pillar: 'move',
          participant_count: 3,
          people: [
            {
              display_name: 'Hemant Rao',
              role: 'host',
              phone: '+919900000001'
            },
            {
              display_name: 'Nisha Pai',
              role: 'attendee'
            }
          ],
          shared_interests: [
            {
              tag: 'cycling',
              count: 2
            },
            {
              tag: 'trails',
              count: 2
            }
          ],
          phone_numbers: ['+919900000001'],
          summary: "You'll meet Hemant Rao and Nisha Pai. Call +919900000001."
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' }
        }
      )
    );

    const response = await app.inject({
      method: 'GET',
      url: `/activities/${activityId}/vibe`
    });

    expect(response.statusCode).toBe(200);

    const vibe = response.json() as ActivityVibeResponse;
    expect(vibe.shared_interests.map((interest) => interest.tag)).toEqual(['cycling', 'trails']);
    expect(vibe.people).toEqual([
      {
        display_name: 'Hemant Rao',
        role: 'host'
      },
      {
        display_name: 'Nisha Pai',
        role: 'attendee'
      }
    ]);
    expect(response.body).not.toContain('+919900000001');
    expect(response.body).not.toContain('phone');
    expect(fetchMock).toHaveBeenCalledWith(
      `http://ai.test/internal/activities/${activityId}/vibe`,
      {
        method: 'GET',
        headers: {
          authorization: 'Bearer test-internal-token'
        }
      }
    );
  });

  it('returns the current host activities across statuses with next slots', async () => {
    const draftResponse = await app.inject({
      method: 'POST',
      url: '/activities',
      headers: {
        authorization: `Bearer ${hostToken}`
      },
      payload: activityPayload({
        title: "Hemant's Nandi Hills sunrise trail ride",
        basePriceInr: 1499
      })
    });
    const publishedResponse = await app.inject({
      method: 'POST',
      url: '/activities',
      headers: {
        authorization: `Bearer ${hostToken}`
      },
      payload: activityPayload({
        title: "Hemant's Cubbon Park skills ride",
        basePriceInr: 999
      })
    });

    expect(draftResponse.statusCode).toBe(201);
    expect(publishedResponse.statusCode).toBe(201);

    const draftActivity = draftResponse.json() as ActivityResponse;
    const publishedActivity = publishedResponse.json() as ActivityResponse;

    const draftSlotResponse = await app.inject({
      method: 'POST',
      url: `/activities/${draftActivity.id}/slots`,
      headers: {
        authorization: `Bearer ${hostToken}`
      },
      payload: {
        startsAt: '2030-01-05T00:30:00.000Z',
        endsAt: '2030-01-05T04:00:00.000Z',
        capacity: 12
      }
    });
    const publishedSlotResponse = await app.inject({
      method: 'POST',
      url: `/activities/${publishedActivity.id}/slots`,
      headers: {
        authorization: `Bearer ${hostToken}`
      },
      payload: {
        startsAt: '2030-01-06T00:30:00.000Z',
        endsAt: '2030-01-06T04:00:00.000Z',
        capacity: 10
      }
    });
    const publishResponse = await app.inject({
      method: 'POST',
      url: `/activities/${publishedActivity.id}/publish`,
      headers: {
        authorization: `Bearer ${hostToken}`
      }
    });

    expect(draftSlotResponse.statusCode).toBe(201);
    expect(publishedSlotResponse.statusCode).toBe(201);
    expect(publishResponse.statusCode).toBe(200);

    const hemantResponse = await app.inject({
      method: 'GET',
      url: '/activities/mine',
      headers: {
        authorization: `Bearer ${hostToken}`
      }
    });
    const snehaResponse = await app.inject({
      method: 'GET',
      url: '/activities/mine',
      headers: {
        authorization: `Bearer ${explorerToken}`
      }
    });

    expect(hemantResponse.statusCode).toBe(200);
    expect(snehaResponse.statusCode).toBe(200);

    const hemantActivities = hemantResponse.json() as HostedActivityResponse[];
    const snehaActivities = snehaResponse.json() as HostedActivityResponse[];

    expect(hemantActivities).toHaveLength(2);
    expect(snehaActivities).toHaveLength(0);
    expect(hemantActivities.map((activity) => activity.title)).toEqual(
      expect.arrayContaining([
        "Hemant's Nandi Hills sunrise trail ride",
        "Hemant's Cubbon Park skills ride"
      ])
    );
    expect(hemantActivities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: draftActivity.id,
          status: 'draft',
          next_open_slot: expect.objectContaining({
            activity_id: draftActivity.id,
            status: 'open'
          })
        }),
        expect.objectContaining({
          id: publishedActivity.id,
          status: 'published',
          next_open_slot: expect.objectContaining({
            activity_id: publishedActivity.id,
            status: 'open'
          })
        })
      ])
    );
  });

  it('publishing inserts exactly one domain event for the activity', async () => {
    const createResponse = await app.inject({
      method: 'POST',
      url: '/activities',
      headers: {
        authorization: `Bearer ${hostToken}`
      },
      payload: activityPayload({
        title: 'Draft sunrise ride',
        basePriceInr: 1200
      })
    });
    const createdActivity = createResponse.json() as ActivityResponse;

    expect(createResponse.statusCode).toBe(201);
    expect(activitiesRepository.domainEventsFor(createdActivity.id)).toHaveLength(0);

    const publishResponse = await app.inject({
      method: 'POST',
      url: `/activities/${createdActivity.id}/publish`,
      headers: {
        authorization: `Bearer ${hostToken}`
      }
    });
    const secondPublishResponse = await app.inject({
      method: 'POST',
      url: `/activities/${createdActivity.id}/publish`,
      headers: {
        authorization: `Bearer ${hostToken}`
      }
    });

    expect(publishResponse.statusCode).toBe(200);
    expect(secondPublishResponse.statusCode).toBe(200);
    expect(publishResponse.json()).toMatchObject({
      id: createdActivity.id,
      status: 'published'
    });
    expect(activitiesRepository.domainEventsFor(createdActivity.id)).toEqual([
      expect.objectContaining({
        aggregate_type: 'activity',
        aggregate_id: createdActivity.id,
        event_type: 'activity.published'
      })
    ]);
  });
});

function activityPayload(overrides: { title: string; basePriceInr: number }): Record<string, unknown> {
  return {
    title: overrides.title,
    description: 'A practical route session for Bengaluru riders.',
    pillar: 'move',
    category: 'cycling',
    meetingPoint: 'Nandi Hills base parking',
    location: {
      lat: 13.3702,
      lng: 77.6835
    },
    basePriceInr: overrides.basePriceInr,
    capacity: 12,
    media: []
  };
}

function restoreEnv(name: string, originalValue: string | undefined): void {
  if (originalValue === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = originalValue;
}

function cloneActivity(activity: ActivityRecord): ActivityRecord {
  return {
    ...activity,
    location: { ...activity.location },
    media: cloneMedia(activity.media)
  };
}

function cloneSlot(slot: ActivitySlotRecord): ActivitySlotRecord {
  return { ...slot };
}

function cloneMedia(media: ActivityMedia): ActivityMedia {
  return JSON.parse(JSON.stringify(media)) as ActivityMedia;
}

function isWithinQuery(location: GeoPoint, query: NearbyActivitiesQuery): boolean {
  if (
    query.north !== undefined &&
    query.south !== undefined &&
    query.east !== undefined &&
    query.west !== undefined
  ) {
    return (
      location.lat <= query.north &&
      location.lat >= query.south &&
      location.lng <= query.east &&
      location.lng >= query.west
    );
  }

  if (query.lat === undefined || query.lng === undefined) {
    return false;
  }

  return distanceMeters(location, { lat: query.lat, lng: query.lng }) <= query.radius_km * 1000;
}

function getDistanceOrigin(query: NearbyActivitiesQuery): GeoPoint {
  if (query.lat !== undefined && query.lng !== undefined) {
    return { lat: query.lat, lng: query.lng };
  }

  if (
    query.north !== undefined &&
    query.south !== undefined &&
    query.east !== undefined &&
    query.west !== undefined
  ) {
    return {
      lat: (query.north + query.south) / 2,
      lng: (query.east + query.west) / 2
    };
  }

  return { lat: 0, lng: 0 };
}

function distanceMeters(left: GeoPoint, right: GeoPoint): number {
  const earthRadiusMeters = 6_371_000;
  const deltaLat = toRadians(right.lat - left.lat);
  const deltaLng = toRadians(right.lng - left.lng);
  const leftLat = toRadians(left.lat);
  const rightLat = toRadians(right.lat);
  const haversine =
    Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
    Math.cos(leftLat) *
      Math.cos(rightLat) *
      Math.sin(deltaLng / 2) *
      Math.sin(deltaLng / 2);

  return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  const sortedValues = [...values].sort((left, right) => left - right);
  const middleIndex = Math.floor(sortedValues.length / 2);

  if (sortedValues.length % 2 === 1) {
    return sortedValues[middleIndex] ?? null;
  }

  const left = sortedValues[middleIndex - 1];
  const right = sortedValues[middleIndex];

  if (left === undefined || right === undefined) {
    return null;
  }

  return (left + right) / 2;
}

function fairnessScore(basePriceInr: number, medianPrice: number | null): number {
  if (medianPrice === null || medianPrice <= 0 || basePriceInr <= medianPrice) {
    return 100;
  }

  return Math.max(0, Math.min(100, Math.round((medianPrice / basePriceInr) * 100)));
}
