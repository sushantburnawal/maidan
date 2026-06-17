import Ajv, { type AnySchema } from 'ajv';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { domainEventSchema, type DomainEvent } from './domain-events';

const eventsJsonSchemaPath = join(__dirname, '..', '..', 'contracts', 'events.schema.json');
const eventsJsonSchema = JSON.parse(readFileSync(eventsJsonSchemaPath, 'utf8')) as AnySchema;

const ajv = new Ajv({ allErrors: true, strict: false });
const validateDomainEventJsonSchema = ajv.compile(eventsJsonSchema);

const sampleEvent: DomainEvent = {
  id: 1,
  aggregate_type: 'booking',
  aggregate_id: '11111111-1111-4111-8111-111111111111',
  event_type: 'booking.created',
  payload: {
    booking_id: '11111111-1111-4111-8111-111111111111',
    slot_id: '22222222-2222-4222-8222-222222222222',
    activity_id: '33333333-3333-4333-8333-333333333333',
    explorer_id: '44444444-4444-4444-8444-444444444444',
    host_id: '55555555-5555-4555-8555-555555555555',
    headcount: 2,
    amount_inr: 2998,
    created_at: '2026-06-17T04:30:00.000Z'
  },
  created_at: '2026-06-17T04:30:00.000Z'
};

describe('domainEventSchema', () => {
  it('round-trips a sample event through zod and JSON Schema validation', () => {
    const zodResult = domainEventSchema.safeParse(sampleEvent);
    const jsonSchemaResult = validateDomainEventJsonSchema(sampleEvent);

    expect(zodResult.success).toBe(true);
    expect(jsonSchemaResult).toBe(true);
    expect(domainEventSchema.parse(sampleEvent)).toEqual(sampleEvent);
  });

  it('rejects the same mismatched event shape in zod and JSON Schema', () => {
    const mismatchedEvent = {
      ...sampleEvent,
      event_type: 'payment.succeeded'
    };

    const zodResult = domainEventSchema.safeParse(mismatchedEvent);
    const jsonSchemaResult = validateDomainEventJsonSchema(mismatchedEvent);

    expect(zodResult.success).toBe(false);
    expect(jsonSchemaResult).toBe(false);
  });
});
