import { z } from 'zod';

import { geoPointSchema, timestampSchema, uuidSchema } from './common';
import { activityPillarSchema, activityStatusSchema, bookingStatusSchema } from './entities';

export const eventIdSchema = z.number().int().positive();

const domainEventEnvelopeSchema = z
  .object({
    id: eventIdSchema,
    aggregate_id: uuidSchema,
    created_at: timestampSchema
  })
  .strict();

export const activityPublishedPayloadSchema = z
  .object({
    activity_id: uuidSchema,
    host_id: uuidSchema,
    title: z.string().min(1),
    description: z.string().min(1),
    pillar: activityPillarSchema,
    category: z.string().min(1),
    meeting_point: z.string().min(1),
    location: geoPointSchema,
    base_price_inr: z.number().int().min(0),
    published_at: timestampSchema
  })
  .strict();

export const activityUpdatedFieldSchema = z.enum([
  'title',
  'description',
  'pillar',
  'category',
  'meeting_point',
  'location',
  'base_price_inr',
  'capacity',
  'status',
  'media'
]);

export const activityUpdatedPayloadSchema = z
  .object({
    activity_id: uuidSchema,
    host_id: uuidSchema,
    changed_fields: z.array(activityUpdatedFieldSchema).min(1),
    title: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    pillar: activityPillarSchema.optional(),
    category: z.string().min(1).optional(),
    meeting_point: z.string().min(1).optional(),
    location: geoPointSchema.optional(),
    base_price_inr: z.number().int().min(0).optional(),
    capacity: z.number().int().positive().optional(),
    status: activityStatusSchema.optional(),
    updated_at: timestampSchema
  })
  .strict();

export const bookingCreatedPayloadSchema = z
  .object({
    booking_id: uuidSchema,
    slot_id: uuidSchema,
    activity_id: uuidSchema,
    explorer_id: uuidSchema,
    host_id: uuidSchema,
    headcount: z.number().int().positive(),
    amount_inr: z.number().int().min(0),
    created_at: timestampSchema
  })
  .strict();

export const bookingConfirmedPayloadSchema = z
  .object({
    booking_id: uuidSchema,
    slot_id: uuidSchema,
    activity_id: uuidSchema,
    explorer_id: uuidSchema,
    host_id: uuidSchema,
    payment_id: uuidSchema,
    headcount: z.number().int().positive(),
    amount_inr: z.number().int().min(0),
    confirmed_at: timestampSchema
  })
  .strict();

export const bookingCancelledPayloadSchema = z
  .object({
    booking_id: uuidSchema,
    slot_id: uuidSchema,
    activity_id: uuidSchema,
    explorer_id: uuidSchema,
    host_id: uuidSchema,
    payment_id: uuidSchema.nullable(),
    previous_status: bookingStatusSchema,
    headcount: z.number().int().positive(),
    amount_inr: z.number().int().min(0),
    cancelled_at: timestampSchema
  })
  .strict();

export const paymentSucceededPayloadSchema = z
  .object({
    payment_id: uuidSchema,
    booking_id: uuidSchema,
    phonepe_order_id: z.string().min(1),
    phonepe_txn_id: z.string().min(1),
    amount_inr: z.number().int().min(0),
    platform_fee_inr: z.number().int().min(0),
    host_payout_inr: z.number().int().min(0),
    succeeded_at: timestampSchema
  })
  .strict();

export const paymentFailedPayloadSchema = z
  .object({
    payment_id: uuidSchema,
    booking_id: uuidSchema,
    phonepe_order_id: z.string().min(1),
    amount_inr: z.number().int().min(0),
    failure_code: z.string().min(1).optional(),
    failure_reason: z.string().min(1).optional(),
    failed_at: timestampSchema
  })
  .strict();

export const reviewCreatedPayloadSchema = z
  .object({
    review_id: uuidSchema,
    booking_id: uuidSchema,
    activity_id: uuidSchema,
    explorer_id: uuidSchema,
    host_id: uuidSchema,
    rating: z.number().int().min(1).max(5),
    body: z.string().nullable(),
    created_at: timestampSchema
  })
  .strict();

export const postCreatedPayloadSchema = z
  .object({
    post_id: uuidSchema,
    author_id: uuidSchema,
    linked_activity_id: uuidSchema.nullable(),
    body: z.string().min(1),
    media_count: z.number().int().min(0),
    created_at: timestampSchema
  })
  .strict();

export const messageCreatedPayloadSchema = z
  .object({
    message_id: uuidSchema,
    chat_id: uuidSchema,
    sender_id: uuidSchema,
    activity_id: uuidSchema.nullable(),
    body: z.string().min(1),
    created_at: timestampSchema
  })
  .strict();

export const moderationTargetTypeSchema = z.enum(['post', 'message']);

export const moderationBlockedPayloadSchema = z
  .object({
    target_type: moderationTargetTypeSchema,
    target_id: uuidSchema,
    author_id: uuidSchema,
    severity: z.number().int().min(0).max(3),
    categories: z.array(z.string().min(1)),
    reason: z.string().min(1),
    created_at: timestampSchema
  })
  .strict();

