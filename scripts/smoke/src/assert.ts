export class SmokeAssertionError extends Error {
  constructor(
    message: string,
    readonly value?: unknown
  ) {
    super(value === undefined ? message : `${message}\nvalue: ${formatValue(value)}`);
    this.name = 'SmokeAssertionError';
  }
}

export interface PollOptions {
  description: string;
  timeoutMs?: number;
  intervalMs?: number;
}

export function assertSmoke(condition: unknown, message: string, value?: unknown): asserts condition {
  if (!condition) {
    throw new SmokeAssertionError(message, value);
  }
}

export async function poll<T>(
  readValue: () => Promise<T>,
  isReady: (value: T) => boolean,
  options: PollOptions
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const intervalMs = options.intervalMs ?? 500;
  const startedAt = Date.now();
  let lastValue: T | undefined;

  while (Date.now() - startedAt <= timeoutMs) {
    lastValue = await readValue();

    if (isReady(lastValue)) {
      return lastValue;
    }

    await sleep(intervalMs);
  }

  throw new SmokeAssertionError(`Timed out waiting for ${options.description}`, lastValue);
}

export function formatValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
