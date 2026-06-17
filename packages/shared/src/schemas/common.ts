import { z } from 'zod';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema)
  ])
);

export const uuidSchema = z.string().uuid();
export const timestampSchema = z.string().datetime({ offset: true });
export const e164PhoneSchema = z.string().regex(/^\+[1-9][0-9]{1,14}$/);
export const inrCurrencySchema = z.literal('INR');

export const latitudeSchema = z.number().min(-90).max(90);
export const longitudeSchema = z.number().min(-180).max(180);

export const geoPointSchema = z
  .object({
    lat: latitudeSchema,
    lng: longitudeSchema
  })
  .strict();

export const mediaSchema = z.array(jsonValueSchema);

export type Uuid = z.infer<typeof uuidSchema>;
export type Timestamp = z.infer<typeof timestampSchema>;
export type E164Phone = z.infer<typeof e164PhoneSchema>;
export type InrCurrency = z.infer<typeof inrCurrencySchema>;
export type GeoPoint = z.infer<typeof geoPointSchema>;
export type Media = z.infer<typeof mediaSchema>;
