import type {
  Activity,
  ActivitySlot,
  Booking,
  CreateActivityDto,
  CreateBookingDto,
  CreatePostDto,
  CreateSlotDto,
  InitPaymentDto,
  Payment,
  Profile
} from '@maidan/shared';

export type {
  ActivitySlot,
  Booking,
  CreateActivityDto,
  CreateBookingDto,
  CreatePostDto,
  CreateSlotDto,
  InitPaymentDto,
  Payment,
  Profile
};

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresInSeconds: number;
}

export interface OtpState {
  code: string;
  attempts: number;
}

export interface ActivityFairness {
  score: number;
  category_median_inr: number | null;
  suggestion: string;
}

export type ActivityResponse = Omit<Activity, 'embedding'> & {
  fairness: ActivityFairness;
};

export type NearbyActivityResponse = ActivityResponse & {
  distance_m: number | null;
  next_open_slot: ActivitySlot | null;
};

export type ActivityDetailResponse = ActivityResponse & {
  upcoming_open_slots: ActivitySlot[];
};

export interface ActivityVibeResponse {
  activity_id: string;
  title: string;
  pillar: Activity['pillar'];
  participant_count: number;
  people: Array<{
    display_name: string;
    role: 'host' | 'attendee';
  }>;
  shared_interests: Array<{
    tag: string;
    count: number;
  }>;
  summary: string;
}

export interface HostProfileRecord {
  id: string;
  profile_id: string;
  payout_ref: string | null;
}

export interface InitPaymentResponse {
  payment: Payment;
  gateway: Record<string, unknown> | null;
  already_paid: boolean;
}

export interface PaymentWebhookResponse {
  received: boolean;
  applied: boolean;
  payment: Payment | null;
  terminal_status: Payment['status'] | 'ignored';
}

export interface GroupChatRecord {
  id: string;
  activity_id: string;
  title: string;
  created_at: string;
}

export interface MessageRecord {
  id: string;
  chat_id: string;
  sender_id: string;
  body: string;
  created_at: string;
}

export interface PaginatedMessagesResponse {
  items: MessageRecord[];
  next_cursor: string | null;
}

export interface CompactActivityCard {
  id: string;
  title: string;
  pillar: Activity['pillar'];
  next_slot: {
    id: string;
    starts_at: string;
    ends_at: string;
  } | null;
  price: {
    amount_inr: number;
    currency: 'INR';
  };
  fairness_score: number;
}

export interface FeedPostRecord {
  id: string;
  author_id: string;
  body: string;
  media: unknown[];
  linked_activity_id: string | null;
  linked_activity: CompactActivityCard | null;
  created_at: string;
}

export interface PaginatedPostsResponse {
  items: FeedPostRecord[];
  next_cursor: string | null;
}

export interface HealthResponse {
  status: 'ok' | 'unhealthy';
  service: string;
  checks?: Record<string, unknown>;
}

export interface ClaudeUsageBucket {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cost_usd: number;
}

export interface AiMetricsResponse {
  service: 'ai';
  generated_at: string;
  claude: {
    daily: Record<string, unknown>;
    today: {
      date: string;
      haiku: ClaudeUsageBucket;
      sonnet: ClaudeUsageBucket;
    };
  };
}

export interface SutradharFinalEvent {
  type: 'final';
  activity_ids?: string[];
  demand_signal_id?: string;
}
