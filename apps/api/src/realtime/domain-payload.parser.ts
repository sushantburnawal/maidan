type SafeParseResult<T> =
  | {
      success: true;
      data: T;
    }
  | {
      success: false;
      error: unknown;
    };

interface DomainPayloadSchema<T> {
  safeParse(value: unknown): SafeParseResult<T>;
}

export function parseDomainPayload<T>(
  schema: DomainPayloadSchema<T>,
  payload: Record<string, unknown>
): SafeParseResult<T> {
  const { correlation_id: _correlationId, ...domainPayload } = payload;

  return schema.safeParse(domainPayload);
}
