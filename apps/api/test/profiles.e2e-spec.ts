import { UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';

import { AuthService } from '../src/auth/auth.service';
import type { AuthenticatedUser } from '../src/auth/auth.types';
import { FOLLOWS_REPOSITORY } from '../src/follows/follows.constants';
import type {
  FollowCounts,
  FollowCreateResult,
  FollowProfileSummaryRecord,
  FollowsRepository
} from '../src/follows/follows.types';
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

class FakeProfilesApiRepository implements ProfilesApiRepository {
  private readonly profiles = new Map<string, PrivateProfileRecord>();
  private readonly hostProfilesByProfileId = new Map<string, HostProfileRecord>();

  addProfile(profile: PrivateProfileRecord): void {
    this.profiles.set(profile.id, clonePrivateProfile(profile));
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
      updated_at: '2026-06-17T05:00:00.000Z'
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
      home_location:
        profile.home_location === null ? null : { ...profile.home_location }
    };
  }

  async becomeHost(profileId: string): Promise<HostProfileRecord | undefined> {
    if (!this.profiles.has(profileId)) {
      return undefined;
    }

    const existingHostProfile = this.hostProfilesByProfileId.get(profileId);

    if (existingHostProfile !== undefined) {
      return cloneHostProfile(existingHostProfile);
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

    this.hostProfilesByProfileId.set(profileId, cloneHostProfile(hostProfile));

    return cloneHostProfile(hostProfile);
  }

  hostProfileCount(profileId: string): number {
    return this.hostProfilesByProfileId.has(profileId) ? 1 : 0;
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

describe('Profiles module', () => {
  let app: NestFastifyApplication;
  let profilesRepository: FakeProfilesApiRepository;

  const profileId = randomUUID();
  const googleProfileId = randomUUID();
  const token = 'profile-token';
  const googleToken = 'google-profile-token';
  const phone = '+919900000321';

  beforeAll(async () => {
    profilesRepository = new FakeProfilesApiRepository();
    profilesRepository.addProfile({
      id: profileId,
      phone,
      display_name: 'Maidan Explorer 0321',
      avatar_url: null,
      bio: null,
      interests: [],
      home_location: null,
      created_at: '2026-06-17T04:00:00.000Z',
      updated_at: '2026-06-17T04:00:00.000Z'
    });
    profilesRepository.addProfile({
      id: googleProfileId,
      phone: null,
      display_name: 'Google Explorer',
      avatar_url: 'https://example.com/google.png',
      bio: null,
      interests: [],
      home_location: null,
      created_at: '2026-06-17T04:00:00.000Z',
      updated_at: '2026-06-17T04:00:00.000Z'
    });

    const moduleRef = await Test.createTestingModule({
      imports: [ProfilesModule]
    })
      .overrideProvider(AuthService)
      .useValue(
        new FakeAuthService(
          new Map([
            [token, profileId],
            [googleToken, googleProfileId]
          ])
        )
      )
      .overrideProvider(PROFILES_API_REPOSITORY)
      .useValue(profilesRepository)
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

  afterAll(async () => {
    await app.close();
  });

  it('updates the current user profile and exposes a public view without phone', async () => {
    const updateResponse = await app.inject({
      method: 'PATCH',
      url: '/me',
      headers: {
        authorization: `Bearer ${token}`
      },
      payload: {
        display_name: 'Nisha Pai',
        bio: 'Weekend rider and workshop regular.',
        interests: ['cycling', 'coffee'],
        avatar_url: 'https://images.maidan.local/profiles/nisha.jpg',
        home_location: {
          lat: 12.9716,
          lng: 77.5946
        }
      }
    });

    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.json()).toMatchObject({
      id: profileId,
      phone,
      display_name: 'Nisha Pai',
      bio: 'Weekend rider and workshop regular.',
      interests: ['cycling', 'coffee'],
      avatar_url: 'https://images.maidan.local/profiles/nisha.jpg',
      home_location: {
        lat: 12.9716,
        lng: 77.5946
      }
    });

    const meResponse = await app.inject({
      method: 'GET',
      url: '/me',
      headers: {
        authorization: `Bearer ${token}`
      }
    });

    expect(meResponse.statusCode).toBe(200);
    expect(meResponse.json()).toMatchObject({
      id: profileId,
      phone,
      display_name: 'Nisha Pai'
    });

    const publicResponse = await app.inject({
      method: 'GET',
      url: `/profiles/${profileId}`
    });
    const publicProfile = publicResponse.json() as PublicProfileResponse;

    expect(publicResponse.statusCode).toBe(200);
    expect(publicProfile).toEqual({
      id: profileId,
      display_name: 'Nisha Pai',
      bio: 'Weekend rider and workshop regular.',
      interests: ['cycling', 'coffee'],
      avatar_url: 'https://images.maidan.local/profiles/nisha.jpg',
      home_location: {
        lat: 12.9716,
        lng: 77.5946
      },
      follower_count: 0,
      following_count: 0
    });
    expect(publicProfile).not.toHaveProperty('phone');
    expect(publicProfile).not.toHaveProperty('is_following');
    expect(publicResponse.body).not.toContain(phone);
  });

  it('returns the current Google profile with a nullable phone', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/me',
      headers: {
        authorization: `Bearer ${googleToken}`
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: googleProfileId,
      phone: null,
      display_name: 'Google Explorer',
      follower_count: 0,
      following_count: 0
    });
  });

  it('updates bio and interests for a Google profile', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/me',
      headers: {
        authorization: `Bearer ${googleToken}`
      },
      payload: {
        bio: 'Bengaluru walker and pottery beginner.',
        interests: ['walking', 'pottery']
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: googleProfileId,
      phone: null,
      display_name: 'Google Explorer',
      bio: 'Bengaluru walker and pottery beginner.',
      interests: ['walking', 'pottery']
    });
  });

  it('rejects an invalid home_location', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/me',
      headers: {
        authorization: `Bearer ${token}`
      },
      payload: {
        home_location: {
          lat: 91,
          lng: 77.5946
        }
      }
    });

    expect(response.statusCode).toBe(400);
  });

  it('creates a host profile idempotently', async () => {
    const firstResponse = await app.inject({
      method: 'POST',
      url: '/me/become-host',
      headers: {
        authorization: `Bearer ${token}`
      }
    });
    const secondResponse = await app.inject({
      method: 'POST',
      url: '/me/become-host',
      headers: {
        authorization: `Bearer ${token}`
      }
    });

    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(200);
    expect(secondResponse.json()).toEqual(firstResponse.json());
    expect(profilesRepository.hostProfileCount(profileId)).toBe(1);
  });
});

function clonePrivateProfile(profile: PrivateProfileRecord): PrivateProfileRecord {
  return {
    ...profile,
    interests: [...profile.interests],
    home_location:
      profile.home_location === null ? null : { ...profile.home_location }
  };
}

function cloneHostProfile(hostProfile: HostProfileRecord): HostProfileRecord {
  return { ...hostProfile };
}
