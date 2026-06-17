import { z } from 'zod';

import { geoPointSchema, mediaSchema, uuidSchema } from './common';
import { activityPillarSchema, slotStatusSchema } from './entities';

const optionalString = z.string().min(1).optional();
const optionalNullableString = z.string().min(1).nullable().optional();

const hasAtLeastOneKey = <T extends object>(value: T): boolean => Object.keys(value).length > 0;

const queryLatitudeSchema = z.coerce.number().min(-90).max(90);
const queryLongitudeSchema = z.coerce.number().min(-180).max(180);

export const createProfileDtoSchema = z
  .object({
    phone: z.string().regex(/^\+[1-9][0-9]{1,14}$/),
    displayName: z.string().min(1),
    avatarUrl: z.string().min(1).nullable().optional(),
    bio: z.string().min(1).nullable().optional(),
    interests: z.array(z.string().min(1)).default([]),
    homeLocation: geoPointSchema.nullable().optional()
  })
  .strict();

export const updateProfileDtoSchema = createProfileDtoSchema
  .omit({ phone: true })
  .partial()
  .refine(hasAtLeastOneKey, { message: 'at least one profile field is required' });

export const createHostProfileDtoSchema = z
  .object({
    payoutRef: z.string().min(1).nullable().optional()
  })
  .strict();

export const createActivityDtoSchema = z
  .object({
    title: z.string().min(1),
    description: z.string().min(1),
    pillar: activityPillarSchema,
    category: z.string().min(1),
    meetingPoint: z.string().min(1),
    location: geoPointSchema,
    basePriceInr: z.number().int().min(0),
    capacity: z.number().int().positive(),
    media: mediaSchema.default([])
  })
  .strict();

export const updateActivityDtoSchema = z
  .object({
    title: optionalString,
    description: optionalString,
    pillar: activityPillarSchema.optional(),
    category: optionalString,
    meetingPoint: optionalString,
    location: geoPointSchema.optional(),
    basePriceInr: z.number().int().min(0).optional(),
    capacity: z.number().int().positive().optional(),
    media: mediaSchema.optional()
  })
  .strict()
  .refine(hasAtLeastOneKey, { message: 'at least one activity field is required' });

export const createSlotDtoSchema = z
  .object({
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }),
    capacity: z.number().int().positive()
  })
  .strict()
  .refine((slot) => new Date(slot.endsAt).getTime() > new Date(slot.startsAt).getTime(), {
    message: 'endsAt must be after startsAt',
    path: ['endsAt']
  });

export const updateSlotDtoSchema = z
  .object({
    startsAt: z.string().datetime({ offset: true }).optional(),
    endsAt: z.string().datetime({ offset: true }).optional(),
    capacity: z.number().int().positive().optional(),
    status: slotStatusSchema.optional()
  })
  .strict()
  .refine(hasAtLeastOneKey, { message: 'at least one slot field is required' })
  .refine(
    (slot) =>
      slot.startsAt === undefined ||
      slot.endsAt === undefined ||
      new Date(slot.endsAt).getTime() > new Date(slot.startsAt).getTime(),
    {
      message: 'endsAt must be after startsAt',
      path: ['endsAt']
    }
  );

export const nearbyQueryDtoSchema = z
  .object({
    lat: queryLatitudeSchema.optional(),
    lng: queryLongitudeSchema.optional(),
    radiusKm: z.coerce.number().positive().max(100).default(10),
    pillar: activityPillarSchema.optional(),
    north: queryLatitudeSchema.optional(),
    south: queryLatitudeSchema.optional(),
    east: queryLongitudeSchema.optional(),
    west: queryLongitudeSchema.optional()
  })
  .strict()
  .refine((query) => (query.lat === undefined) === (query.lng === undefined), {
    message: 'lat and lng must be provided together',
    path: ['lng']
  })
  .refine(
    (query) => {
      const bboxValues = [query.north, query.south, query.east, query.west];
      const hasAnyBboxValue = bboxValues.some((value) => value !== undefined);
      const hasAllBboxValues = bboxValues.every((value) => value !== undefined);

      return !hasAnyBboxValue || hasAllBboxValues;
    },
    {
      message: 'north, south, east, and west must be provided together',
      path: ['north']
    }
  )
  .refine(
    (query) => {
      const hasPoint = query.lat !== undefined && query.lng !== undefined;
      const hasBbox =
        query.north !== undefined &&
        query.south !== undefined &&
        query.east !== undefined &&
        query.west !== undefined;

      return hasPoint || hasBbox;
    },
    {
      message: 'provide either lat/lng or north/south/east/west',
      path: ['lat']
    }
  )
  .refine(
    (query) => query.north === undefined || query.south === undefined || query.north > query.south,
    {
      message: 'north must be greater than south',
      path: ['north']
    }
  );

export const createBookingDtoSchema = z
  .object({
    slotId: uuidSchema,
    headcount: z.number().int().positive().default(1)
  })
  .strict();

export const initPaymentDtoSchema = z
  .object({
    bookingId: uuidSchema
  })
  .strict();

export const createReviewDtoSchema = z
  .object({
    bookingId: uuidSchema,
    rating: z.number().int().min(1).max(5),
    body: optionalNullableString
  })
  .strict();

export const createPostDtoSchema = z
  .object({
    body: z.string().min(1),
    media: mediaSchema.default([]),
    linkedActivityId: uuidSchema.nullable().optional()
  })
  .strict();

export const createMessageDtoSchema = z
  .object({
    chatId: uuidSchema,
    body: z.string().min(1)
  })
  .strict();

export type CreateProfileDto = z.infer<typeof createProfileDtoSchema>;
export type UpdateProfileDto = z.infer<typeof updateProfileDtoSchema>;
export type CreateHostProfileDto = z.infer<typeof createHostProfileDtoSchema>;
export type CreateActivityDto = z.infer<typeof createActivityDtoSchema>;
export type UpdateActivityDto = z.infer<typeof updateActivityDtoSchema>;
export type CreateSlotDto = z.infer<typeof createSlotDtoSchema>;
export type UpdateSlotDto = z.infer<typeof updateSlotDtoSchema>;
export type NearbyQueryDto = z.infer<typeof nearbyQueryDtoSchema>;
export type CreateBookingDto = z.infer<typeof createBookingDtoSchema>;
export type InitPaymentDto = z.infer<typeof initPaymentDtoSchema>;
export type CreateReviewDto = z.infer<typeof createReviewDtoSchema>;
export type CreatePostDto = z.infer<typeof createPostDtoSchema>;
export type CreateMessageDto = z.infer<typeof createMessageDtoSchema>;
