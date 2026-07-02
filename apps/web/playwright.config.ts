import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  retries: process.env.CI === 'true' ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.WEB_BASE_URL ?? 'http://localhost:5173',
    channel: 'chrome',
    geolocation: { latitude: 13.3702, longitude: 77.6835 },
    permissions: ['geolocation'],
    trace: 'retain-on-failure'
  },
  projects: [
    {
      name: 'chrome',
      use: { ...devices['Desktop Chrome'] }
    }
  ],
  webServer: {
    command: 'pnpm dev',
    reuseExistingServer: true,
    timeout: 120_000,
    url: process.env.WEB_BASE_URL ?? 'http://localhost:5173'
  }
});
