import type {
  Activity,
  ActivityPillar,
  ActivitySlot,
  Booking,
  GroupChat,
  Message,
  Payment,
  PaymentStatus,
  Post,
  Profile
} from '@maidan/shared';

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

export interface CreateBookingResponse {
  booking: Booking;
  payment_required_next: boolean;
}

export interface PaymentGatewayOrder {
  orderId: string;
  state: string;
  expireAt: number | null;
  redirectUrl: string | null;
  intentPayload: Record<string, unknown> | null;
  raw: Record<string, unknown>;
}

export interface InitPaymentResponse {
  payment: Payment;
  gateway: PaymentGatewayOrder | null;
  already_paid: boolean;
}

export interface PaymentWebhookResponse {
  received: boolean;
  applied: boolean;
  payment: Payment | null;
  terminal_status: PaymentStatus | 'ignored';
}

export interface JoinedChatState {
  activityId: string;
  chat: GroupChat;
}

export type ApiPost = Pick<
  Post,
  'id' | 'author_id' | 'body' | 'media' | 'linked_activity_id' | 'created_at'
>;

export interface CompactFeedActivitySlot {
  id: string;
  starts_at: string;
  ends_at: string;
}

export interface CompactFeedActivityCard {
  id: string;
  title: string;
  pillar: ActivityPillar;
  next_slot: CompactFeedActivitySlot | null;
  price: {
    amount_inr: number;
    currency: 'INR';
  };
  fairness_score: number;
}

export type FeedPost = ApiPost & {
  linked_activity: CompactFeedActivityCard | null;
};

export interface PaginatedFeedResponse {
  items: FeedPost[];
  next_cursor: string | null;
}

export type ChatMessage = Pick<Message, 'id' | 'chat_id' | 'sender_id' | 'body' | 'created_at'>;

export interface PaginatedMessagesResponse {
  items: ChatMessage[];
  next_cursor: string | null;
}
