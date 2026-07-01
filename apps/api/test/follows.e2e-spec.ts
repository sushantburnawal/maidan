import { UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';

import type { ActivityPillar } from '@maidan/shared';
import { AuthService } from '../src/auth/auth.service';
import type { AuthenticatedUser } from '../src/auth/auth.types';
import { FOLLOWS_REPOSITORY } from '../src/follows/follows.constants';
import { FollowsModule } from '../src/follows/follows.module';
import type {
  FollowCounts,
  FollowCreateResult,
  FollowProfileSummaryRecord,
  FollowsPageInput,
  FollowsRepository,
  PaginatedFollowsResponse
} from '../src/follows/follows.types';
import { POSTS_REPOSITORY } from '../src/posts/posts.constants';
import { PostsModule } from '../src/posts/posts.module';
import type {
  CompactActivitySlot,
  CreatePostInput,
  FeedPostRecord,
  PaginatedPostsResponse,
  PostMedia,
  PostRecord,
  PostsPageInput,
  PostsRepository
} from '../src/posts/posts.types';
import { PROFILES_API_REPOSITORY } from '../src/profiles/profiles.constants';
import { ProfilesModule } from '../src/profiles/profiles.module';
import type {
  HostProfileRecord,
  PrivateProfileRecord,
  ProfilesApiRepository,
  PublicProfileRecord,
  PublicProfileResponse,
  UpdateProfileInput
} from '../src/profiles/profiles.types';

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
  aggregate_type: 'follow';
  aggregate_id: string;
  event_type: 'follow.created';
  payload: {
    follower_id: string;
    followee_id: string;
    created_at: string;
  };
}

class FakeFollowsRepository implements FollowsRepository {
  private readonly follows = new Map<string, { follower_id: string; followee_id: string; created_at: string }>();
  private readonly domainEvents: FakeDomainEvent[] = [];
  private sequence = 0;

  constructor(private readonly profilesRepository: FakeProfilesApiRepository) {}

  reset(): void {
    this.follows.clear();
    this.domainEvents.length = 0;
    this.sequence = 0;
  }

  domainEventsForFollowee(followeeId: string): FakeDomainEvent[] {
    return this.domainEvents.filter((event) => event.aggregate_id === followeeId);
  }

  hasFollow(followerId: string, followeeId: string): boolean {
    return this.follows.has(followKey(followerId, followeeId));
  }

  async createFollow(followerId: string, followeeId: string): Promise<FollowCreateResult> {
    if (!this.profilesRepository.hasProfile(followeeId)) {
      return { status: 'followee_not_found' };
    }

    const key = followKey(followerId, followeeId);
    const existingFollow = this.follows.get(key);

    if (existingFollow !== undefined) {
      return {
        status: 'already_exists',
        follow: { ...existingFollow }
      };
    }

    const follow = {
      follower_id: followerId,
      followee_id: followeeId,
      created_at: this.nextCreatedAt()
    };

    this.follows.set(key, { ...follow });
    this.domainEvents.push({
      aggregate_type: 'follow',
      aggregate_id: followeeId,
      event_type: 'follow.created',
      payload: { ...follow }
    });

    return {
      status: 'created',
      follow: { ...follow }
    };
  }

  async deleteFollow(followerId: string, followeeId: string): Promise<void> {
    this.follows.delete(followKey(followerId, followeeId));
  }

  async findFollowers(
    profileId: string,
    input: FollowsPageInput
  ): Promise<FollowProfileSummaryRecord[]> {
    return Array.from(this.follows.values())
      .filter((follow) => follow.followee_id === profileId)
      .sort(compareFollowsDesc)
      .filter((follow) => isFollowAfterCursor(follow, input, follow.follower_id))
      .slice(0, input.limit)
      .map((follow) => this.toProfileSummary(follow.follower_id, follow.created_at, input.viewerId));
  }

