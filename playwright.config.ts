import { defineConfig, devices } from '@playwright/test';

const SERVER_PORT = 6173;
const MOCK_PORT = 8188;
const BASE_URL = `http://127.0.0.1:${SERVER_PORT}`;
const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;

/**
 * Drives the built app against the mock ComfyUI in a phone-sized browser.
 *
 * Run `npm run build` first — this serves the production bundle from the real
 * server, so it exercises the same static-serving and proxy paths a deployment
 * would.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
  },

  projects: [
    {
      name: 'iPhone 14',
      // The iPhone viewport, touch behaviour, DPR and user agent, but driven by
      // Chromium — WebKit is not available in every environment, and none of
      // what these tests assert is engine-specific.
      use: {
        ...devices['iPhone 14'],
        defaultBrowserType: 'chromium',
        // Sandboxes and CI images often ship one pre-installed browser whose
        // build number doesn't match this Playwright version. Point at it
        // explicitly when told to; otherwise use Playwright's own download.
        ...(CHROMIUM_PATH ? { launchOptions: { executablePath: CHROMIUM_PATH } } : {}),
      },
    },
  ],

  webServer: [
    {
      command: 'npm run mock',
      url: `http://127.0.0.1:${MOCK_PORT}/system_stats`,
      reuseExistingServer: !process.env.CI,
      env: { MOCK_PORT: String(MOCK_PORT), MOCK_STEP_MS: '40' },
      stdout: 'ignore',
    },
    {
      command: 'npm start',
      url: `${BASE_URL}/api/status`,
      reuseExistingServer: !process.env.CI,
      env: {
        PORT: String(SERVER_PORT),
        COMFY_URL: `http://127.0.0.1:${MOCK_PORT}`,
        LATENT_DATA_DIR: 'data/e2e',
        LOG_LEVEL: 'warn',
        // Fixes the password so the suite logs in deterministically instead of
        // depending on whether a previous run already claimed the server. The
        // first-run claim flow itself is covered by the integration tests.
        LATENT_PASSWORD: 'e2e-password',
        LATENT_TERMINAL: '1',
      },
      stdout: 'ignore',
    },
  ],
});
