import { defineConfig, devices } from '@playwright/test';

const webBaseUrl = process.env.WEB_BASE_URL ?? 'http://localhost:5173';
const webServerPort = new URL(webBaseUrl).port || '5173';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  retries: process.env.CI === 'true' ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: webBaseUrl,
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
    command: `pnpm exec vite --host 0.0.0.0 --port ${webServerPort} --strictPort`,
    env: {
      ...process.env,
      VITE_CACHE_DIR: process.env.VITE_CACHE_DIR ?? '/tmp/maidan-vite-cache',
      VITE_FIREBASE_AUTH_TEST_MODE: process.env.VITE_FIREBASE_AUTH_TEST_MODE ?? 'true',
      VITE_FIREBASE_AUTH_TEST_TOKEN:
        process.env.VITE_FIREBASE_AUTH_TEST_TOKEN ?? 'local-firebase-id-token'
    },
    reuseExistingServer: true,
    timeout: 120_000,
    url: webBaseUrl
  }
});