  async findFollowing(
    profileId: string,
    input: FollowsPageInput
  ): Promise<FollowProfileSummaryRecord[]> {
    return Array.from(this.follows.values())
      .filter((follow) => follow.follower_id === profileId)
      .sort(compareFollowsDesc)
      .filter((follow) => isFollowAfterCursor(follow, input, follow.followee_id))
      .slice(0, input.limit)
      .map((follow) => this.toProfileSummary(follow.followee_id, follow.created_at, input.viewerId));
  }

  async findFolloweeIds(followerId: string): Promise<string[]> {
    return Array.from(this.follows.values())
      .filter((follow) => follow.follower_id === followerId)
      .sort(compareFollowsDesc)
      .map((follow) => follow.followee_id);
  }

  async getCounts(profileId: string): Promise<FollowCounts> {
    return {
      follower_count: Array.from(this.follows.values()).filter(
        (follow) => follow.followee_id === profileId
      ).length,
      following_count: Array.from(this.follows.values()).filter(
        (follow) => follow.follower_id === profileId
      ).length
    };
  }

  async isFollowing(followerId: string, followeeId: string): Promise<boolean> {
    return this.hasFollow(followerId, followeeId);
  }

  private toProfileSummary(
    profileId: string,
    followedAt: string,
    viewerId: string | undefined
  ): FollowProfileSummaryRecord {
    const profile = this.profilesRepository.publicProfile(profileId);

    if (profile === undefined) {
      throw new Error(`Missing fake profile ${profileId}`);
    }

    const summary: FollowProfileSummaryRecord = {
      ...profile,
      interests: [...profile.interests],
      home_location: profile.home_location === null ? null : { ...profile.home_location },
      followed_at: followedAt
    };

    if (viewerId !== undefined) {
      summary.is_following = this.hasFollow(viewerId, profileId);
    }

    return summary;
  }

  private nextCreatedAt(): string {
    const createdAt = new Date(Date.UTC(2026, 5, 17, 5, 0, this.sequence));

    this.sequence += 1;

    return createdAt.toISOString();
  }
}

class FakeProfilesApiRepository implements ProfilesApiRepository {
  private readonly profiles = new Map<string, PrivateProfileRecord>();
  private readonly hostProfilesByProfileId = new Map<string, HostProfileRecord>();

  reset(): void {
    this.profiles.clear();
    this.hostProfilesByProfileId.clear();
  }

  addProfile(profile: PrivateProfileRecord): void {
    this.profiles.set(profile.id, clonePrivateProfile(profile));
  }

  hasProfile(profileId: string): boolean {
    return this.profiles.has(profileId);
  }

  publicProfile(profileId: string): PublicProfileRecord | undefined {
    const profile = this.profiles.get(profileId);

    if (profile === undefined) {
      return undefined;
    }

    return {
      id: profile.id,
      display_name: profile.display_name,
      avatar_url: profile.avatar_url,
      bio: profile.bio,
      interests: [...profile.interests],
      home_location: profile.home_location === null ? null : { ...profile.home_location }
    };
  }

  async getPrivateProfile(profileId: string): Promise<PrivateProfileRecord | undefined> {
    const profile = this.profiles.get(profileId);

    return profile === undefined ? undefined : clonePrivateProfile(profile);
  }

  async updatePrivateProfile(
    profileId: string,
    input: UpdateProfileInput
  ): Promise<PrivateProfileRecord | undefined> {
    const profile = this.profiles.get(profileId);

    if (profile === undefined) {
      return undefined;
    }

    const updatedProfile: PrivateProfileRecord = {
      ...profile,
      updated_at: '2026-06-17T06:00:00.000Z'
    };

    if (input.display_name !== undefined) {
      updatedProfile.display_name = input.display_name;
    }

    if (input.bio !== undefined) {
      updatedProfile.bio = input.bio;
    }

    if (input.interests !== undefined) {
      updatedProfile.interests = [...input.interests];
    }

    if (input.avatar_url !== undefined) {
      updatedProfile.avatar_url = input.avatar_url;
    }

    if (input.home_location !== undefined) {
      updatedProfile.home_location =
        input.home_location === null ? null : { ...input.home_location };
    }

    this.profiles.set(profileId, clonePrivateProfile(updatedProfile));

    return clonePrivateProfile(updatedProfile);
  }

