import type { Follow, FollowProfileSummaryResponse, FollowsPageResponse } from '@maidan/shared';

export type FollowRecord = Follow;

export interface FollowCreateResult {
  status: 'created' | 'already_exists' | 'followee_not_found';
  follow?: FollowRecord;
}

export interface FollowsCursor {
  created_at: string;
  id: string;
}

export interface FollowsPageInput {
  limit: number;
  cursor?: FollowsCursor;
  viewerId?: string;
}

export interface FollowProfileSummaryRecord extends FollowProfileSummaryResponse {
  followed_at: string;
}

export type PaginatedFollowsResponse = FollowsPageResponse;

export interface FollowCounts {
  follower_count: number;
  following_count: number;
}

export interface FollowsRepository {
  createFollow(followerId: string, followeeId: string): Promise<FollowCreateResult>;
  deleteFollow(followerId: string, followeeId: string): Promise<void>;
  findFollowers(profileId: string, input: FollowsPageInput): Promise<FollowProfileSummaryRecord[]>;
  findFollowing(profileId: string, input: FollowsPageInput): Promise<FollowProfileSummaryRecord[]>;
  findFolloweeIds(followerId: string): Promise<string[]>;
  getCounts(profileId: string): Promise<FollowCounts>;
  isFollowing(followerId: string, followeeId: string): Promise<boolean>;
}
