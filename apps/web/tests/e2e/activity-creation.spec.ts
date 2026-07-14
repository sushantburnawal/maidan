import { expect, test, type Page } from '@playwright/test';

test.describe('Activity creation', () => {
  test('fresh Google user can publish the prefilled activity and see save feedback', async ({
    context,
    page
  }) => {
    test.setTimeout(90_000);

    await onboardWithGoogle(page);
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

async function onboardWithGoogle(page: Page): Promise<void> {
  await page.goto('/onboarding');
  await page.getByTestId('google-sign-in-button').click();
  await completeGoogleSignupIfNeeded(page, 'Activity Creator');
  await expect(page).toHaveURL(/\/map$/, { timeout: 30_000 });
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
