import type {
  CreateActivityDto,
  CreateBookingDto,
  CreateHostProfileDto,
  CreateMessageDto,
  CreatePostDto,
  CreateSlotDto,
  HealthResponse,
  InitPaymentDto,
  NearbyQueryDto,
  UpdateActivityDto,
  UpdateProfileDto,
  UpdateSlotDto
} from '@maidan/shared';

import {
  clearAuthTokens,
  getAuthTokens,
  setAuthTokens,
  type AuthTokens
} from './authTokens';

export const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000'
).replace(/\/+$/, '');

export interface ReadyResponse {
  status: 'ok' | 'unhealthy';
  service: 'api';
  checks: Record<string, { status: 'ok' | 'unhealthy'; latency_ms: number; detail?: string }>;
}

export interface ApiRequestOptions {
  auth?: boolean;
  body?: unknown;
  headers?: HeadersInit;
  method?: string;
  query?: Record<string, string | number | boolean | null | undefined>;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly payload: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const apiClient = {
  getHealth: () => request<HealthResponse>('/health'),
  getReady: () => request<ReadyResponse>('/health/ready'),
  request,
  auth: {
    requestOtp: (phone: string) =>
      request<{ ok: true; expiresInSeconds: number }>('/auth/request-otp', {
        method: 'POST',
        body: { phone },
        auth: false
      }),
    verifyOtp: (phone: string, code: string) =>
      request<AuthTokens>('/auth/verify-otp', {
        method: 'POST',
        body: { phone, code },
        auth: false
      }),
    refresh: (refreshToken: string) =>
      request<AuthTokens>('/auth/refresh', {
        method: 'POST',
        body: { refreshToken },
        auth: false
      })
  },
  activities: {
    create: <TResponse>(body: CreateActivityDto) =>
      request<TResponse>('/activities', { method: 'POST', body }),
    nearby: <TResponse>(query: NearbyQueryDto) =>
      request<TResponse[]>('/activities/nearby', { query, auth: false }),
    mine: <TResponse>() => request<TResponse[]>('/activities/mine'),
    detail: <TResponse>(activityId: string) =>
      request<TResponse>(`/activities/${activityId}`, { auth: false }),
    vibe: <TResponse>(activityId: string) =>
      request<TResponse>(`/activities/${activityId}/vibe`, { auth: false }),
    update: <TResponse>(activityId: string, body: UpdateActivityDto) =>
      request<TResponse>(`/activities/${activityId}`, { method: 'PATCH', body }),
    publish: <TResponse>(activityId: string) =>
      request<TResponse>(`/activities/${activityId}/publish`, { method: 'POST' }),
    pause: <TResponse>(activityId: string) =>
      request<TResponse>(`/activities/${activityId}/pause`, { method: 'POST' }),
    archive: <TResponse>(activityId: string) =>
      request<TResponse>(`/activities/${activityId}/archive`, { method: 'POST' }),
    createSlot: <TResponse>(activityId: string, body: CreateSlotDto) =>
      request<TResponse>(`/activities/${activityId}/slots`, { method: 'POST', body }),
    updateSlot: <TResponse>(activityId: string, slotId: string, body: UpdateSlotDto) =>
      request<TResponse>(`/activities/${activityId}/slots/${slotId}`, {
        method: 'PATCH',
        body
      }),
    bookings: <TResponse>(activityId: string) =>
      request<TResponse[]>(`/activities/${activityId}/bookings`)
  },
  bookings: {
    create: <TResponse>(body: CreateBookingDto) =>
      request<TResponse>('/bookings', { method: 'POST', body }),
    cancel: <TResponse>(bookingId: string) =>
      request<TResponse>(`/bookings/${bookingId}/cancel`, { method: 'POST' }),
    mine: <TResponse>() => request<TResponse[]>('/bookings/me')
  },
  payments: {
    init: <TResponse>(body: InitPaymentDto) =>
      request<TResponse>('/payments/init', { method: 'POST', body })
  },
  profiles: {
    me: <TResponse>() => request<TResponse>('/me'),
    updateMe: <TResponse>(body: UpdateProfileDto) =>
      request<TResponse>('/me', { method: 'PATCH', body }),
    becomeHost: <TResponse>(body: CreateHostProfileDto = {}) =>
      request<TResponse>('/me/become-host', { method: 'POST', body }),
    public: <TResponse>(profileId: string) =>
      request<TResponse>(`/profiles/${profileId}`, { auth: false }),
    follow: <TResponse>(profileId: string) =>
      request<TResponse>(`/profiles/${profileId}/follow`, { method: 'POST' }),
    unfollow: <TResponse>(profileId: string) =>
      request<TResponse>(`/profiles/${profileId}/follow`, { method: 'DELETE' }),
    followers: <TResponse>(profileId: string, cursor?: string) =>
      request<TResponse>(`/profiles/${profileId}/followers`, {
        auth: false,
        query: { cursor }
      }),
    following: <TResponse>(profileId: string, cursor?: string) =>
      request<TResponse>(`/profiles/${profileId}/following`, {
        auth: false,
        query: { cursor }
      }),
    posts: <TResponse>(profileId: string, cursor?: string) =>
      request<TResponse>(`/profiles/${profileId}/posts`, {
        auth: false,
        query: { cursor }
      })
  },
  posts: {
    create: <TResponse>(body: CreatePostDto) =>
      request<TResponse>('/posts', { method: 'POST', body }),
    feed: <TResponse>(scope: 'global' | 'following', cursor?: string) =>
      request<TResponse>('/feed', { query: { scope, cursor } }),
    delete: (postId: string) => request<void>(`/posts/${postId}`, { method: 'DELETE' })
  },
  chats: {
    messages: <TResponse>(chatId: string, cursor?: string) =>
      request<TResponse>(`/chats/${chatId}/messages`, { query: { cursor } }),
    sendMessageBody: (body: CreateMessageDto) => body
  },
  sutradhar: {
    chat: <TResponse>(body: { message: string }) =>
      request<TResponse>('/sutradhar/chat', { method: 'POST', body })
  }
};

async function request<TResponse>(
  path: string,
  options: ApiRequestOptions = {},
  hasRetried = false
): Promise<TResponse> {
  const response = await fetch(buildUrl(path, options.query), buildFetchInit(options));

  if (response.status === 401 && options.auth !== false && !hasRetried) {
    const refreshed = await refreshAccessToken();

    if (refreshed) {
      return request<TResponse>(path, options, true);
    }
  }

  if (!response.ok) {
    const payload = await parseResponse(response);
    throw new ApiError(toApiErrorMessage(payload, response.status), response.status, payload);
  }

  if (response.status === 204) {
    return undefined as TResponse;
  }

  return parseResponse(response) as Promise<TResponse>;
}

function buildFetchInit(options: ApiRequestOptions): RequestInit {
  const headers = new Headers(options.headers);

  if (options.body !== undefined) {
    headers.set('content-type', 'application/json');
  }

  const tokens = getAuthTokens();

  if (options.auth !== false && tokens !== null) {
    headers.set('authorization', `Bearer ${tokens.accessToken}`);
  }

  return {
    credentials: 'include',
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  };
}

function buildUrl(path: string, query: ApiRequestOptions['query']): string {
  const url = new URL(path, API_BASE_URL);

  if (query !== undefined) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  return url.toString();
}

async function refreshAccessToken(): Promise<boolean> {
  const tokens = getAuthTokens();

  if (tokens === null) {
    return false;
  }

  try {
    const refreshedTokens = await apiClient.auth.refresh(tokens.refreshToken);
    setAuthTokens(refreshedTokens);

    return true;
  } catch {
    clearAuthTokens();
    return false;
  }
}

async function parseResponse(response: Response): Promise<unknown> {
  const text = await response.text();

  if (text.length === 0) {
    return undefined;
  }

  return JSON.parse(text) as unknown;
}

function toApiErrorMessage(payload: unknown, status: number): string {
  if (typeof payload === 'object' && payload !== null && 'error' in payload) {
    const error = (payload as { error?: { message?: unknown } }).error;

    if (typeof error?.message === 'string') {
      return error.message;
    }
  }

  return `Request failed with status ${status}`;
}
