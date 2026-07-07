import { expect, test, type APIRequestContext } from '@playwright/test';
import net from 'node:net';

const apiBaseUrl = process.env.API_BASE_URL ?? 'http://localhost:3000';
const explorerPhonePrefix = '+919903';
const nandiTitle = 'Nandi Hills sunrise trail ride';

test.describe('Maidan local journey', () => {
  test('onboards, books and pays for Nandi, chats, follows Hemant, and sees his post', async ({
    page,
    request
  }) => {
    test.setTimeout(180_000);
    const explorerPhone = `${explorerPhonePrefix}${randomSixDigits()}`;

    await test.step('wait for the live API', async () => {
      await expect
        .poll(
          async () => {
            const response = await request.get(`${apiBaseUrl}/health/ready`);

            if (!response.ok()) {
              return 'down';
            }

            const payload = (await response.json()) as { status?: string };

            return payload.status ?? 'unknown';
          },
          { timeout: 30_000 }
        )
        .toBe('ok');
    });

    await test.step('onboard with phone OTP', async () => {
      await page.goto('/onboarding');
      await page.getByLabel('Phone').fill(explorerPhone);
      await page.getByRole('button', { name: 'Send OTP' }).click();

      const code = await readOtpFromRedis(explorerPhone);

      await page.getByLabel('OTP').fill(code);
      await page.getByRole('button', { name: 'Verify and enter' }).click();
      await expect(page).toHaveURL(/\/map$/);
      await expect(page.getByText('connected', { exact: true })).toBeVisible({ timeout: 30_000 });
    });

    let activityId = '';

    await test.step('open the Nandi ride', async () => {
      const activity = await findNearbyActivityByTitle(request, nandiTitle);

      await page.goto(`/activities/${activity.id}`);
      await expect(page.getByRole('heading', { name: nandiTitle })).toBeVisible({
        timeout: 30_000
      });
      activityId = activity.id;
    });

    await test.step('book and complete the fake payment', async () => {
      await page.getByTestId('slot-join-button').first().click();
      await expect(page.getByRole('heading', { name: nandiTitle })).toBeVisible({
        timeout: 30_000
      });

      await page.getByTestId('book-spot-button').click();
      await expect(page.getByTestId('complete-fake-payment-button')).toBeVisible({
        timeout: 30_000
      });
      await page.getByTestId('complete-fake-payment-button').click();
      await expect(
        page.getByText('Waiting for booking confirmation and chat invite...')
      ).toBeVisible();
      await expect(page).toHaveURL(/\/chats\/.+activityId=/, { timeout: 60_000 });
    });

    await test.step('send a group chat message', async () => {
      const chatMessage = `W10 e2e chat ${Date.now()}`;

      await expect(page.getByRole('heading', { name: nandiTitle })).toBeVisible({
        timeout: 30_000
      });
      await page.getByTestId('chat-message-input').fill(chatMessage);
      await expect(page.getByTestId('send-chat-message-button')).toBeEnabled({
        timeout: 15_000
      });
      await page.getByTestId('send-chat-message-button').click();
      await expect(page.getByTestId('chat-message-list')).toContainText(chatMessage, {
        timeout: 15_000
      });
    });

    await test.step('follow Hemant from the activity detail', async () => {
      await page.goto(`/activities/${activityId}`);
      await expect(page.getByRole('heading', { name: nandiTitle })).toBeVisible({
        timeout: 30_000
      });

      const followButton = page.getByTestId('host-follow-button');

      await expect(followButton).toBeVisible();

      const currentLabel = (await followButton.textContent())?.trim();

      if (currentLabel === 'Follow') {
        await followButton.click();
        await expect(followButton).toHaveText('Following', { timeout: 15_000 });
      } else {
        await expect(followButton).toHaveText('Following');
      }
    });

    await test.step('verify Hemant post appears in Following feed', async () => {
      await page.getByRole('link', { name: 'Feed' }).click();
      await expect(page).toHaveURL(/\/feed$/);
      await page.getByRole('button', { name: 'Following' }).click();
      await expect(
        page.getByTestId('feed-linked-activity').filter({ hasText: nandiTitle }).first()
      ).toBeVisible({ timeout: 30_000 });
    });
  });
});

async function findNearbyActivityByTitle(
  request: APIRequestContext,
  title: string
): Promise<{ id: string }> {
  const response = await request.get(
    `${apiBaseUrl}/activities/nearby?lat=13.3702&lng=77.6835&radiusKm=25&pillar=move`
  );

  expect(response.ok()).toBe(true);

  const activities = (await response.json()) as Array<{ id?: unknown; title?: unknown }>;
  const activity = activities.find((candidate) => candidate.title === title);

  if (typeof activity?.id !== 'string') {
    throw new Error(`Could not find nearby activity titled ${title}`);
  }

  expect(activity.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

  return { id: activity.id };
}

async function readOtpFromRedis(phone: string): Promise<string> {
  const deadline = Date.now() + 10_000;
  const key = `otp:${phone}`;

  while (Date.now() < deadline) {
    const rawValue = await redisGet(key).catch(() => null);
    const parsedCode = parseOtpCode(rawValue);

    if (parsedCode !== null) {
      return parsedCode;
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
    const parsed = JSON.parse(value) as unknown;

    if (typeof parsed === 'object' && parsed !== null) {
      const code = (parsed as { code?: unknown }).code;

      if (typeof code === 'string' && /^[0-9]{6}$/.test(code)) {
        return code;
      }
    }
  } catch {
    return null;
  }

  return null;
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

      let parsed: ReturnType<typeof parseRedisBulkString>;

      try {
        parsed = parseRedisBulkString(buffer);
      } catch (error) {
        settle(null, error instanceof Error ? error : new Error('Redis response parse failed'));
        return;
      }

      if (parsed.ready) {
        settle(parsed.value);
      }
    });
    socket.on('timeout', () => settle(null, new Error('Redis GET timed out')));
    socket.on('error', (error) => settle(null, error));
  });
}

function encodeRedisCommand(parts: string[]): string {
  return `*${parts.length}\r\n${parts.map((part) => `$${Buffer.byteLength(part)}\r\n${part}`).join('\r\n')}\r\n`;
}

function parseRedisBulkString(buffer: Buffer):
  | { ready: true; value: string | null }
  | { ready: false } {
  const prefix = buffer.toString('utf8', 0, 1);

  if (prefix === '$') {
    const lineEnd = buffer.indexOf('\r\n');

    if (lineEnd === -1) {
      return { ready: false };
    }

    const length = Number(buffer.toString('utf8', 1, lineEnd));

    if (length === -1) {
      return { ready: true, value: null };
    }

    const valueStart = lineEnd + 2;
    const valueEnd = valueStart + length;

    if (buffer.length < valueEnd + 2) {
      return { ready: false };
    }

    return { ready: true, value: buffer.toString('utf8', valueStart, valueEnd) };
  }

  if (prefix === '-') {
    const message = buffer.toString('utf8').trim();
    throw new Error(message.length === 0 ? 'Redis returned an error' : message);
  }

  return { ready: false };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function randomSixDigits(): string {
  return String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
}
