import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const apiBaseUrl = process.env.API_BASE_URL ?? 'http://localhost:3000';
const nandiTitle = 'Nandi Hills sunrise trail ride';

test.describe('Maidan local journey', () => {
  test('onboards, books and pays for Nandi, chats, follows Hemant, and sees his post', async ({
    page,
    request
  }) => {
    test.setTimeout(180_000);

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

    await test.step('onboard with Google sign-in', async () => {
      await page.goto('/onboarding');
      await page.getByTestId('google-sign-in-button').click();
      await completeGoogleSignupIfNeeded(page, 'Journey Explorer');
      await expect(page).toHaveURL(/\/map$/);
      await expect(page.getByText('connected', { exact: true })).toBeVisible({ timeout: 30_000 });
    });

    let activityId = '';

    await test.step('open the Nandi ride', async () => {
      const activity = await findNearbyActivityByTitle(request, nandiTitle);

      await page.goto(`/activities/${activity.id}`);
      await expect(page.getByRole('heading', { level: 1, name: nandiTitle })).toBeVisible({
        timeout: 30_000
      });
      activityId = activity.id;
    });

    await test.step('book and complete the fake payment', async () => {
      await page.getByTestId('slot-join-button').first().click();
      await expect(page.getByRole('heading', { level: 1, name: nandiTitle })).toBeVisible({
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

      await expect(page.getByRole('heading', { level: 1, name: nandiTitle })).toBeVisible({
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

    await test.step('reopen the group chat from joined activities', async () => {
      await page.getByRole('link', { name: 'Activities' }).click();
      await expect(page).toHaveURL(/\/activities$/);
      await page.getByRole('button', { name: 'Joined' }).click();
      await expect(page.getByRole('heading', { name: 'Activity groups' })).toBeVisible({
        timeout: 30_000
      });
      await page.getByTestId('joined-activity-chat-button').first().click();
      await expect(page).toHaveURL(/\/chats\/.+activityId=/, { timeout: 30_000 });
      await expect(page.getByRole('heading', { level: 1, name: nandiTitle })).toBeVisible({
        timeout: 30_000
      });
    });

    await test.step('follow Hemant from the activity detail', async () => {
      await page.goto(`/activities/${activityId}`);
      await expect(page.getByRole('heading', { level: 1, name: nandiTitle })).toBeVisible({
        timeout: 30_000
      });
      await expect(page.getByTestId('activity-detail-chat-button')).toBeVisible({
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

async function completeGoogleSignupIfNeeded(page: Page, displayName: string): Promise<void> {
  const nameInput = page.getByTestId('signup-display-name-input');
  const nextStep = await Promise.race([
    page.waitForURL(/\/map$/, { timeout: 30_000 }).then(() => 'signed-in' as const),
    nameInput.waitFor({ state: 'visible', timeout: 30_000 }).then(() => 'signup' as const)
  ]);

  if (nextStep === 'signed-in') {
    return;
  }

  await expect(page.getByText('Enter your name as per Aadhaar identity.')).toBeVisible();
  await nameInput.fill(displayName);
  await page.getByTestId('complete-google-signup-button').click();
}
