import type { ActivityPillar, JsonValue } from '@maidan/shared';

export type PostMedia = JsonValue[];

export interface PostRecord {
  id: string;
  author_id: string;
  body: string;
  media: PostMedia;
  linked_activity_id: string | null;
  created_at: string;
}

export interface CompactActivitySlot {
  id: string;
  starts_at: string;
  ends_at: string;
}

export interface CompactActivityCard {
  id: string;
  title: string;
  pillar: ActivityPillar;
  next_slot: CompactActivitySlot | null;
  price: {
    amount_inr: number;
    currency: 'INR';
  };
  fairness_score: number;
}

export type FeedPostRecord = PostRecord & {
  linked_activity: CompactActivityCard | null;
};

export interface PaginatedPostsResponse {
  items: FeedPostRecord[];
  next_cursor: string | null;
}

export interface CreatePostInput {
  body: string;
  media: PostMedia;
  linked_activity_id: string | null;
}

export interface PostsCursor {
  created_at: string;
  id: string;
}

export interface PostsPageInput {
  limit: number;
  cursor?: PostsCursor;
}

export interface PostsRepository {
  createPost(authorId: string, input: CreatePostInput): Promise<PostRecord | undefined>;
  findFeed(input: PostsPageInput): Promise<FeedPostRecord[]>;
  findProfilePosts(profileId: string, input: PostsPageInput): Promise<FeedPostRecord[]>;
  deletePost(postId: string, authorId: string): Promise<boolean>;
}
