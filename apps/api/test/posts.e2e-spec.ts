import { UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';

import type { ActivityPillar } from '@maidan/shared';
import { AuthService } from '../src/auth/auth.service';
import type { AuthenticatedUser } from '../src/auth/auth.types';
import { FOLLOWS_REPOSITORY } from '../src/follows/follows.constants';
import type {
  FollowCounts,
  FollowCreateResult,
  FollowProfileSummaryRecord,
  FollowsRepository
} from '../src/follows/follows.types';
import { POSTS_REPOSITORY } from '../src/posts/posts.constants';
import { PostsModule } from '../src/posts/posts.module';
import type {
  CreatePostInput,
  CompactActivitySlot,
  FeedPostRecord,
  PaginatedPostsResponse,
  PostMedia,
  PostRecord,
  PostsPageInput,
  PostsRepository
} from '../src/posts/posts.types';

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

interface FakeActivity {
  id: string;
  title: string;
  pillar: ActivityPillar;
  base_price_inr: number;
  currency: 'INR';
  fairness_score: number;
  status: 'draft' | 'published' | 'paused' | 'archived';
}

interface FakeSlot {
  id: string;
  activity_id: string;
  starts_at: string;
  ends_at: string;
  capacity: number;
  booked_count: number;
  status: 'open' | 'full' | 'closed' | 'cancelled';
}

interface FakeDomainEvent {
  aggregate_type: 'post';
  aggregate_id: string;
  event_type: 'post.created';
  payload: Record<string, unknown>;
}

class FakePostsRepository implements PostsRepository {
  private readonly activities = new Map<string, FakeActivity>();
  private readonly slots = new Map<string, FakeSlot>();
  private readonly posts = new Map<string, PostRecord>();
  private readonly domainEvents: FakeDomainEvent[] = [];
  private sequence = 0;

  reset(): void {
    this.activities.clear();
    this.slots.clear();
    this.posts.clear();
    this.domainEvents.length = 0;
    this.sequence = 0;
  }

  addPublishedActivity(input: {
    title: string;
    pillar: ActivityPillar;
    base_price_inr: number;
    fairness_score: number;
  }): string {
    const id = randomUUID();

    this.activities.set(id, {
      id,
      title: input.title,
      pillar: input.pillar,
      base_price_inr: input.base_price_inr,
      currency: 'INR',
      fairness_score: input.fairness_score,
      status: 'published'
    });

    return id;
  }

  addSlot(activityId: string, input: { starts_at: string; ends_at: string }): string {
    const id = randomUUID();

    this.slots.set(id, {
      id,
      activity_id: activityId,
      starts_at: input.starts_at,
      ends_at: input.ends_at,
      capacity: 12,
      booked_count: 0,
      status: 'open'
    });

    return id;
  }

  domainEventsFor(postId: string): FakeDomainEvent[] {
    return this.domainEvents.filter((event) => event.aggregate_id === postId);
  }

  async createPost(authorId: string, input: CreatePostInput): Promise<PostRecord | undefined> {
    if (input.linked_activity_id !== null && !this.activities.has(input.linked_activity_id)) {
      return undefined;
    }

    const post: PostRecord = {
      id: randomUUID(),
      author_id: authorId,
      body: input.body,
      media: cloneMedia(input.media),
      linked_activity_id: input.linked_activity_id,
      created_at: this.nextCreatedAt()
    };

    this.posts.set(post.id, clonePost(post));
    this.domainEvents.push({
      aggregate_type: 'post',
      aggregate_id: post.id,
      event_type: 'post.created',
      payload: {
        post_id: post.id,
        author_id: authorId,
        linked_activity_id: post.linked_activity_id,
        body: post.body,
        media_count: post.media.length,
        created_at: post.created_at
      }
    });

    return clonePost(post);
  }

  async findFeed(input: PostsPageInput): Promise<FeedPostRecord[]> {
    return this.publicPosts(input);
  }

  async findFollowingFeed(
    input: PostsPageInput,
    authorIds: string[]
  ): Promise<FeedPostRecord[]> {
    const authorIdSet = new Set(authorIds);

    return this.publicPosts(input, (post) => authorIdSet.has(post.author_id));
  }

  async findProfilePosts(profileId: string, input: PostsPageInput): Promise<FeedPostRecord[]> {
    return this.publicPosts(input, (post) => post.author_id === profileId);
  }

  async deletePost(postId: string, authorId: string): Promise<boolean> {
    const post = this.posts.get(postId);

    if (post === undefined || post.author_id !== authorId) {
      return false;
    }

    this.posts.delete(postId);

    return true;
  }

  private publicPosts(
    input: PostsPageInput,
    includePost: (post: PostRecord) => boolean = () => true
  ): FeedPostRecord[] {
    return Array.from(this.posts.values())
      .filter(includePost)
      .filter((post) => post.linked_activity_id === null || this.isPublishedActivity(post.linked_activity_id))
      .map((post) => this.toFeedPost(post))
      .sort(comparePostsDesc)
      .filter((post) => isAfterCursor(post, input))
      .slice(0, input.limit);
  }

  private toFeedPost(post: PostRecord): FeedPostRecord {
    const activity =
      post.linked_activity_id === null ? undefined : this.activities.get(post.linked_activity_id);

    return {
      ...clonePost(post),
      linked_activity:
        activity === undefined || activity.status !== 'published'
          ? null
          : {
              id: activity.id,
              title: activity.title,
              pillar: activity.pillar,
              next_slot: this.nextOpenSlot(activity.id),
              price: {
                amount_inr: activity.base_price_inr,
                currency: activity.currency
              },
              fairness_score: activity.fairness_score
            }
    };
  }

  private nextOpenSlot(activityId: string): CompactActivitySlot | null {
    const slot = Array.from(this.slots.values())
      .filter(
        (candidate) =>
          candidate.activity_id === activityId &&
          candidate.status === 'open' &&
          candidate.booked_count < candidate.capacity
      )
      .sort((left, right) => left.starts_at.localeCompare(right.starts_at))[0];

    if (slot === undefined) {
      return null;
    }

    return {
      id: slot.id,
      starts_at: slot.starts_at,
      ends_at: slot.ends_at
    };
  }

  private isPublishedActivity(activityId: string): boolean {
    return this.activities.get(activityId)?.status === 'published';
  }

  private nextCreatedAt(): string {
    const createdAt = new Date(Date.UTC(2026, 5, 17, 5, 30, this.sequence));

    this.sequence += 1;

    return createdAt.toISOString();
  }
}

class EmptyFollowsRepository implements FollowsRepository {
  async createFollow(): Promise<FollowCreateResult> {
    return { status: 'followee_not_found' };
  }

  async deleteFollow(): Promise<void> {
    return undefined;
  }

  async findFollowers(): Promise<FollowProfileSummaryRecord[]> {
    return [];
  }

  async findFollowing(): Promise<FollowProfileSummaryRecord[]> {
    return [];
  }

  async findFolloweeIds(): Promise<string[]> {
    return [];
  }

  async getCounts(): Promise<FollowCounts> {
    return {
      follower_count: 0,
      following_count: 0
    };
  }

  async isFollowing(): Promise<boolean> {
    return false;
  }
}

describe('Posts module', () => {
  let app: NestFastifyApplication;
  let postsRepository: FakePostsRepository;

  const authorProfileId = randomUUID();
  const authorToken = 'author-token';

  beforeAll(async () => {
    postsRepository = new FakePostsRepository();

    const moduleRef = await Test.createTestingModule({
      imports: [PostsModule]
    })
      .overrideProvider(AuthService)
      .useValue(new FakeAuthService(new Map([[authorToken, authorProfileId]])))
      .overrideProvider(POSTS_REPOSITORY)
      .useValue(postsRepository)
      .overrideProvider(FOLLOWS_REPOSITORY)
      .useValue(new EmptyFollowsRepository())
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
    postsRepository.reset();
  });

  afterAll(async () => {
    await app.close();
  });

  it('creates a post linked to Nandi Hills and returns its activity card in the feed', async () => {
    const nandiActivityId = postsRepository.addPublishedActivity({
      title: "Hemant's Nandi Hills sunrise trail ride",
      pillar: 'move',
      base_price_inr: 1499,
      fairness_score: 94
    });
    const nextSlotId = postsRepository.addSlot(nandiActivityId, {
      starts_at: '2030-01-05T00:30:00.000Z',
      ends_at: '2030-01-05T04:00:00.000Z'
    });

    const createResponse = await app.inject({
      method: 'POST',
      url: '/posts',
      headers: {
        authorization: `Bearer ${authorToken}`
      },
      payload: {
        body: 'Scouted the Nandi foothill trail this week.',
        media: [],
        linkedActivityId: nandiActivityId
      }
    });

    expect(createResponse.statusCode).toBe(201);

    const createdPost = createResponse.json() as PostRecord;

    expect(createdPost).toMatchObject({
      author_id: authorProfileId,
      body: 'Scouted the Nandi foothill trail this week.',
      linked_activity_id: nandiActivityId
    });
    expect(postsRepository.domainEventsFor(createdPost.id)).toEqual([
      expect.objectContaining({
        aggregate_type: 'post',
        aggregate_id: createdPost.id,
        event_type: 'post.created',
        payload: expect.objectContaining({
          post_id: createdPost.id,
          linked_activity_id: nandiActivityId,
          media_count: 0
        })
      })
    ]);

    const feedResponse = await app.inject({
      method: 'GET',
      url: '/feed'
    });

    expect(feedResponse.statusCode).toBe(200);

    const feed = feedResponse.json() as PaginatedPostsResponse;

    expect(feed.next_cursor).toBeNull();
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]).toMatchObject({
      id: createdPost.id,
      author_id: authorProfileId,
      body: 'Scouted the Nandi foothill trail this week.',
      linked_activity_id: nandiActivityId,
      linked_activity: {
        id: nandiActivityId,
        title: "Hemant's Nandi Hills sunrise trail ride",
        pillar: 'move',
        next_slot: {
          id: nextSlotId,
          starts_at: '2030-01-05T00:30:00.000Z',
          ends_at: '2030-01-05T04:00:00.000Z'
        },
        price: {
          amount_inr: 1499,
          currency: 'INR'
        },
        fairness_score: 94
      }
    });
  });
});

function clonePost(post: PostRecord): PostRecord {
  return {
    ...post,
    media: cloneMedia(post.media)
  };
}

function cloneMedia(media: PostMedia): PostMedia {
  return JSON.parse(JSON.stringify(media)) as PostMedia;
}

function comparePostsDesc(left: PostRecord, right: PostRecord): number {
  const createdAtComparison = right.created_at.localeCompare(left.created_at);

  if (createdAtComparison !== 0) {
    return createdAtComparison;
  }

  return right.id.localeCompare(left.id);
}

function isAfterCursor(post: PostRecord, input: PostsPageInput): boolean {
  if (input.cursor === undefined) {
    return true;
  }

  if (post.created_at < input.cursor.created_at) {
    return true;
  }

  return post.created_at === input.cursor.created_at && post.id < input.cursor.id;
}
