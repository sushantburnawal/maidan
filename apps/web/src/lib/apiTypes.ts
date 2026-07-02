import type { Activity, ActivityPillar, ActivitySlot, Profile } from '@maidan/shared';

export interface ActivityFairness {
  score: number;
  category_median_inr: number | null;
  suggestion: string;
}

export type ApiActivity = Omit<Activity, 'embedding'> & {
  fairness: ActivityFairness;
};

export type NearbyActivity = ApiActivity & {
  distance_m: number | null;
  next_open_slot: ActivitySlot | null;
};

export type ActivityDetail = ApiActivity & {
  upcoming_open_slots: ActivitySlot[];
};

export type PublicProfile = Omit<Profile, 'phone' | 'created_at' | 'updated_at'> & {
  follower_count: number;
  following_count: number;
  is_following?: boolean;
};

export interface ActivityVibePerson {
  display_name: string;
  role: 'host' | 'attendee';
}

export interface ActivityVibeInterest {
  tag: string;
  count: number;
}

export interface ActivityVibe {
  activity_id: string;
  title: string;
  pillar: ActivityPillar;
  participant_count: number;
  people: ActivityVibePerson[];
  shared_interests: ActivityVibeInterest[];
  summary: string;
}
