import { defineConfig, devices } from '@playwright/test';

const SERVER_PORT = 6173;
const MOCK_PORT = 8188;
/** The stand-in for llama.cpp, started alongside the mock ComfyUI. */
const MOCK_LLAMA_PORT = 8189;
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
  /*
   * One retry, and a retried test is reported as *flaky* rather than passed.
   *
   * Not a way of hiding a failure — Playwright prints the flaky ones at the end
   * of the run and the count is separate from the passes, so a test that needs
   * the retry is still something you are told about. It is a way of separating
   * two things that look identical in a red run and are not: a behaviour that is
   * wrong, and a suite of a hundred and seventy-five tests driving three servers
   * in one container for nine minutes where one `await` occasionally misses its
   * timeout.
   *
   * The second is what this is. Across the runs where it has appeared it has
   * been a different test each time, always a wait rather than an assertion
   * about a value, and every one of them passes on its own and in its own
   * describe — which is the shape of contention, not of a bug. Without a retry
   * the whole run goes red about one time in three and the useful signal in it
   * is drowned; with one, a genuine break still fails twice and still fails.
   */
  retries: 1,
  reporter: [['list']],

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
  },

  projects: [
    {
      name: 'iPhone 14',
      // The tablet and desk layouts have projects of their own below; these
      // assertions are about the phone one and would be checking a different
      // tree here.
      grepInvert: /@tablet|@desk/,
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
    /*
     * The 9.7-inch tablet, on its side.
     *
     * 1024×768, which is both breakpoints at once — wide enough for the
     * two-pane screens and therefore for everything the narrower tablet layout
     * does as well. Only the tests tagged `@tablet` run here: the rest of the
     * suite is about behaviour rather than layout, and running four hundred
     * assertions twice to check that a button still exists buys nothing.
     */
    {
      name: 'iPad',
      grep: /@tablet/,
      use: {
        ...devices['iPad (gen 6) landscape'],
        defaultBrowserType: 'chromium',
        ...(CHROMIUM_PATH ? { launchOptions: { executablePath: CHROMIUM_PATH } } : {}),
      },
    },
    /*
     * A desk.
     *
     * 1600×1000 — a laptop's screen, not a monitor's, deliberately: the desk
     * layout has to be right at the bottom of its range as well as at the top,
     * and 1280 of width has to hold a named sidebar, a readable column and the
     * bench panel all at once. A test run at 2560 would prove only that there
     * was room to spare.
     *
     * No touch, and a mouse: this is the one project where hover exists and
     * where a keyboard is the primary way of getting about, which is most of
     * what the layout is for.
     */
    {
      name: 'Desk',
      grep: /@desk/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1600, height: 1000 },
        ...(CHROMIUM_PATH ? { launchOptions: { executablePath: CHROMIUM_PATH } } : {}),
      },
    },
  ],

  webServer: [
    {
      command: 'npm run mock',
      url: `http://127.0.0.1:${MOCK_PORT}/system_stats`,
      reuseExistingServer: !process.env.CI,
      env: {
        MOCK_PORT: String(MOCK_PORT),
        MOCK_LLAMA_PORT: String(MOCK_LLAMA_PORT),
        MOCK_STEP_MS: '40',
      },
      stdout: 'ignore',
    },
    {
      command: 'npm start',
      url: `${BASE_URL}/api/status`,
      reuseExistingServer: !process.env.CI,
      env: {
        PORT: String(SERVER_PORT),
        COMFY_URL: `http://127.0.0.1:${MOCK_PORT}`,
        /*
         * Civitai, as far as the model library is concerned. Pointed at the
         * mock so the suite never depends on a public site being up — and the
         * image origin separately, because the proxy's allowlist is the whole
         * security of that route and must not be widened by the base URL.
         */
        LATENT_CIVITAI_BASE: `http://127.0.0.1:${MOCK_PORT}/civitai`,
        LATENT_CIVITAI_IMAGE_ORIGIN: `http://127.0.0.1:${MOCK_PORT}`,
        LATENT_DATA_DIR: 'data/e2e',
        // Keep the portable settings files inside the test data directory
        // rather than beside the checkout.
        LATENT_STATE_DIR: 'data/e2e',
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
