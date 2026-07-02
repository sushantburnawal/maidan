import type { Activity, ActivitySlot } from '@maidan/shared';

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
