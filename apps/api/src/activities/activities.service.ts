import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException
} from '@nestjs/common';

import { ACTIVITIES_REPOSITORY } from './activities.constants';
import type {
  ActivitiesRepository,
  ActivityDetailResponse,
  ActivityResponse,
  ActivitySlotRecord,
  ActivityVibeResponse,
  CreateActivityInput,
  CreateSlotInput,
  NearbyActivitiesQuery,
  NearbyActivityResponse,
  UpdateActivityInput,
  UpdateSlotInput
} from './activities.types';
import { ActivitiesVibeProxy } from './activities-vibe.proxy';
import type { CreateActivityDto } from './dto/create-activity.dto';
import type { NearbyActivitiesQueryDto } from './dto/nearby-activities-query.dto';
import type { CreateSlotDto, UpdateSlotDto } from './dto/slot.dto';
import type { UpdateActivityDto } from './dto/update-activity.dto';

const UPDATE_ACTIVITY_FIELDS: ReadonlyArray<keyof UpdateActivityInput> = [
  'title',
  'description',
  'pillar',
  'category',
  'meeting_point',
  'location',
  'base_price_inr',
  'capacity',
  'media'
];

const UPDATE_SLOT_FIELDS: ReadonlyArray<keyof UpdateSlotInput> = [
  'starts_at',
  'ends_at',
  'capacity',
  'status'
];

@Injectable()
export class ActivitiesService {
  constructor(
    @Inject(ACTIVITIES_REPOSITORY) private readonly repository: ActivitiesRepository,
    private readonly vibeProxy: ActivitiesVibeProxy
  ) {}

  async createActivity(hostId: string, dto: CreateActivityDto): Promise<ActivityResponse> {
    const activity = await this.repository.createActivity(hostId, toCreateActivityInput(dto));

    if (activity === undefined) {
      throw new ForbiddenException('Only hosts can create activities');
    }

    return activity;
  }

  async updateActivity(
    activityId: string,
    ownerId: string,
    dto: UpdateActivityDto
  ): Promise<ActivityResponse> {
    const input = toUpdateActivityInput(dto);

    if (!hasUpdateActivityField(input)) {
      throw new BadRequestException('At least one activity field is required');
    }

    const activity = await this.repository.updateActivity(activityId, ownerId, input);

    if (activity === undefined) {
      throw activityNotFound();
    }

    return activity;
  }

  async publishActivity(activityId: string, ownerId: string): Promise<ActivityResponse> {
    const activity = await this.repository.publishActivity(activityId, ownerId);

    if (activity === undefined) {
      throw activityNotFound();
    }

    return activity;
  }

  async pauseActivity(activityId: string, ownerId: string): Promise<ActivityResponse> {
    const activity = await this.repository.pauseActivity(activityId, ownerId);

    if (activity === undefined) {
      throw activityNotFound();
    }

    return activity;
  }

  async archiveActivity(activityId: string, ownerId: string): Promise<ActivityResponse> {
    const activity = await this.repository.archiveActivity(activityId, ownerId);

    if (activity === undefined) {
      throw activityNotFound();
    }

    return activity;
  }

  async createSlot(
    activityId: string,
    ownerId: string,
    dto: CreateSlotDto
  ): Promise<ActivitySlotRecord> {
    assertSlotRange(dto.startsAt, dto.endsAt);

    const slot = await this.repository.createSlot(activityId, ownerId, toCreateSlotInput(dto));

    if (slot === undefined) {
      throw activityNotFound();
    }

    return slot;
  }

  async updateSlot(
    activityId: string,
    slotId: string,
    ownerId: string,
    dto: UpdateSlotDto
  ): Promise<ActivitySlotRecord> {
    const input = toUpdateSlotInput(dto);

    if (!hasUpdateSlotField(input)) {
      throw new BadRequestException('At least one slot field is required');
    }

    if (input.starts_at !== undefined && input.ends_at !== undefined) {
      assertSlotRange(input.starts_at, input.ends_at);
    }

    const slot = await this.repository.updateSlot(activityId, slotId, ownerId, input);

    if (slot === undefined) {
      throw new NotFoundException('Slot not found');
    }

    return slot;
  }

