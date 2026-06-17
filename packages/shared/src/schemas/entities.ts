import { z } from 'zod';

import {
  e164PhoneSchema,
  geoPointSchema,
  inrCurrencySchema,
  jsonValueSchema,
  mediaSchema,
  timestampSchema,
  uuidSchema
} from './common';

export const activityPillarSchema = z.enum(['move', 'learn', 'feel']);
export const activityStatusSchema = z.enum(['draft', 'published', 'paused', 'archived']);
export const slotStatusSchema = z.enum(['open', 'full', 'closed', 'cancelled']);
export const bookingStatusSchema = z.enum(['pending', 'confirmed', 'cancelled', 'refunded']);
export const paymentStatusSchema = z.enum(['initiated', 'success', 'failed', 'refunded']);

export const profileSchema = z
  .object({
    id: uuidSchema,
    phone: e164PhoneSchema,
    display_name: z.string().min(1),
    avatar_url: z.string().nullable(),
    bio: z.string().nullable(),
    interests: z.array(z.string()),
    home_location: geoPointSchema.nullable(),
    created_at: timestampSchema,
    updated_at: timestampSchema
  })
  .strict();

export const hostProfileSchema = z
  .object({
    id: uuidSchema,
    profile_id: uuidSchema,
    is_verified: z.boolean(),
    payout_ref: z.string().nullable(),
    rating: z.number().min(0).max(5),
    total_activities: z.number().int().min(0),
    created_at: timestampSchema,
    updated_at: timestampSchema
  })
  .strict();

export const activitySchema = z
  .object({
    id: uuidSchema,
    host_id: uuidSchema,
    title: z.string().min(1),
    description: z.string().min(1),
    pillar: activityPillarSchema,
    category: z.string().min(1),
    meeting_point: z.string().min(1),
    location: geoPointSchema,
    base_price_inr: z.number().int().min(0),
    currency: inrCurrencySchema,
    capacity: z.number().int().positive(),
    fairness_score: z.number().min(0),
    status: activityStatusSchema,
    media: mediaSchema,
    embedding: z.array(z.number()).length(768).nullable(),
    created_at: timestampSchema,
    updated_at: timestampSchema
  })
  .strict();

export const activitySlotSchema = z
  .object({
    id: uuidSchema,
    activity_id: uuidSchema,
    starts_at: timestampSchema,
    ends_at: timestampSchema,
    capacity: z.number().int().positive(),
    booked_count: z.number().int().min(0),
    status: slotStatusSchema,
    created_at: timestampSchema,
    updated_at: timestampSchema
  })
  .strict()
  .refine((slot) => slot.booked_count <= slot.capacity, {
    message: 'booked_count must be less than or equal to capacity',
    path: ['booked_count']
  });

export const slotSchema = activitySlotSchema;

export const bookingSchema = z
  .object({
    id: uuidSchema,
    slot_id: uuidSchema,
    explorer_id: uuidSchema,
    headcount: z.number().int().positive(),
    amount_inr: z.number().int().min(0),
    status: bookingStatusSchema,
    payment_id: uuidSchema.nullable(),
    created_at: timestampSchema,
    updated_at: timestampSchema
  })
  .strict();

export const paymentSchema = z
  .object({
    id: uuidSchema,
    booking_id: uuidSchema,
    phonepe_order_id: z.string().min(1),
    phonepe_txn_id: z.string().min(1).nullable(),
    amount_inr: z.number().int().min(0),
    platform_fee_inr: z.number().int().min(0),
    host_payout_inr: z.number().int().min(0),
    status: paymentStatusSchema,
    raw_callback: jsonValueSchema.nullable(),
    created_at: timestampSchema,
    updated_at: timestampSchema
  })
  .strict()
  .refine((payment) => payment.platform_fee_inr + payment.host_payout_inr === payment.amount_inr, {
    message: 'platform_fee_inr plus host_payout_inr must equal amount_inr',
    path: ['amount_inr']
  });

export const reviewSchema = z
  .object({
    id: uuidSchema,
    booking_id: uuidSchema,
    rating: z.number().int().min(1).max(5),
    body: z.string().nullable(),
    created_at: timestampSchema
  })
  .strict();

export const postSchema = z
  .object({
    id: uuidSchema,
    author_id: uuidSchema,
    body: z.string().min(1),
    media: mediaSchema,
    linked_activity_id: uuidSchema.nullable(),
    created_at: timestampSchema
  })
  .strict();

export const groupChatSchema = z
  .object({
    id: uuidSchema,
    activity_id: uuidSchema,
    title: z.string().min(1),
    created_at: timestampSchema
  })
  .strict();

export const chatMemberSchema = z
  .object({
    chat_id: uuidSchema,
    profile_id: uuidSchema,
    joined_at: timestampSchema
  })
  .strict();

export const messageSchema = z
  .object({
    id: uuidSchema,
    chat_id: uuidSchema,
    sender_id: uuidSchema,
    body: z.string().min(1),
    created_at: timestampSchema
  })
  .strict();

export const domainEventRecordSchema = z
  .object({
    id: z.number().int().positive(),
    aggregate_type: z.string().min(1),
    aggregate_id: uuidSchema,
    event_type: z.string().min(1),
    payload: jsonValueSchema,
    created_at: timestampSchema,
    processed_at: timestampSchema.nullable()
  })
  .strict();

export type ActivityPillar = z.infer<typeof activityPillarSchema>;
export type ActivityStatus = z.infer<typeof activityStatusSchema>;
export type SlotStatus = z.infer<typeof slotStatusSchema>;
export type BookingStatus = z.infer<typeof bookingStatusSchema>;
export type PaymentStatus = z.infer<typeof paymentStatusSchema>;

export type Profile = z.infer<typeof profileSchema>;
export type HostProfile = z.infer<typeof hostProfileSchema>;
export type Activity = z.infer<typeof activitySchema>;
export type ActivitySlot = z.infer<typeof activitySlotSchema>;
export type Slot = ActivitySlot;
export type Booking = z.infer<typeof bookingSchema>;
export type Payment = z.infer<typeof paymentSchema>;
export type Review = z.infer<typeof reviewSchema>;
export type Post = z.infer<typeof postSchema>;
export type GroupChat = z.infer<typeof groupChatSchema>;
export type ChatMember = z.infer<typeof chatMemberSchema>;
export type Message = z.infer<typeof messageSchema>;
export type DomainEventRecord = z.infer<typeof domainEventRecordSchema>;