  async getPublicProfile(profileId: string): Promise<PublicProfileRecord | undefined> {
    return this.publicProfile(profileId);
  }

  async becomeHost(profileId: string): Promise<HostProfileRecord | undefined> {
    if (!this.profiles.has(profileId)) {
      return undefined;
    }

    const existingHostProfile = this.hostProfilesByProfileId.get(profileId);

    if (existingHostProfile !== undefined) {
      return { ...existingHostProfile };
    }

    const hostProfile: HostProfileRecord = {
      id: randomUUID(),
      profile_id: profileId,
      is_verified: false,
      payout_ref: null,
      rating: 0,
      total_activities: 0,
      created_at: '2026-06-17T04:30:00.000Z',
      updated_at: '2026-06-17T04:30:00.000Z'
    };

    this.hostProfilesByProfileId.set(profileId, { ...hostProfile });

    return { ...hostProfile };
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

class FakePostsRepository implements PostsRepository {
  private readonly activities = new Map<string, FakeActivity>();
  private readonly slots = new Map<string, FakeSlot>();
  private readonly posts = new Map<string, PostRecord>();
  private sequence = 0;

  reset(): void {
    this.activities.clear();
    this.slots.clear();
    this.posts.clear();
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
      .filter((post) => isPostAfterCursor(post, input))
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

describe('Follows module', () => {
  let app: NestFastifyApplication;
  let followsRepository: FakeFollowsRepository;
  let postsRepository: FakePostsRepository;
  let profilesRepository: FakeProfilesApiRepository;

  const hemantProfileId = randomUUID();
  const snehaProfileId = randomUUID();
  const priyaProfileId = randomUUID();
  const hemantToken = 'hemant-token';
  const snehaToken = 'sneha-token';
  const priyaToken = 'priya-token';

  beforeAll(async () => {
    profilesRepository = new FakeProfilesApiRepository();
    followsRepository = new FakeFollowsRepository(profilesRepository);
    postsRepository = new FakePostsRepository();

    const moduleRef = await Test.createTestingModule({
      imports: [ProfilesModule, PostsModule, FollowsModule]
    })
      .overrideProvider(AuthService)
      .useValue(
        new FakeAuthService(
          new Map([
            [hemantToken, hemantProfileId],
            [snehaToken, snehaProfileId],
            [priyaToken, priyaProfileId]
          ])
        )
      )
      .overrideProvider(PROFILES_API_REPOSITORY)
      .useValue(profilesRepository)
      .overrideProvider(POSTS_REPOSITORY)
      .useValue(postsRepository)
      .overrideProvider(FOLLOWS_REPOSITORY)
      .useValue(followsRepository)
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
    profilesRepository.reset();
    followsRepository.reset();
    postsRepository.reset();

    profilesRepository.addProfile(profileFixture(hemantProfileId, '+919900000101', 'Hemant Rao'));
    profilesRepository.addProfile(profileFixture(snehaProfileId, '+919900000202', 'Sneha Iyer'));
    profilesRepository.addProfile(profileFixture(priyaProfileId, '+919900000303', 'Priya Menon'));
  });

  afterAll(async () => {
    await app.close();
  });

  it('supports follows, profile counts, idempotency, following feed, and unfollow', async () => {
    const followResponse = await app.inject({
      method: 'POST',
      url: `/profiles/${hemantProfileId}/follow`,
      headers: {
        authorization: `Bearer ${snehaToken}`
      }
    });

    expect(followResponse.statusCode).toBe(204);

    const followersResponse = await app.inject({
      method: 'GET',
      url: `/profiles/${hemantProfileId}/followers`
    });
    const followers = followersResponse.json() as PaginatedFollowsResponse;

    expect(followersResponse.statusCode).toBe(200);
    expect(followers.items).toEqual([
      expect.objectContaining({
        id: snehaProfileId,
        display_name: 'Sneha Iyer'
      })
    ]);

    const followingResponse = await app.inject({
      method: 'GET',
      url: `/profiles/${snehaProfileId}/following`,
      headers: {
        authorization: `Bearer ${snehaToken}`
      }
    });
    const following = followingResponse.json() as PaginatedFollowsResponse;

    expect(followingResponse.statusCode).toBe(200);
    expect(following.items).toEqual([
      expect.objectContaining({
        id: hemantProfileId,
        display_name: 'Hemant Rao',
        is_following: true
      })
    ]);

    const hemantAsSnehaResponse = await app.inject({
      method: 'GET',
      url: `/profiles/${hemantProfileId}`,
      headers: {
        authorization: `Bearer ${snehaToken}`
      }
    });
    const hemantAsSneha = hemantAsSnehaResponse.json() as PublicProfileResponse;

    expect(hemantAsSnehaResponse.statusCode).toBe(200);
    expect(hemantAsSneha.follower_count).toBe(1);
    expect(hemantAsSneha.following_count).toBe(0);
    expect(hemantAsSneha.is_following).toBe(true);

    const hemantAnonymousResponse = await app.inject({
      method: 'GET',
      url: `/profiles/${hemantProfileId}`
    });
    const hemantAnonymous = hemantAnonymousResponse.json() as PublicProfileResponse;

    expect(hemantAnonymousResponse.statusCode).toBe(200);
    expect(hemantAnonymous.follower_count).toBe(1);
    expect(hemantAnonymous).not.toHaveProperty('is_following');

    const refollowResponse = await app.inject({
      method: 'POST',
      url: `/profiles/${hemantProfileId}/follow`,
      headers: {
        authorization: `Bearer ${snehaToken}`
      }
    });

    expect(refollowResponse.statusCode).toBe(204);

    const hemantAfterRefollow = (
      await app.inject({
        method: 'GET',
        url: `/profiles/${hemantProfileId}`,
        headers: {
          authorization: `Bearer ${snehaToken}`
        }
      })
    ).json() as PublicProfileResponse;

    expect(hemantAfterRefollow.follower_count).toBe(1);
    expect(followsRepository.domainEventsForFollowee(hemantProfileId)).toEqual([
      {
        aggregate_type: 'follow',
        aggregate_id: hemantProfileId,
        event_type: 'follow.created',
        payload: {
          follower_id: snehaProfileId,
          followee_id: hemantProfileId,
          created_at: expect.any(String) as string
        }
      }
    ]);

    const selfFollowResponse = await app.inject({
      method: 'POST',
      url: `/profiles/${hemantProfileId}/follow`,
      headers: {
        authorization: `Bearer ${hemantToken}`
      }
    });

    expect(selfFollowResponse.statusCode).toBe(400);
    expect(followsRepository.hasFollow(hemantProfileId, hemantProfileId)).toBe(false);
    expect(followsRepository.domainEventsForFollowee(hemantProfileId)).toHaveLength(1);

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
    const createPostResponse = await app.inject({
      method: 'POST',
      url: '/posts',
      headers: {
        authorization: `Bearer ${hemantToken}`
      },
      payload: {
        body: 'Scouted the Nandi foothill trail this week.',
        media: [],
        linkedActivityId: nandiActivityId
      }
    });
    const createdPost = createPostResponse.json() as PostRecord;

    expect(createPostResponse.statusCode).toBe(201);

    const snehaFollowingFeed = await feedFor(snehaToken, 'following');
    expect(snehaFollowingFeed.items).toEqual([
      expect.objectContaining({
        id: createdPost.id,
        author_id: hemantProfileId,
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
      })
    ]);

    const priyaFollowingFeed = await feedFor(priyaToken, 'following');
    expect(priyaFollowingFeed.items).toEqual([]);

    for (const token of [hemantToken, snehaToken, priyaToken]) {
      const globalFeed = await feedFor(token);

      expect(globalFeed.items.map((post) => post.id)).toContain(createdPost.id);
    }

    const unfollowResponse = await app.inject({
      method: 'DELETE',
      url: `/profiles/${hemantProfileId}/follow`,
      headers: {
        authorization: `Bearer ${snehaToken}`
      }
    });

    expect(unfollowResponse.statusCode).toBe(204);

    const followersAfterUnfollow = (
      await app.inject({
        method: 'GET',
        url: `/profiles/${hemantProfileId}/followers`
      })
    ).json() as PaginatedFollowsResponse;

    expect(followersAfterUnfollow.items.map((profile) => profile.id)).not.toContain(snehaProfileId);

    const hemantAfterUnfollow = (
      await app.inject({
        method: 'GET',
        url: `/profiles/${hemantProfileId}`,
        headers: {
          authorization: `Bearer ${snehaToken}`
        }
      })
    ).json() as PublicProfileResponse;

    expect(hemantAfterUnfollow.follower_count).toBe(0);
    expect(hemantAfterUnfollow.is_following).toBe(false);

    const snehaFollowingFeedAfterUnfollow = await feedFor(snehaToken, 'following');
    expect(snehaFollowingFeedAfterUnfollow.items.map((post) => post.id)).not.toContain(createdPost.id);
  });

  async function feedFor(
    token: string,
    scope?: 'global' | 'following'
  ): Promise<PaginatedPostsResponse> {
    const response = await app.inject({
      method: 'GET',
      url: scope === undefined ? '/feed' : `/feed?scope=${scope}`,
      headers: {
        authorization: `Bearer ${token}`
      }
    });

    expect(response.statusCode).toBe(200);

    return response.json() as PaginatedPostsResponse;
  }
});

function profileFixture(id: string, phone: string, displayName: string): PrivateProfileRecord {
  return {
    id,
    phone,
    display_name: displayName,
    avatar_url: null,
    bio: null,
    interests: [],
    home_location: null,
    created_at: '2026-06-17T04:00:00.000Z',
    updated_at: '2026-06-17T04:00:00.000Z'
  };
}

function followKey(followerId: string, followeeId: string): string {
  return `${followerId}:${followeeId}`;
}

function clonePrivateProfile(profile: PrivateProfileRecord): PrivateProfileRecord {
  return {
    ...profile,
    interests: [...profile.interests],
    home_location: profile.home_location === null ? null : { ...profile.home_location }
  };
}

function clonePost(post: PostRecord): PostRecord {
  return {
    ...post,
    media: cloneMedia(post.media)
  };
}

function cloneMedia(media: PostMedia): PostMedia {
  return JSON.parse(JSON.stringify(media)) as PostMedia;
}

function compareFollowsDesc(
  left: { follower_id: string; followee_id: string; created_at: string },
  right: { follower_id: string; followee_id: string; created_at: string }
): number {
  const createdAtComparison = right.created_at.localeCompare(left.created_at);

  if (createdAtComparison !== 0) {
    return createdAtComparison;
  }

  return right.followee_id.localeCompare(left.followee_id);
}

function isFollowAfterCursor(
  follow: { created_at: string },
  input: FollowsPageInput,
  profileId: string
): boolean {
  if (input.cursor === undefined) {
    return true;
  }

  if (follow.created_at < input.cursor.created_at) {
    return true;
  }

  return follow.created_at === input.cursor.created_at && profileId < input.cursor.id;
}

function comparePostsDesc(left: PostRecord, right: PostRecord): number {
  const createdAtComparison = right.created_at.localeCompare(left.created_at);

  if (createdAtComparison !== 0) {
    return createdAtComparison;
  }

  return right.id.localeCompare(left.id);
}

function isPostAfterCursor(post: PostRecord, input: PostsPageInput): boolean {
  if (input.cursor === undefined) {
    return true;
  }

  if (post.created_at < input.cursor.created_at) {
    return true;
  }

  return post.created_at === input.cursor.created_at && post.id < input.cursor.id;
}
