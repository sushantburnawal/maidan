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
  const domainPayload = { ...payload };
  delete domainPayload.correlation_id;

  return schema.safeParse(domainPayload);
}