export const activityPublishedEventSchema = domainEventEnvelopeSchema
  .extend({
    aggregate_type: z.literal('activity'),
    event_type: z.literal('activity.published'),
    payload: activityPublishedPayloadSchema
  })
  .strict();

export const activityUpdatedEventSchema = domainEventEnvelopeSchema
  .extend({
    aggregate_type: z.literal('activity'),
    event_type: z.literal('activity.updated'),
    payload: activityUpdatedPayloadSchema
  })
  .strict();

export const bookingCreatedEventSchema = domainEventEnvelopeSchema
  .extend({
    aggregate_type: z.literal('booking'),
    event_type: z.literal('booking.created'),
    payload: bookingCreatedPayloadSchema
  })
  .strict();

export const bookingConfirmedEventSchema = domainEventEnvelopeSchema
  .extend({
    aggregate_type: z.literal('booking'),
    event_type: z.literal('booking.confirmed'),
    payload: bookingConfirmedPayloadSchema
  })
  .strict();

export const bookingCancelledEventSchema = domainEventEnvelopeSchema
  .extend({
    aggregate_type: z.literal('booking'),
    event_type: z.literal('booking.cancelled'),
    payload: bookingCancelledPayloadSchema
  })
  .strict();

export const paymentSucceededEventSchema = domainEventEnvelopeSchema
  .extend({
    aggregate_type: z.literal('payment'),
    event_type: z.literal('payment.succeeded'),
    payload: paymentSucceededPayloadSchema
  })
  .strict();

export const paymentFailedEventSchema = domainEventEnvelopeSchema
  .extend({
    aggregate_type: z.literal('payment'),
    event_type: z.literal('payment.failed'),
    payload: paymentFailedPayloadSchema
  })
  .strict();

export const reviewCreatedEventSchema = domainEventEnvelopeSchema
  .extend({
    aggregate_type: z.literal('review'),
    event_type: z.literal('review.created'),
    payload: reviewCreatedPayloadSchema
  })
  .strict();

export const postCreatedEventSchema = domainEventEnvelopeSchema
  .extend({
    aggregate_type: z.literal('post'),
    event_type: z.literal('post.created'),
    payload: postCreatedPayloadSchema
  })
  .strict();

export const messageCreatedEventSchema = domainEventEnvelopeSchema
  .extend({
    aggregate_type: z.literal('message'),
    event_type: z.literal('message.created'),
    payload: messageCreatedPayloadSchema
  })
  .strict();

export const moderationBlockedEventSchema = domainEventEnvelopeSchema
  .extend({
    aggregate_type: z.literal('moderation'),
    event_type: z.literal('moderation.blocked'),
    payload: moderationBlockedPayloadSchema
  })
  .strict();

export const domainEventSchema = z.discriminatedUnion('event_type', [
  activityPublishedEventSchema,
  activityUpdatedEventSchema,
  bookingCreatedEventSchema,
  bookingConfirmedEventSchema,
  bookingCancelledEventSchema,
  paymentSucceededEventSchema,
  paymentFailedEventSchema,
  reviewCreatedEventSchema,
  postCreatedEventSchema,
  messageCreatedEventSchema,
  moderationBlockedEventSchema
]);

export const domainEventTypeSchema = z.enum([
  'activity.published',
  'activity.updated',
  'booking.created',
  'booking.confirmed',
  'booking.cancelled',
  'payment.succeeded',
  'payment.failed',
  'review.created',
  'post.created',
  'message.created',
  'moderation.blocked'
]);

export type ActivityPublishedPayload = z.infer<typeof activityPublishedPayloadSchema>;
export type ActivityUpdatedPayload = z.infer<typeof activityUpdatedPayloadSchema>;
export type BookingCreatedPayload = z.infer<typeof bookingCreatedPayloadSchema>;
export type BookingConfirmedPayload = z.infer<typeof bookingConfirmedPayloadSchema>;
export type BookingCancelledPayload = z.infer<typeof bookingCancelledPayloadSchema>;
export type PaymentSucceededPayload = z.infer<typeof paymentSucceededPayloadSchema>;
export type PaymentFailedPayload = z.infer<typeof paymentFailedPayloadSchema>;
export type ReviewCreatedPayload = z.infer<typeof reviewCreatedPayloadSchema>;
export type PostCreatedPayload = z.infer<typeof postCreatedPayloadSchema>;
export type MessageCreatedPayload = z.infer<typeof messageCreatedPayloadSchema>;
export type ModerationTargetType = z.infer<typeof moderationTargetTypeSchema>;
export type ModerationBlockedPayload = z.infer<typeof moderationBlockedPayloadSchema>;

export type ActivityUpdatedField = z.infer<typeof activityUpdatedFieldSchema>;
export type DomainEventType = z.infer<typeof domainEventTypeSchema>;
export type DomainEvent = z.infer<typeof domainEventSchema>;