  async findNearby(dto: NearbyActivitiesQueryDto): Promise<NearbyActivityResponse[]> {
    return this.repository.findNearby(toNearbyActivitiesQuery(dto));
  }

  async getActivityDetail(activityId: string): Promise<ActivityDetailResponse> {
    const activity = await this.repository.getActivityDetail(activityId);

    if (activity === undefined) {
      throw activityNotFound();
    }

    return activity;
  }

  async getActivityVibe(activityId: string): Promise<ActivityVibeResponse> {
    return this.vibeProxy.getActivityVibe(activityId);
  }
}

function toCreateActivityInput(dto: CreateActivityDto): CreateActivityInput {
  return {
    title: dto.title,
    description: dto.description,
    pillar: dto.pillar,
    category: dto.category,
    meeting_point: dto.meetingPoint,
    location: {
      lat: dto.location.lat,
      lng: dto.location.lng
    },
    base_price_inr: dto.basePriceInr,
    capacity: dto.capacity,
    media: dto.media ?? []
  };
}

function toUpdateActivityInput(dto: UpdateActivityDto): UpdateActivityInput {
  return {
    title: dto.title,
    description: dto.description,
    pillar: dto.pillar,
    category: dto.category,
    meeting_point: dto.meetingPoint,
    location:
      dto.location === undefined
        ? undefined
        : {
            lat: dto.location.lat,
            lng: dto.location.lng
          },
    base_price_inr: dto.basePriceInr,
    capacity: dto.capacity,
    media: dto.media
  };
}

function toCreateSlotInput(dto: CreateSlotDto): CreateSlotInput {
  return {
    starts_at: dto.startsAt,
    ends_at: dto.endsAt,
    capacity: dto.capacity
  };
}

function toUpdateSlotInput(dto: UpdateSlotDto): UpdateSlotInput {
  return {
    starts_at: dto.startsAt,
    ends_at: dto.endsAt,
    capacity: dto.capacity,
    status: dto.status
  };
}

function toNearbyActivitiesQuery(dto: NearbyActivitiesQueryDto): NearbyActivitiesQuery {
  const hasLat = dto.lat !== undefined;
  const hasLng = dto.lng !== undefined;

  if (hasLat !== hasLng) {
    throw new BadRequestException('lat and lng must be provided together');
  }

  const bboxValues = [dto.north, dto.south, dto.east, dto.west];
  const hasAnyBboxValue = bboxValues.some((value) => value !== undefined);
  const hasAllBboxValues = bboxValues.every((value) => value !== undefined);

  if (hasAnyBboxValue && !hasAllBboxValues) {
    throw new BadRequestException('north, south, east, and west must be provided together');
  }

  if (!hasLat && !hasAllBboxValues) {
    throw new BadRequestException('provide either lat/lng or north/south/east/west');
  }

  if (dto.north !== undefined && dto.south !== undefined && dto.north <= dto.south) {
    throw new BadRequestException('north must be greater than south');
  }

  return {
    lat: dto.lat,
    lng: dto.lng,
    radius_km: dto.radiusKm ?? 10,
    pillar: dto.pillar,
    north: dto.north,
    south: dto.south,
    east: dto.east,
    west: dto.west
  };
}

function hasUpdateActivityField(input: UpdateActivityInput): boolean {
  return UPDATE_ACTIVITY_FIELDS.some((field) => input[field] !== undefined);
}

function hasUpdateSlotField(input: UpdateSlotInput): boolean {
  return UPDATE_SLOT_FIELDS.some((field) => input[field] !== undefined);
}

function assertSlotRange(startsAt: string, endsAt: string): void {
  if (new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
    throw new BadRequestException('endsAt must be after startsAt');
  }
}

function activityNotFound(): NotFoundException {
  return new NotFoundException('Activity not found');
}
