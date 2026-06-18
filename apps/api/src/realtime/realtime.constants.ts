export const REALTIME_REPOSITORY = Symbol('REALTIME_REPOSITORY');

export const DEFAULT_MESSAGES_LIMIT = 50;
export const MAX_MESSAGES_LIMIT = 100;

export const REALTIME_LAST_EVENT_ID_KEY = 'maidan:realtime:last-domain-event-id';
export const REALTIME_USER_PRESENCE_KEY_PREFIX = 'maidan:realtime:presence:user:';

export function realtimeUserPresenceKey(profileId: string): string {
  return `${REALTIME_USER_PRESENCE_KEY_PREFIX}${profileId}`;
}
