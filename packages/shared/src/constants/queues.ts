export const STREAM_DOMAIN_EVENTS = 'maidan.events' as const;
export const QUEUE_EMBEDDINGS = 'maidan.embeddings' as const;
export const QUEUE_MODERATION = 'maidan.moderation' as const;
export const QUEUE_NOTIFICATIONS = 'maidan.notifications' as const;

export const QUEUE_NAMES = Object.freeze({
  STREAM_DOMAIN_EVENTS,
  QUEUE_EMBEDDINGS,
  QUEUE_MODERATION,
  QUEUE_NOTIFICATIONS
});

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];
