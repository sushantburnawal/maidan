import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import { FollowsService } from '../follows/follows.service';
import { PROFILES_API_REPOSITORY } from './profiles.constants';
import type { UpdateProfileDto } from './dto/update-profile.dto';
import type {
  HostProfileRecord,
  PrivateProfileRecord,
  PrivateProfileResponse,
  ProfilesApiRepository,
  PublicProfileRecord,
  PublicProfileResponse,
  UpdateProfileInput
} from './profiles.types';

const UPDATE_PROFILE_FIELDS: ReadonlyArray<keyof UpdateProfileInput> = [
  'display_name',
  'bio',
  'interests',
  'avatar_url',
  'home_location'
];

@Injectable()
export class ProfilesService {
  constructor(
    @Inject(PROFILES_API_REPOSITORY) private readonly repository: ProfilesApiRepository,
    private readonly followsService: FollowsService
  ) {}

  async getMe(profileId: string): Promise<PrivateProfileResponse> {
    const profile = await this.repository.getPrivateProfile(profileId);

    if (profile === undefined) {
      throw profileNotFound();
    }

    return this.withFollowCounts(profile);
  }

  async updateMe(profileId: string, dto: UpdateProfileDto): Promise<PrivateProfileRecord> {
    const input = toUpdateProfileInput(dto);

    if (!hasUpdateField(input)) {
      throw new BadRequestException('At least one profile field is required');
    }

    const profile = await this.repository.updatePrivateProfile(profileId, input);

    if (profile === undefined) {
      throw profileNotFound();
    }

    return profile;
  }

  async getPublicProfile(
    profileId: string,
    viewerId?: string
  ): Promise<PublicProfileResponse> {
    const profile = await this.repository.getPublicProfile(profileId);

    if (profile === undefined) {
      throw profileNotFound();
    }

    const profileWithCounts = await this.withFollowCounts(profile);

    if (viewerId === undefined) {
      return profileWithCounts;
    }

    return {
      ...profileWithCounts,
      is_following: await this.followsService.isFollowing(viewerId, profileId)
    };
  }

  async becomeHost(profileId: string): Promise<HostProfileRecord> {
    const hostProfile = await this.repository.becomeHost(profileId);

    if (hostProfile === undefined) {
      throw profileNotFound();
    }

    return hostProfile;
  }

  private async withFollowCounts<T extends PublicProfileRecord | PrivateProfileRecord>(
    profile: T
  ): Promise<T & { follower_count: number; following_count: number }> {
    const counts = await this.followsService.getCounts(profile.id);

    return {
      ...profile,
      follower_count: counts.follower_count,
      following_count: counts.following_count
    };
  }
}

function toUpdateProfileInput(dto: UpdateProfileDto): UpdateProfileInput {
  return {
    display_name: dto.display_name,
    bio: dto.bio,
    interests: dto.interests,
    avatar_url: dto.avatar_url,
    home_location: dto.home_location
  };
}

function hasUpdateField(input: UpdateProfileInput): boolean {
  return UPDATE_PROFILE_FIELDS.some((field) => input[field] !== undefined);
}

function profileNotFound(): NotFoundException {
  return new NotFoundException('Profile not found');
}
