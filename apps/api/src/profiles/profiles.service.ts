import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import { PROFILES_API_REPOSITORY } from './profiles.constants';
import type { UpdateProfileDto } from './dto/update-profile.dto';
import type {
  HostProfileRecord,
  PrivateProfileRecord,
  ProfilesApiRepository,
  PublicProfileRecord,
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
    @Inject(PROFILES_API_REPOSITORY) private readonly repository: ProfilesApiRepository
  ) {}

  async getMe(profileId: string): Promise<PrivateProfileRecord> {
    const profile = await this.repository.getPrivateProfile(profileId);

    if (profile === undefined) {
      throw profileNotFound();
    }

    return profile;
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

  async getPublicProfile(profileId: string): Promise<PublicProfileRecord> {
    const profile = await this.repository.getPublicProfile(profileId);

    if (profile === undefined) {
      throw profileNotFound();
    }

    return profile;
  }

  async becomeHost(profileId: string): Promise<HostProfileRecord> {
    const hostProfile = await this.repository.becomeHost(profileId);

    if (hostProfile === undefined) {
      throw profileNotFound();
    }

    return hostProfile;
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
