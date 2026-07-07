import { expect, test, type Page } from '@playwright/test';
import net from 'node:net';

const phonePrefix = '+919902';

test.describe('Activity creation', () => {
  test('fresh OTP user can publish the prefilled activity and see save feedback', async ({
    context,
    page
  }) => {
    test.setTimeout(90_000);

    await onboardWithOtp(page, `${phonePrefix}${randomSixDigits()}`);
    await context.setGeolocation({ latitude: 12.9716, longitude: 77.5946 });

    await page.goto('/activities/new');
    await expect(page.getByTestId('activity-location-map')).toBeVisible();
    await page.getByRole('button', { name: 'Use my location' }).click();
    await expect(page.getByTestId('activity-location-coordinates')).toContainText(
      '12.971600, 77.594600'
    );

    await page.getByRole('button', { name: 'Create and publish' }).click();

    await expect(page).toHaveURL(/\/activities\/[0-9a-f-]+\/manage$/, { timeout: 30_000 });
    await expect(
      page.getByRole('heading', { name: 'Nandi Hills sunrise mobility circle' })
    ).toBeVisible();

    await page.getByRole('button', { name: 'Save changes' }).click();

    await expect(page.getByText('Changes saved')).toBeVisible({ timeout: 15_000 });
  });
});

async function onboardWithOtp(page: Page, phone: string): Promise<void> {
  await page.goto('/onboarding');
  await page.getByLabel('Phone').fill(phone);
  await page.getByRole('button', { name: 'Send OTP' }).click();

  await page.getByLabel('OTP').fill(await readOtpFromRedis(phone));
  await page.getByRole('button', { name: 'Verify and enter' }).click();
  await expect(page).toHaveURL(/\/map$/, { timeout: 30_000 });
}

async function readOtpFromRedis(phone: string): Promise<string> {
  const deadline = Date.now() + 10_000;
  const key = `otp:${phone}`;

  while (Date.now() < deadline) {
    const rawValue = await redisGet(key).catch(() => null);
    const code = parseOtpCode(rawValue);

    if (code !== null) {
      return code;
    }

    await delay(250);
  }

  throw new Error(`Timed out waiting for OTP in Redis key ${key}`);
}

function parseOtpCode(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as { code?: unknown };

    return typeof parsed.code === 'string' && /^[0-9]{6}$/.test(parsed.code) ? parsed.code : null;
  } catch {
    return null;
  }
}

function redisGet(key: string): Promise<string | null> {
  const host = process.env.REDIS_HOST ?? '127.0.0.1';
  const port = Number(process.env.REDIS_PORT ?? '6379');
  const command = encodeRedisCommand(['GET', key]);

  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let buffer = Buffer.alloc(0);
    let settled = false;

    const settle = (result: string | null, error?: Error): void => {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy();

      if (error !== undefined) {
        reject(error);
        return;
      }

      resolve(result);
    };

    socket.setTimeout(2_000);
    socket.on('connect', () => socket.write(command));
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      try {
        const parsed = parseRedisBulkString(buffer);

        if (parsed.ready) {
          settle(parsed.value);
        }
      } catch (error) {
        settle(null, error instanceof Error ? error : new Error('Redis response parse failed'));
      }
    });
    socket.on('timeout', () => settle(null, new Error('Redis GET timed out')));
    socket.on('error', (error) => settle(null, error));
  });
}

function parseRedisBulkString(buffer: Buffer): { ready: boolean; value: string | null } {
  const headerEnd = buffer.indexOf('\r\n');

  if (headerEnd === -1) {
    return { ready: false, value: null };
  }

  const header = buffer.subarray(0, headerEnd).toString('utf8');

  if (header === '$-1') {
    return { ready: true, value: null };
  }

  if (!header.startsWith('$')) {
    throw new Error(`Unexpected Redis response: ${header}`);
  }

  const length = Number(header.slice(1));
  const valueStart = headerEnd + 2;
  const valueEnd = valueStart + length;

  if (!Number.isInteger(length) || length < 0) {
    throw new Error(`Invalid Redis bulk string length: ${header}`);
  }

  if (buffer.length < valueEnd + 2) {
    return { ready: false, value: null };
  }

  return { ready: true, value: buffer.subarray(valueStart, valueEnd).toString('utf8') };
}

function encodeRedisCommand(parts: string[]): string {
  return `*${parts.length}\r\n${parts
    .map((part) => `$${Buffer.byteLength(part)}\r\n${part}\r\n`)
    .join('')}`;
}

function randomSixDigits(): string {
  return String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
