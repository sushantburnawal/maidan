import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

const testUidStorageKey = 'maidan.firebaseAuth.testUid';

test.describe('Google onboarding and profile', () => {
  test('creates a first-time Google profile, edits profile details, and skips signup when returning', async ({
    context,
    page
  }) => {
    test.setTimeout(90_000);

    const displayName = 'Aadhaar Test Explorer';
    const bio = 'Bengaluru walker and pottery beginner.';

    await page.goto('/onboarding');
    await page.getByTestId('google-sign-in-button').click();

    await expect(page.getByTestId('signup-display-name-input')).toBeVisible({
      timeout: 30_000
    });
    await expect(page.getByText('Enter your name as per Aadhaar identity.')).toBeVisible();
    await page.getByTestId('signup-display-name-input').fill(displayName);
    await page.getByTestId('complete-google-signup-button').click();
    await expect(page).toHaveURL(/\/map$/, { timeout: 30_000 });

    await page.getByRole('link', { name: 'You' }).click();
    await expect(page.getByRole('heading', { level: 1, name: displayName })).toBeVisible({
      timeout: 30_000
    });
    await page.getByLabel('Bio').fill(bio);
    await page.getByLabel('Interests').fill('walking, pottery');
    await page.getByRole('button', { name: 'Save profile' }).click();

    await page.getByRole('button', { name: 'Public profile' }).click();
    await expect(page.getByText(bio)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('walking', { exact: true })).toBeVisible();
    await expect(page.getByText('pottery', { exact: true })).toBeVisible();

    await page.evaluate(() => {
      window.localStorage.removeItem('maidan.auth.tokens');
    });

    const returningPage = await context.newPage();
    await returningPage.goto('/onboarding');
    await returningPage.getByTestId('google-sign-in-button').click();
    await expect(returningPage).toHaveURL(/\/map$/, { timeout: 30_000 });
    await expect(returningPage.getByTestId('signup-display-name-input')).toHaveCount(0);
    await returningPage.close();
  });

  test('keeps two Google browser sessions isolated across signup and returning login', async ({
    browser
  }) => {
    test.setTimeout(120_000);

    const runId = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const userA = {
      uid: `multi-user-a-${runId}`,
      displayName: `Multi User A ${runId}`
    };
    const userB = {
      uid: `multi-user-b-${runId}`,
      displayName: `Multi User B ${runId}`
    };

    const contextA = await newGoogleTestContext(browser, userA.uid);
    const contextB = await newGoogleTestContext(browser, userB.uid);

    try {
      const pageA = await contextA.newPage();
      const pageB = await contextB.newPage();

      await onboardNewGoogleUser(pageA, userA.displayName);
      await onboardNewGoogleUser(pageB, userB.displayName);

      await expectCurrentProfile(pageA, userA.displayName);
      await expectCurrentProfile(pageB, userB.displayName);
      await expect(pageA.getByRole('heading', { level: 1, name: userB.displayName })).toHaveCount(
        0
      );
      await expect(pageB.getByRole('heading', { level: 1, name: userA.displayName })).toHaveCount(
        0
      );

      await clearMaidanAuthTokens(pageA);
      await clearMaidanAuthTokens(pageB);

      const returningPageA = await contextA.newPage();
      const returningPageB = await contextB.newPage();

      await signInReturningGoogleUser(returningPageA);
      await signInReturningGoogleUser(returningPageB);
      await expectCurrentProfile(returningPageA, userA.displayName);
      await expectCurrentProfile(returningPageB, userB.displayName);

      await returningPageA.close();
      await returningPageB.close();
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });
});

async function newGoogleTestContext(browser: Browser, uid: string): Promise<BrowserContext> {
  const context = await browser.newContext({
    baseURL: process.env.WEB_BASE_URL ?? 'http://localhost:5173',
    geolocation: { latitude: 13.3702, longitude: 77.6835 },
    permissions: ['geolocation']
  });

  await context.addInitScript(
    ({ storageKey, storageValue }) => {
      window.localStorage.setItem(storageKey, storageValue);
    },
    {
      storageKey: testUidStorageKey,
      storageValue: uid
    }
  );

  return context;
}

async function onboardNewGoogleUser(page: Page, displayName: string): Promise<void> {
  await page.goto('/onboarding');
  await page.getByTestId('google-sign-in-button').click();
  await expect(page.getByTestId('signup-display-name-input')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Enter your name as per Aadhaar identity.')).toBeVisible();
  await page.getByTestId('signup-display-name-input').fill(displayName);
  await page.getByTestId('complete-google-signup-button').click();
  await expect(page).toHaveURL(/\/map$/, { timeout: 30_000 });
}

async function signInReturningGoogleUser(page: Page): Promise<void> {
  await page.goto('/onboarding');
  await page.getByTestId('google-sign-in-button').click();
  await expect(page).toHaveURL(/\/map$/, { timeout: 30_000 });
  await expect(page.getByTestId('signup-display-name-input')).toHaveCount(0);
}

async function expectCurrentProfile(page: Page, displayName: string): Promise<void> {
  await page.getByRole('link', { name: 'You' }).click();
  await expect(page).toHaveURL(/\/you$/, { timeout: 30_000 });
  await expect(page.getByRole('heading', { level: 1, name: displayName })).toBeVisible({
    timeout: 30_000
  });
}

async function clearMaidanAuthTokens(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.localStorage.removeItem('maidan.auth.tokens');
  });
}
