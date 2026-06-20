import type {
  ActivityPillar,
  ActivityStatus,
  JsonValue,
  SlotStatus
} from '@maidan/shared';

export interface GeoPoint {
  lat: number;
  lng: number;
}

export type ActivityMedia = JsonValue[];

export interface ActivityRecord {
  id: string;
  host_id: string;
  title: string;
  description: string;
  pillar: ActivityPillar;
  category: string;
  meeting_point: string;
  location: GeoPoint;
  base_price_inr: number;
  currency: 'INR';
  capacity: number;
  fairness_score: number;
  status: ActivityStatus;
  media: ActivityMedia;
  created_at: string;
  updated_at: string;
}

export interface ActivitySlotRecord {
  id: string;
  activity_id: string;
  starts_at: string;
  ends_at: string;
  capacity: number;
  booked_count: number;
  status: SlotStatus;
  created_at: string;
  updated_at: string;
}

export interface ActivityFairness {
  score: number;
  category_median_inr: number | null;
  suggestion: string;
}

export type ActivityResponse = ActivityRecord & {
  fairness: ActivityFairness;
};

export type NearbyActivityResponse = ActivityResponse & {
  distance_m: number | null;
  next_open_slot: ActivitySlotRecord | null;
};

export type ActivityDetailResponse = ActivityResponse & {
  upcoming_open_slots: ActivitySlotRecord[];
};

export interface ActivityVibePerson {
  display_name: string;
  role: 'host' | 'attendee';
}

export interface ActivityVibeInterest {
  tag: string;
  count: number;
}

export interface ActivityVibeResponse {
  activity_id: string;
  title: string;
  pillar: ActivityPillar;
  participant_count: number;
  people: ActivityVibePerson[];
  shared_interests: ActivityVibeInterest[];
  summary: string;
}

export interface CreateActivityInput {
  title: string;
  description: string;
  pillar: ActivityPillar;
  category: string;
  meeting_point: string;
  location: GeoPoint;
  base_price_inr: number;
  capacity: number;
  media: ActivityMedia;
}

export interface UpdateActivityInput {
  title?: string;
  description?: string;
  pillar?: ActivityPillar;
  category?: string;
  meeting_point?: string;
  location?: GeoPoint;
  base_price_inr?: number;
  capacity?: number;
  media?: ActivityMedia;
}

export interface NearbyActivitiesQuery {
  lat?: number;
  lng?: number;
  radius_km: number;
  pillar?: ActivityPillar;
  north?: number;
  south?: number;
  east?: number;
  west?: number;
}

export interface CreateSlotInput {
  starts_at: string;
  ends_at: string;
  capacity: number;
}

export interface UpdateSlotInput {
  starts_at?: string;
  ends_at?: string;
  capacity?: number;
  status?: SlotStatus;
}

export interface ActivitiesRepository {
  createActivity(
    hostId: string,
    input: CreateActivityInput
  ): Promise<ActivityResponse | undefined>;
  updateActivity(
    activityId: string,
    ownerId: string,
    input: UpdateActivityInput
  ): Promise<ActivityResponse | undefined>;
  publishActivity(activityId: string, ownerId: string): Promise<ActivityResponse | undefined>;
  pauseActivity(activityId: string, ownerId: string): Promise<ActivityResponse | undefined>;
  archiveActivity(activityId: string, ownerId: string): Promise<ActivityResponse | undefined>;
  createSlot(
    activityId: string,
    ownerId: string,
    input: CreateSlotInput
  ): Promise<ActivitySlotRecord | undefined>;
  updateSlot(
    activityId: string,
    slotId: string,
    ownerId: string,
    input: UpdateSlotInput
  ): Promise<ActivitySlotRecord | undefined>;
  findNearby(query: NearbyActivitiesQuery): Promise<NearbyActivityResponse[]>;
  getActivityDetail(activityId: string): Promise<ActivityDetailResponse | undefined>;
}

export interface FairnessComputation {
  score: number;
  category_median_inr: number | null;
}
