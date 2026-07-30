import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, request as apiRequest, test, type Page } from '@playwright/test';

import { img2img, sd15Txt2Img, uiFormatWorkflow } from '../shared/src/fixtures/workflows.js';
import { renderPlaceholder } from '../server/src/mock/png.js';

/**
 * The full journey a phone user takes: import a workflow, generate, watch it
 * run, and find the result in the gallery.
 *
 * Each test resets server state through the API rather than assuming a fresh
 * database — the dev server is reused between runs, so "it passed once" must
 * not depend on what a previous run left behind.
 */

const BASE_URL = process.env.LATENT_E2E_URL ?? 'http://127.0.0.1:6173';
const WORKFLOW_NAME = 'sd15 txt2img';
const PASSWORD = 'e2e-password';

async function withApi<T>(fn: (ctx: Awaited<ReturnType<typeof apiRequest.newContext>>) => Promise<T>) {
  const ctx = await apiRequest.newContext({ baseURL: BASE_URL });
  try {
    // Every API route needs a session now.
    await ctx.post('/api/auth/login', { data: { password: PASSWORD } });
    return await fn(ctx);
  } finally {
    await ctx.dispose();
  }
}

/**
 * Sign in if the login screen is showing.
 *
 * Each Playwright test gets a fresh browser context, so the session cookie does
 * not carry over between them.
 */
async function signIn(page: Page) {
  const password = page.getByPlaceholder('Password');
  if (await password.isVisible().catch(() => false)) {
    await password.fill(PASSWORD);
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(password).toBeHidden();
  }
}

/**
 * Go to a route and make sure we are past the login screen.
 *
 * The app renders a spinner while it fetches `/api/status`, so checking for the
 * password field immediately can miss it and leave the test poking at a login
 * screen that appears a moment later. Wait for the app to settle on one of its
 * two possible shells first.
 */
async function open(page: Page, path = '/') {
  await page.goto(path);
  await page
    .locator('nav, input[placeholder="Password"]')
    .first()
    .waitFor({ state: 'visible', timeout: 20_000 });
  await signIn(page);
  // Past login, the tab bar is always present.
  await page.locator('nav').first().waitFor({ state: 'visible', timeout: 20_000 });
}

/**
 * Wipe everything a test could observe, so a run never depends on what a
 * previous one left behind. The dev server is reused between runs, so this has
 * to cover every user-visible collection — not just the obvious two.
 */
async function resetState() {
  await withApi(async (ctx) => {
    const workflows = (await (await ctx.get('/api/workflows')).json()) as { id: string }[];
    for (const workflow of workflows) await ctx.delete(`/api/workflows/${workflow.id}`);

    const gallery = (await (await ctx.get('/api/gallery?limit=100')).json()) as {
      items: { id: string }[];
    };
    for (const item of gallery.items) await ctx.delete(`/api/gallery/${item.id}`);

    const favorites = (await (await ctx.get('/api/favorites')).json()) as { id: string }[];
    for (const favorite of favorites) await ctx.delete(`/api/favorites/${favorite.id}`);

    const blocks = (await (await ctx.get('/api/prompt-blocks')).json()) as { id: string }[];
    for (const block of blocks) await ctx.delete(`/api/prompt-blocks/${block.id}`);

    // Random prompt mode is server-side state; leaving it on would silently
    // rewrite the prompt in every test that follows.
    await ctx.patch('/api/prompt-mode', {
      data: {
        enabled: false,
        blockIds: [],
        minBlocks: 2,
        maxBlocks: 4,
        keepTyped: true,
        groupLimits: {},
        params: [],
      },
    });

    const setups = (await (await ctx.get('/api/prompt-mode/presets')).json()) as { id: string }[];
    for (const setup of setups) await ctx.delete(`/api/prompt-mode/presets/${setup.id}`);
  });
}

/** Import a workflow directly, for tests whose subject isn't the import flow. */
async function seedWorkflow(name = WORKFLOW_NAME) {
  await withApi(async (ctx) => {
    await ctx.post('/api/workflows', { data: { name, graph: sd15Txt2Img } });
  });
}

async function importViaUi(page: Page, name: string, graph: unknown) {
  await open(page, '/settings');
  // Exact: a configured import folder puts a "Show <path>" button on the same
  // screen, and those paths contain the word "import".
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await page.locator('input[type="file"]').setInputFiles({
    name: `${name}.json`,
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(graph)),
  });
}

test.describe('Latent on a phone', () => {
  test('tells a new user what to do before anything is imported', async ({ page }) => {
    await resetState();
    await open(page, '/');
    await expect(page.getByText('No workflows yet')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Import a workflow' })).toBeVisible();
  });

  test('imports a workflow, generates an image and shows it in the gallery', async ({ page }) => {
    await resetState();

    await importViaUi(page, WORKFLOW_NAME, sd15Txt2Img);
    await expect(page.getByRole('button', { name: 'Edit form' })).toBeVisible();

    // The form is built from the imported graph plus the live object_info.
    await page.getByRole('link', { name: 'Generate' }).click();
    const prompt = page.getByPlaceholder('Describe the image…');
    await expect(prompt).toBeVisible();
    await expect(prompt).toHaveValue('beautiful scenery nature glass bottle landscape');

    await expect(page.getByRole('button', { name: /Steps/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Sampler/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Model/ })).toBeVisible();
    await expect(page.getByPlaceholder('What to avoid…')).toHaveValue('text, watermark');

    await prompt.fill('a red fox asleep in deep snow, soft morning light');

    // ComfyUI is reachable, so the button must be live — this catches the
    // upstream socket being stuck in backoff while the server is fine.
    const generateButton = page.getByRole('button', { name: /^Generate/ });
    await expect(generateButton).toBeEnabled();
    await expect(page.getByText('ComfyUI is unreachable')).toHaveCount(0);

    await page.screenshot({ path: 'test-results/01-generate.png' });

    await generateButton.click();

    // Live progress must appear without a reload.
    await expect(page.getByText(/a red fox asleep/).first()).toBeVisible();
    await expect(page.getByText(/%/).first()).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: 'test-results/02-progress.png' });

    // …and the finished image must land in the gallery.
    await page.getByRole('link', { name: 'Gallery' }).click();
    const thumb = page.locator('img[alt*="red fox"]').first();
    await expect(thumb).toBeVisible({ timeout: 40_000 });
    await page.screenshot({ path: 'test-results/03-gallery.png' });

    // Opening a result offers the actions that make it reusable.
    await thumb.click();
    await expect(page.getByRole('button', { name: 'Reuse settings' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Upscale' })).toBeVisible();
    await page.screenshot({ path: 'test-results/04-viewer.png' });

    // The details drawer records exactly what produced the image.
    await page.getByRole('button', { name: 'Details' }).click();
    await expect(
      page.getByText('a red fox asleep in deep snow, soft morning light').first(),
    ).toBeVisible();
    await expect(page.getByText('3.seed')).toBeVisible();
    await page.screenshot({ path: 'test-results/05-details.png' });
  });

  test('rejects a UI-format export with a message that says what to do', async ({ page }) => {
    await importViaUi(page, 'wrong-format', uiFormatWorkflow);
    await expect(page.getByText(/Export \(API\)/)).toBeVisible();
  });

  test('queues a batch and can clear it', async ({ page }) => {
    await resetState();
    await seedWorkflow();

    await open(page, '/');
    await page.getByRole('button', { name: '4', exact: true }).click();
    await page.getByRole('button', { name: /^Generate/ }).click();

    await page.getByRole('link', { name: 'Queue' }).click();
    await expect(page.getByText(/in line/).first()).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: 'test-results/06-queue.png' });

    await page.getByRole('button', { name: /^Clear/ }).click();
    await expect(page.getByText(/in line/)).toHaveCount(0, { timeout: 20_000 });

    // Leave nothing running for the next test.
    await withApi((ctx) => ctx.post('/api/queue/interrupt'));
  });

  test('is installable as a PWA', async ({ page }) => {
    const manifest = await page.request.get(`${BASE_URL}/manifest.webmanifest`);
    expect(manifest.ok()).toBe(true);

    const parsed = (await manifest.json()) as { name: string; display: string; icons: unknown[] };
    expect(parsed.name).toBe('Latent');
    expect(parsed.display).toBe('standalone');
    expect(parsed.icons.length).toBeGreaterThan(0);

    // The icons the manifest promises must actually be served.
    expect((await page.request.get(`${BASE_URL}/icon-192.png`)).ok()).toBe(true);
  });

  test('never scrolls sideways on a phone viewport', async ({ page }) => {
    await seedWorkflow('overflow check');

    for (const path of ['/', '/gallery', '/queue', '/settings']) {
      await open(page, path);
      await page.waitForTimeout(400);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${path} scrolls sideways`).toBeLessThanOrEqual(1);
    }
  });
});

test.describe('the phone-specific fixes', () => {
  test.beforeEach(async () => {
    await resetState();
    await seedWorkflow();
  });

  /**
   * German (and most non-English) phone keypads have a comma on the decimal key
   * and no period at all, so `<input type="number">` made CFG literally
   * impossible to set.
   */
  test('accepts a comma as the decimal separator', async ({ page }) => {
    await open(page, '/');

    await page.getByRole('button', { name: /CFG/ }).click();
    const field = page.getByRole('textbox', { name: 'CFG' });
    await field.fill('7,5');
    await field.blur();
    await expect(field).toHaveValue('7.5');

    // And it reaches the server as a real number, not a string.
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByRole('button', { name: /CFG.*7\.5/ })).toBeVisible();
  });

  test('gives sliders a usable range, with the full one a tap away', async ({ page }) => {
    await open(page, '/');
    await page.getByRole('button', { name: /Steps/ }).click();

    // The practical range, not object_info's 1–10000.
    const slider = page.getByRole('slider', { name: 'Steps slider' });
    await expect(slider).toHaveAttribute('max', '60');
    await expect(page.getByText('1 – 60')).toBeVisible();

    await page.getByRole('button', { name: /Full range/ }).click();
    await expect(slider).toHaveAttribute('max', '10000');

    // The typed value is still honoured beyond the soft range.
    const field = page.getByRole('textbox', { name: 'Steps' });
    await field.fill('120');
    await field.blur();
    await expect(field).toHaveValue('120');
  });

  test('keeps the finished image on screen instead of closing', async ({ page }) => {
    await open(page, '/');
    await page.getByPlaceholder('Describe the image…').fill('a result that stays put');
    await page.getByRole('button', { name: /^Generate/ }).click();

    // The bar must switch to a result rather than disappearing.
    await expect(page.getByText('Done').first()).toBeVisible({ timeout: 40_000 });
    await page.getByText('Done').first().click();

    await expect(page.getByRole('button', { name: 'Open gallery' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Rating' })).toBeVisible();
    await page.screenshot({ path: 'test-results/07-result.png' });

    // Rating it stores a local copy, which is what survives the instance dying.
    await page.getByRole('button', { name: '5 stars' }).click();
    await expect(page.getByText('Saved to this device')).toBeVisible();
  });

  test('saves and re-applies a preset in one tap', async ({ page }) => {
    await open(page, '/');

    // Change two things, then save them together.
    await page.getByPlaceholder('Describe the image…').fill('preset prompt');
    await page.getByRole('button', { name: /Steps/ }).click();
    await page.getByRole('textbox', { name: 'Steps' }).fill('42');
    await page.getByRole('button', { name: 'Done' }).click();

    await page.getByRole('button', { name: /Save these settings|\+ Save/ }).click();
    await page.getByPlaceholder('e.g. Fast draft').fill('My look');
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    // Change them back.
    await page.getByPlaceholder('Describe the image…').fill('something else entirely');
    await expect(page.getByRole('button', { name: /Steps.*42/ })).toBeVisible();

    // One tap restores the whole set.
    await page.getByRole('button', { name: 'My look' }).click();
    await expect(page.getByPlaceholder('Describe the image…')).toHaveValue('preset prompt');
    await page.screenshot({ path: 'test-results/08-presets.png' });
  });

  test('edits LoRA tags structurally instead of by hand', async ({ page }) => {
    await open(page, '/');

    const prompt = page.getByPlaceholder('Describe the image…');
    await prompt.fill('a castle <lora:pixel_art_xl.safetensors:0.8>');

    // The tag is lifted out of the text into a real control, and the prompt
    // textarea still shows the literal text so nothing looks swallowed.
    await expect(page.getByText('pixel_art_xl', { exact: true })).toBeVisible();
    await expect(prompt).toHaveValue('a castle <lora:pixel_art_xl.safetensors:0.8>');

    // Adjusting the strength rewrites the tag, leaving the prose intact.
    const strength = page.getByRole('textbox', { name: 'pixel_art_xl.safetensors strength' });
    await strength.fill('0,45');
    await strength.blur();
    await expect(prompt).toHaveValue('a castle <lora:pixel_art_xl.safetensors:0.45>');

    await page.screenshot({ path: 'test-results/09-loras.png' });

    // Removing it takes the tag back out and leaves the prose.
    await page.getByRole('button', { name: 'Remove pixel_art_xl.safetensors' }).click();
    await expect(prompt).toHaveValue('a castle');
  });

  test('lists connections and offers vast.ai-shaped authentication', async ({ page }) => {
    await open(page, '/settings');

    await expect(page.getByRole('heading', { name: 'Connections' })).toBeVisible();
    await expect(page.getByText('in use')).toBeVisible();

    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByPlaceholder('https://12.34.56.78:8188')).toBeVisible();
    await expect(page.getByText(/Authorization: Bearer/)).toBeVisible();

    // The token field explains where the value comes from on vast.ai.
    await page.getByRole('button', { name: 'Token', exact: true }).click();
    await expect(page.getByText(/WEB_PASSWORD/)).toBeVisible();
    await page.screenshot({ path: 'test-results/10-connections.png' });
  });
});

test.describe('gallery, favourites and the prompt builder', () => {
  test.beforeEach(async () => {
    await resetState();
    await seedWorkflow();
  });

  /** Generate a batch and wait until at least `count` images exist. */
  async function generate(page: Page, prompt: string, batch = 1) {
    await open(page, '/');
    await page.getByPlaceholder('Describe the image…').fill(prompt);
    if (batch > 1) await page.getByRole('button', { name: String(batch), exact: true }).click();
    await page.getByRole('button', { name: /^Generate/ }).click();

    await expect
      .poll(
        async () => {
          const page2 = await withApi(async (ctx) => {
            const response = await ctx.get('/api/gallery');
            return (await response.json()) as { items: { images: unknown[] }[] };
          });
          return page2.items.reduce((total, item) => total + item.images.length, 0);
        },
        { timeout: 40_000 },
      )
      .toBeGreaterThanOrEqual(batch);
  }

  test('only ever loads thumbnails in the grid', async ({ page }) => {
    await generate(page, 'thumbnail check');

    const requested: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/view')) requested.push(request.url());
    });

    await open(page, '/gallery');
    await expect(page.locator('img[alt*="thumbnail check"]').first()).toBeVisible({
      timeout: 20_000,
    });
    await page.waitForTimeout(500);

    // Every image the grid pulls must be a preview — that is the whole point of
    // the data-saving requirement.
    expect(requested.length).toBeGreaterThan(0);
    expect(requested.every((url) => url.includes('preview='))).toBe(true);

    /*
     * And the bytes really are the small version. Asserting the URL alone would
     * pass even if the server quietly served the full-size file, so check what
     * the browser actually decoded: the mock renders results at 384px and
     * previews at 128px.
     */
    const decoded = await page
      .locator('img[alt*="thumbnail check"]')
      .first()
      .evaluate((image: HTMLImageElement) => image.naturalWidth);
    expect(decoded).toBe(128);
  });

  /**
   * A long gallery used to stutter. Two causes, both fixed: reporting an image's
   * size was a React Query mutation that re-rendered every tile on each of the
   * hundred loads, and off-screen tiles were still being laid out and painted.
   */
  test('keeps a long grid cheap to scroll', async ({ page }) => {
    await generate(page, 'scroll load', 8);
    await open(page, '/gallery');
    await expect(page.locator('img[alt*="scroll load"]').first()).toBeVisible({ timeout: 30_000 });

    // Off-screen tiles opt out of rendering work.
    const contained = await page
      .locator('img[alt*="scroll load"]')
      .first()
      .evaluate((image: HTMLImageElement) => {
        const tile = image.closest('div[style]');
        return tile ? getComputedStyle(tile).contentVisibility : null;
      });
    expect(contained).toBe('auto');

    /*
     * Each image reports its size at most once, ever. Before, this fired on every
     * load and on every remount — the request storm that came with the re-render
     * storm.
     */
    const reports: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/dimensions')) reports.push(request.url());
    });

    await page.locator('main').evaluate((element) => element.scrollTo(0, element.scrollHeight));
    await page.waitForTimeout(600);
    await page.locator('main').evaluate((element) => element.scrollTo(0, 0));
    await page.waitForTimeout(600);

    // Scrolling back and forth must not re-report anything already reported.
    expect(reports).toHaveLength(0);
  });

  test('lets the grid width be changed and remembers it', async ({ page }) => {
    await generate(page, 'grid check');
    await open(page, '/gallery');

    await page.getByRole('button', { name: 'Grid layout' }).click();
    await page.getByLabel('Columns').fill('4');
    await page.getByRole('button', { name: 'Done' }).click();

    const grid = page.locator('div[style*="grid-template-columns"]').first();
    await expect(grid).toHaveAttribute('style', /repeat\(4,/);

    // The choice belongs to the device, so it must survive a reload.
    await page.reload();
    await signIn(page);
    await expect(page.locator('div[style*="grid-template-columns"]').first()).toHaveAttribute(
      'style',
      /repeat\(4,/,
    );
  });

  test('skips past queued placeholders to the newest finished image', async ({ page }) => {
    // One finished image, then a queue of slow jobs stacked on top of it.
    await generate(page, 'the one I want to see');

    await open(page, '/');
    await page.getByRole('button', { name: /Steps/ }).click();
    await page.getByRole('textbox', { name: 'Steps' }).fill('60');
    await page.getByRole('button', { name: 'Done' }).click();
    await page.getByRole('button', { name: '8', exact: true }).click();
    await page.getByRole('button', { name: /^Generate/ }).click();

    await page.getByRole('link', { name: 'Gallery' }).click();

    // The finished image must be on screen without scrolling, even though eight
    // placeholders now sit above it in the list.
    const thumb = page.locator('img[alt*="the one I want to see"]').first();
    await expect(thumb).toBeInViewport({ timeout: 20_000 });
    await page.screenshot({ path: 'test-results/11-gallery-autoscroll.png' });

    await withApi((ctx) => ctx.delete('/api/queue'));
    await withApi((ctx) => ctx.post('/api/queue/interrupt'));
  });

  test('favourites an image and offers to make more like it', async ({ page }) => {
    await generate(page, 'a keeper');

    await open(page, '/gallery');
    await page.locator('img[alt*="a keeper"]').first().click();
    await page.getByRole('button', { name: /Favourite/ }).click();

    await page.getByRole('button', { name: 'Close' }).click();
    await page.getByRole('link', { name: 'Favourites' }).click();

    await expect(page.getByRole('heading', { name: 'Favourites' })).toBeVisible();
    const favorite = page.locator('img[alt="a keeper"]').first();
    await expect(favorite).toBeVisible({ timeout: 20_000 });

    await favorite.click();
    await expect(page.getByRole('button', { name: 'Make more like this' })).toBeVisible();

    // Favourites carry their own rating, separate from the gallery's.
    await page.getByRole('button', { name: '4 stars' }).click();
    await page.screenshot({ path: 'test-results/12-favourites.png' });

    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByText('★★★★').first()).toBeVisible();
  });

  test('switches favourites between thumbnails and a compact list', async ({ page }) => {
    await generate(page, 'list mode');
    await open(page, '/gallery');
    await page.locator('img[alt*="list mode"]').first().click();
    await page.getByRole('button', { name: /Favourite/ }).click();
    await page.getByRole('button', { name: 'Close' }).click();

    await page.getByRole('link', { name: 'Favourites' }).click();
    await expect(page.locator('img[alt="list mode"]').first()).toBeVisible({ timeout: 20_000 });

    // Thumbnails are the default; turning them off gives a text list.
    await page.getByRole('switch').first().click();
    await expect(page.locator('img[alt="list mode"]')).toHaveCount(0);
    await expect(page.getByText('list mode').first()).toBeVisible();
  });

  test('builds a prompt from saved blocks instead of typing', async ({ page }) => {
    await open(page, '/');

    await page.getByRole('button', { name: '+ Prompt blocks' }).click();
    await page.getByRole('button', { name: 'Show' }).click();

    await page.getByPlaceholder('Name, e.g. Golden hour').fill('Golden hour');
    await page.getByPlaceholder('Group (optional), e.g. Lighting').fill('Lighting');
    await page.getByPlaceholder('warm rim light, long shadows, low sun').fill('warm rim light, long shadows');
    await page.getByRole('button', { name: 'Save block' }).click();

    await expect(page.getByRole('button', { name: 'Golden hour' })).toBeVisible();
    await page.getByRole('button', { name: 'Golden hour' }).click();
    await page.screenshot({ path: 'test-results/13-prompt-blocks.png' });

    await page.getByRole('button', { name: 'Done' }).click();

    // Tapping the chip appended the fragment to the prompt.
    await expect(page.getByPlaceholder('Describe the image…')).toHaveValue(
      /warm rim light, long shadows$/,
    );
  });
});

test.describe('the phone ergonomics pass', () => {
  test.beforeEach(async () => {
    await resetState();
    await seedWorkflow();
  });

  /** Save a prompt block through the API, so the test can get on with toggling. */
  async function seedBlock(name: string, text: string) {
    await withApi((ctx) =>
      ctx.post('/api/prompt-blocks', { data: { name, text, group: 'Lighting' } }),
    );
  }

  /**
   * A block belongs in a prompt once or not at all, so the chip is a switch.
   * Before this, a mis-tap could only be undone by editing the text by hand —
   * exactly the typing the builder exists to avoid.
   */
  test('takes a prompt block back out when its chip is tapped again', async ({ page }) => {
    await seedBlock('Golden hour', 'warm rim light, long shadows');
    await open(page, '/');

    await page.getByPlaceholder('Describe the image…').fill('a lighthouse');
    await page.getByRole('button', { name: '+ Prompt blocks' }).click();

    const chip = page.getByRole('button', { name: /Golden hour/ });
    await expect(chip).toHaveAttribute('aria-pressed', 'false');

    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'true');

    // Tapping a second time must not append a duplicate — it must remove it.
    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'false');

    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByPlaceholder('Describe the image…')).toHaveValue('a lighthouse');
  });

  /**
   * The sampler settings used to live in a sideways-scrolling row, so CFG and
   * the scheduler were off-screen and effectively undiscoverable.
   */
  test('shows every sampler value at once instead of a sideways row', async ({ page }) => {
    await open(page, '/');

    const chips = page.getByRole('button', { name: /^(Steps|CFG|Sampler|Scheduler|Denoise)/ });
    const count = await chips.count();
    expect(count).toBeGreaterThanOrEqual(3);

    const rows = new Set<number>();
    for (let index = 0; index < count; index += 1) {
      const chip = chips.nth(index);
      // Nothing may need a scroll — horizontal or vertical — to be seen.
      await expect(chip).toBeInViewport();
      const box = await chip.boundingBox();
      expect(box).not.toBeNull();
      rows.add(Math.round((box as { y: number }).y));
    }

    // Wrapped, not scrolled: more than one row means they were laid out to fit.
    expect(rows.size).toBeGreaterThan(1);
    await page.screenshot({ path: 'test-results/14-sampler-chips.png' });
  });

  /**
   * Fitting is not the same as being readable. Wrapping put chips of every width
   * wherever they landed, which is a heap; equal columns are a list.
   */
  test('lines the sampler chips up in even columns', async ({ page }) => {
    await open(page, '/');

    const chips = page.getByRole('button', { name: /^(Steps|CFG|Sampler|Scheduler|Denoise)/ });
    const boxes = [];
    for (let index = 0; index < (await chips.count()); index += 1) {
      const box = await chips.nth(index).boundingBox();
      expect(box).not.toBeNull();
      boxes.push(box as { x: number; y: number; width: number });
    }
    expect(boxes.length).toBeGreaterThanOrEqual(4);

    // Two columns, every chip the same width as its neighbours.
    const widths = new Set(boxes.map((box) => Math.round(box.width)));
    expect(widths.size).toBe(1);
    const columns = new Set(boxes.map((box) => Math.round(box.x)));
    expect(columns.size).toBe(2);
    // And the second chip is beside the first, not under it.
    expect(Math.round(boxes[0]!.y)).toBe(Math.round(boxes[1]!.y));
  });

  /**
   * Changing Steps from 20 to 30 used to be a tap, a sheet, a keyboard and a
   * Done. For a value you cycle between the same handful of numbers, that is
   * three taps too many — so a field can be a line of pre-set points instead.
   */
  test('turns a number into a line of points you tap', async ({ page }) => {
    await open(page, '/settings');
    await page.getByRole('button', { name: 'Edit form' }).click();

    // The whole editor card for `steps`, reached from the line that names it —
    // `hasText` on its own matches every ancestor div up to the page.
    const row = page.locator('p', { hasText: '· steps · ' }).locator('xpath=ancestor::div[2]');
    await row.getByRole('button', { name: 'Points' }).click();
    await row.getByRole('textbox', { name: /points from/ }).fill('20');
    await row.getByRole('textbox', { name: /points to/ }).fill('50');
    await row.getByRole('textbox', { name: /points step/ }).fill('10');

    // The settings say exactly what the line will offer, rather than three
    // numbers you have to do the arithmetic on.
    await expect(row.getByText('20, 30, 40, 50')).toBeVisible();
    await page.screenshot({ path: 'test-results/28-point-settings.png' });

    await page.getByRole('button', { name: 'Done' }).click();
    await page.getByRole('link', { name: 'Generate' }).click();

    // On the form the values are on screen, and one tap picks one — no sheet.
    const line = page.getByRole('group', { name: 'Steps' });
    await expect(line).toBeVisible();
    await expect(line.getByRole('button')).toHaveCount(4);
    // Four points and nothing else — the chip that opened a sheet is gone.
    await expect(page.getByRole('button', { name: /^Steps/ })).toHaveCount(4);

    await line.getByRole('button', { name: 'Steps 40' }).click();
    await expect(line.getByRole('button', { name: 'Steps 40' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.screenshot({ path: 'test-results/29-point-line.png' });

    // And that is the value the render is actually given.
    await page.getByPlaceholder('Describe the image…').fill('forty steps please');
    await page.getByRole('button', { name: /^Generate/ }).click();

    await page.getByRole('link', { name: 'Queue' }).click();
    const card = page.getByTestId('queue-card').first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.locator('li', { hasText: 'Steps' })).toContainText('40');

    await withApi((ctx) => ctx.post('/api/queue/interrupt'));
  });

  /**
   * Progress and Generate are looked at together, so they cost one row rather
   * than two — on a phone the difference is a settings row of form.
   */
  test('shares one row between the progress bar and Generate', async ({ page }) => {
    await open(page, '/');

    const button = page.getByRole('button', { name: /^Generate/ });
    const idle = await button.boundingBox();

    await page.getByPlaceholder('Describe the image…').fill('side by side');
    await button.click();

    const bar = page.getByRole('button', { name: 'Generation progress' });
    await expect(bar).toBeVisible({ timeout: 30_000 });

    const queue = page.getByRole('button', { name: /^(\+\d|Queued)/ });
    const barBox = (await bar.boundingBox()) as { y: number; height: number; x: number };
    const queueBox = (await queue.boundingBox()) as { y: number; x: number };

    // Beside, not above: same row, bar on the left.
    expect(Math.abs(barBox.y - queueBox.y)).toBeLessThan(8);
    expect(barBox.x).toBeLessThan(queueBox.x);
    // And the pair is no taller than the button was on its own.
    expect(barBox.height).toBeLessThanOrEqual((idle as { height: number }).height + 2);
    await page.screenshot({ path: 'test-results/30-generate-row.png' });

    // The full bar is not also on screen — that would be the two rows again.
    await expect(page.getByText(/elapsed/)).toHaveCount(0);

    await withApi((ctx) => ctx.post('/api/queue/interrupt'));
  });

  /**
   * Rearranging a form is fiddly on a phone, so having done it once you should
   * be able to keep the arrangement and come back to it.
   */
  test('saves a settings layout and restores it in one tap', async ({ page }) => {
    await open(page, '/settings');
    await page.getByRole('button', { name: 'Edit form' }).click();

    /** The editor row for a field, found by the `node · input · control` line. */
    const row = (input: string) => page.locator('div', { hasText: `· ${input} · ` }).last();

    // Push Steps out of the way, then keep that arrangement under a name.
    await row('steps').getByRole('button', { name: 'To Advanced' }).click();
    await expect(row('steps').getByRole('button', { name: 'To main' })).toBeVisible();

    await page.getByRole('button', { name: 'Save current' }).click();
    await page.getByPlaceholder('e.g. Quick draft').fill('Sparse');
    // Scoped to the sheet: the Settings page behind it has its own Save buttons.
    await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
    // Scoped to the layout: the Connections list below has an "in use" badge too.
    await expect(page.getByRole('button', { name: /Sparse.*in use/ })).toBeVisible();

    // Undo it by hand, so activating the layout has something to restore.
    await row('steps').getByRole('button', { name: 'To main' }).click();
    await expect(row('steps').getByRole('button', { name: 'To Advanced' })).toBeVisible();

    await page.getByRole('button', { name: 'Sparse' }).click();
    await expect(row('steps').getByRole('button', { name: 'To main' })).toBeVisible();
    await page.screenshot({ path: 'test-results/15-layouts.png' });

    // And the arrangement is what the Generate screen actually renders.
    await page.getByRole('button', { name: 'Done' }).click();
    await page.getByRole('link', { name: 'Generate' }).click();
    await expect(page.getByRole('button', { name: /^Steps/ })).toHaveCount(0);
  });

  /**
   * A camera-roll photo is the wrong shape, the wrong way up and far too big.
   * Fixing that before the upload saves a round trip and a wasted render.
   */
  test('crops a photo before it is uploaded', async ({ page }) => {
    // Only the img2img workflow, so it is the one the screen opens on.
    await resetState();
    await withApi((ctx) => ctx.post('/api/workflows', { data: { name: 'img2img', graph: img2img } }));

    await open(page, '/');
    // The fixture already names an input image, so the button says "Replace".
    await page.getByRole('button', { name: /Choose photo|Replace/ }).click();

    await page.locator('input[type="file"]').setInputFiles({
      name: 'holiday.png',
      mimeType: 'image/png',
      buffer: renderPlaceholder(600, 400, 'holiday'),
    });

    // The editor opens instead of uploading straight away.
    await expect(page.getByRole('heading', { name: 'Adjust photo' })).toBeVisible();
    await expect(page.getByTestId('editor-output-size')).toHaveText(/600×400/);

    // A square crop of a 3:2 photo is 400×400, centred.
    await page.getByRole('button', { name: '1:1', exact: true }).click();
    await expect(page.getByTestId('editor-output-size')).toHaveText(/400×400/);
    await page.screenshot({ path: 'test-results/16-image-editor.png' });

    await page.getByRole('button', { name: 'Use' }).click();

    // The edited file lands in ComfyUI's input directory under its own name.
    await expect(page.getByText(/holiday_edited\.png/)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('heading', { name: 'Adjust photo' })).toBeHidden();
  });

  /**
   * The bug the user hit: imported files carry `type: 'import'`, which
   * `/api/view` rejected outright, so an imported folder rendered as a grid of
   * broken tiles. Assert the bytes actually arrive and the browser decodes them.
   */
  test('renders images imported from a folder', async ({ page }) => {
    const root = mkdtempSync(join(tmpdir(), 'latent-e2e-import-'));
    mkdirSync(join(root, 'nested'), { recursive: true });
    writeFileSync(join(root, 'seaside.png'), renderPlaceholder(800, 600, 'seaside'));
    writeFileSync(join(root, 'nested', 'mountain.png'), renderPlaceholder(600, 800, 'mountain'));

    await withApi(async (ctx) => {
      await ctx.patch('/api/settings', { data: { importRoot: root } });
      await ctx.post('/api/import', {
        data: { paths: ['seaside.png', 'nested/mountain.png'], rating: 5 },
      });
    });

    await open(page, '/gallery');

    const thumb = page.locator('img[alt="seaside.png"]').first();
    await expect(thumb).toBeVisible({ timeout: 20_000 });

    // Visible is not enough: a broken image is still "visible" with a zero
    // intrinsic width, which is precisely what the bug looked like.
    await expect
      .poll(() => thumb.evaluate((image: HTMLImageElement) => image.naturalWidth), {
        timeout: 20_000,
      })
      .toBeGreaterThan(0);

    await expect(page.locator('img[alt="nested/mountain.png"]').first()).toBeVisible();
    await page.screenshot({ path: 'test-results/17-imported.png' });

    // Full size works too, so the viewer is not a broken image either.
    await thumb.click();
    const full = page.locator('img[alt="seaside.png"]').last();
    await expect
      .poll(() => full.evaluate((image: HTMLImageElement) => image.naturalWidth), {
        timeout: 20_000,
      })
      .toBe(800);
    await expect(page.getByText('Stored on this device')).toBeVisible();
  });
});

test.describe('knowing what is happening', () => {
  test.beforeEach(async () => {
    await resetState();
    await seedWorkflow();
  });

  /**
   * "How much longer?" is the only question a progress bar is asked, and the bar
   * did not answer it. The numbers are measured server-side, so they survive a
   * reconnect instead of restarting from zero.
   */
  test('shows time left and a step rate while running, with detail on tap', async ({ page }) => {
    await open(page, '/');

    // Enough steps that the mock's step delay adds up to a measurable rate.
    await page.getByRole('button', { name: /Steps/ }).click();
    await page.getByRole('textbox', { name: 'Steps' }).fill('40');
    await page.getByRole('button', { name: 'Done' }).click();

    await page.getByPlaceholder('Describe the image…').fill('how long will this take');
    await page.getByRole('button', { name: /^Generate/ }).click();

    // On Generate the bar shares its row with the button, so it answers in the
    // shortest form there is: how far along, and how much longer.
    await expect(page.getByText(/left/).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Generation progress' })).toContainText('%');

    // Every other tab has the room for the full bar, rate and all.
    await page.getByRole('link', { name: 'Gallery' }).click();
    await expect(page.getByText(/steps\/s|s\/step/).first()).toBeVisible();
    await expect(page.getByText(/elapsed/)).toBeVisible();

    // Detail is one tap away and does not cover the app.
    await expect(page.getByTestId('job-stats')).toHaveCount(0);
    await page.getByRole('button', { name: 'Stats' }).click();

    const stats = page.getByTestId('job-stats');
    await expect(stats).toBeVisible();
    await expect(stats).toContainText('Remaining');
    await expect(stats).toContainText('Per step');
    await expect(stats).toContainText('Nodes done');
    await page.screenshot({ path: 'test-results/18-live-stats.png' });

    // Still reachable — the panel must not have pushed the tab bar off screen.
    await expect(page.getByRole('link', { name: 'Gallery' })).toBeInViewport();

    await page.getByRole('button', { name: 'Hide stats' }).click();
    await expect(page.getByTestId('job-stats')).toHaveCount(0);

    await withApi((ctx) => ctx.post('/api/queue/interrupt'));
  });

  /**
   * Queueing eight variations of one prompt is normal, and then the queue has to
   * let you find the one you regret.
   */
  test('shows each queued job\'s settings so the right one can be removed', async ({ page }) => {
    await open(page, '/');

    // Slow enough that the queue does not drain while the test is reading it.
    await page.getByRole('button', { name: /Steps/ }).click();
    await page.getByRole('textbox', { name: 'Steps' }).fill('60');
    await page.getByRole('button', { name: 'Done' }).click();

    await page.getByPlaceholder('Describe the image…').fill('one of several');
    await page.getByRole('button', { name: '4', exact: true }).click();
    await page.getByRole('button', { name: /^Generate/ }).click();

    await page.getByRole('link', { name: 'Queue' }).click();
    const cards = page.getByTestId('queue-card');
    await expect(cards.nth(1)).toBeVisible({ timeout: 30_000 });

    // The identifying values are on the card without any interaction — including
    // the seed, which in a batch is the only thing that differs.
    const first = cards.first();
    await expect(first).toContainText('Steps');
    await expect(first).toContainText('Seed');
    await expect(first).not.toContainText('Denoise');

    // One switch opens every card, because the point is comparing them.
    await page.getByRole('switch', { name: 'All settings' }).click();
    await expect(first).toContainText('Denoise');
    await page.screenshot({ path: 'test-results/19-queue-params.png' });

    // And a single job can be dropped without touching the others. Take the last
    // one: it is furthest from running, so it cannot finish on its own mid-test.
    const target = cards.last();
    const promptId = await target.getAttribute('data-prompt-id');
    expect(promptId).toBeTruthy();

    await target.getByRole('button', { name: 'Remove' }).click();
    await expect(page.locator(`[data-prompt-id="${promptId}"]`)).toHaveCount(0, {
      timeout: 20_000,
    });
    // The others are still queued — this removed one job, not the batch.
    await expect(cards.first()).toBeVisible();

    await withApi((ctx) => ctx.delete('/api/queue'));
    await withApi((ctx) => ctx.post('/api/queue/interrupt'));
  });

  /** Clearing a queue used to fill the gallery with tombstones. */
  test('does not leave cancelled runs in the gallery', async ({ page }) => {
    await open(page, '/');
    await page.getByPlaceholder('Describe the image…').fill('cancel me');
    await page.getByRole('button', { name: '4', exact: true }).click();
    await page.getByRole('button', { name: /^Generate/ }).click();

    await page.getByRole('link', { name: 'Queue' }).click();
    await expect(page.getByText(/in line/).first()).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: /^Clear/ }).click();
    await withApi((ctx) => ctx.post('/api/queue/interrupt'));

    await page.getByRole('link', { name: 'Gallery' }).click();
    // Give the gallery a moment to settle before asserting an absence.
    await page.waitForTimeout(1500);
    await expect(page.getByText('Cancelled')).toHaveCount(0);
  });

  /** Generate is the one button always pressed; it must never need a scroll. */
  test('keeps the Generate button on screen however long the form is', async ({ page }) => {
    await open(page, '/');

    const generate = page.getByRole('button', { name: /^Generate/ });
    await expect(generate).toBeInViewport();

    // Scroll the form to the top and it is still there.
    await page.locator('main').evaluate((element) => element.scrollTo(0, 0));
    await expect(generate).toBeInViewport();

    // …and to the bottom.
    await page.locator('main').evaluate((element) => element.scrollTo(0, element.scrollHeight));
    await expect(generate).toBeInViewport();
    await page.screenshot({ path: 'test-results/20-pinned-generate.png' });
  });

  /** Accidental pinch-zoom left the app scrolled sideways with no tab bar. */
  test('is not zoomable', async ({ page }) => {
    await open(page, '/');

    const viewport = await page
      .locator('meta[name="viewport"]')
      .getAttribute('content');
    expect(viewport).toContain('user-scalable=no');
    expect(viewport).toContain('maximum-scale=1');

    // The CSS half, which is what engines honouring touch-action actually obey.
    const touchAction = await page.evaluate(
      () => getComputedStyle(document.documentElement).touchAction,
    );
    expect(touchAction).toBe('pan-x pan-y');
  });
});

test.describe('random prompt mode', () => {
  test.beforeEach(async () => {
    await resetState();
    await seedWorkflow();
  });

  /** Seed a small library with two groups, through the API. */
  async function seedBlocks() {
    await withApi(async (ctx) => {
      for (const block of [
        { name: 'Golden hour', category: 'Lighting', text: 'warm rim light' },
        { name: 'Blue hour', category: 'Lighting', text: 'cool ambient light' },
        { name: '35mm', category: 'Camera', text: 'shot on 35mm' },
        { name: 'Ilford', category: 'Film', text: 'black and white grain' },
      ]) {
        await ctx.post('/api/prompt-blocks', { data: block });
      }
    });
  }

  test('turns on, previews real draws, and says so next to Generate', async ({ page }) => {
    await seedBlocks();
    await open(page, '/');

    await page.getByPlaceholder('Describe the image…').fill('a lighthouse');
    await page.getByRole('link', { name: 'Random' }).click();

    await expect(page.getByRole('heading', { name: 'Random' })).toBeVisible();
    await page.getByRole('switch', { name: 'Draw the prompt' }).click();

    // Every block is in the pool until one is tapped.
    await expect(page.getByText('Pool (4 of 4)')).toBeVisible();

    // The preview comes from the server, so it is what a submit would really do.
    await page.getByRole('button', { name: 'Draw three examples' }).click();
    const preview = page.getByTestId('random-prompt-preview');
    await expect(preview).toBeVisible();
    await expect(preview.locator('li')).toHaveCount(3);
    await expect(preview.locator('li').first()).toContainText('a lighthouse');
    await page.screenshot({ path: 'test-results/21-random-prompt.png' });

    // Back on Generate, the button admits the prompt is not what the field says.
    await page.getByRole('link', { name: 'Generate' }).click();
    await expect(page.getByText(/Prompt drawn from blocks/)).toBeVisible();
  });

  test('narrows the pool to hand-picked blocks', async ({ page }) => {
    await seedBlocks();
    await open(page, '/');
    await page.getByRole('link', { name: 'Random' }).click();
    await page.getByRole('switch', { name: 'Draw the prompt' }).click();

    // Tapping a selected chip removes just that one — the pool was "everything".
    await page.getByRole('button', { name: /Blue hour/ }).click();
    await expect(page.getByText('Pool (3 of 4)')).toBeVisible();
    await page.getByRole('button', { name: /Ilford/ }).click();
    await page.getByRole('button', { name: /35mm/ }).click();
    await expect(page.getByText('Pool (1 of 4)')).toBeVisible();

    await page.getByRole('button', { name: 'Draw three examples' }).click();
    const preview = page.getByTestId('random-prompt-preview');
    await expect(preview.locator('li').first()).toContainText('warm rim light');
    await expect(preview).not.toContainText('cool ambient light');

    // And it can be handed back to the whole library in one tap.
    await page.getByRole('button', { name: 'Use all blocks' }).click();
    await expect(page.getByText('Pool (4 of 4)')).toBeVisible();
  });

  /** The whole point: a batch of several is several different pictures. */
  test('gives every item in a batch its own prompt', async ({ page }) => {
    await seedBlocks();
    await withApi((ctx) =>
      ctx.patch('/api/prompt-mode', {
        data: { enabled: true, minBlocks: 2, maxBlocks: 2, keepTyped: true },
      }),
    );

    await open(page, '/');
    await page.getByRole('button', { name: /Steps/ }).click();
    await page.getByRole('textbox', { name: 'Steps' }).fill('60');
    await page.getByRole('button', { name: 'Done' }).click();

    await page.getByPlaceholder('Describe the image…').fill('a lighthouse');
    await page.getByRole('button', { name: '4', exact: true }).click();
    await page.getByRole('button', { name: /^Generate/ }).click();

    await page.getByRole('link', { name: 'Queue' }).click();
    const cards = page.getByTestId('queue-card');
    await expect(cards.nth(2)).toBeVisible({ timeout: 30_000 });

    const titles = await cards.locator('p.line-clamp-2').allInnerTexts();
    expect(titles.length).toBeGreaterThan(2);
    for (const title of titles) {
      // Typed text kept, drawn phrases added.
      expect(title.startsWith('a lighthouse')).toBe(true);
      expect(title.length).toBeGreaterThan('a lighthouse'.length);
    }
    expect(new Set(titles).size).toBeGreaterThan(1);
    await page.screenshot({ path: 'test-results/22-random-batch.png' });

    await withApi((ctx) => ctx.delete('/api/queue'));
    await withApi((ctx) => ctx.post('/api/queue/interrupt'));
  });

  test('says plainly that there is nothing to draw from', async ({ page }) => {
    await open(page, '/');
    await page.getByRole('link', { name: 'Random' }).click();
    await expect(page.getByText(/No prompt blocks saved yet/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Draw three examples' })).toHaveCount(0);
  });
});

test.describe('picking inputs and straightening them', () => {
  test.beforeEach(async () => {
    await resetState();
  });

  /** A folder of reference pictures on the machine running Latent. */
  function seedInputFolder() {
    const root = mkdtempSync(join(tmpdir(), 'latent-e2e-inputs-'));
    mkdirSync(join(root, 'nested'), { recursive: true });
    writeFileSync(join(root, 'harbour.png'), renderPlaceholder(900, 600, 'harbour'));
    writeFileSync(join(root, 'nested', 'sketch.png'), renderPlaceholder(600, 900, 'sketch'));
    return root;
  }

  /**
   * Choosing a folder image must not cost the phone anything: the file is copied
   * into ComfyUI on the server, so no image bytes travel to the browser at all.
   */
  test('uses a picture from the input folder without downloading it', async ({ page }) => {
    const root = seedInputFolder();
    await withApi(async (ctx) => {
      await ctx.patch('/api/settings', { data: { inputRoot: root } });
      await ctx.post('/api/workflows', { data: { name: 'img2img', graph: img2img } });
    });

    await open(page, '/');

    const fullSize: string[] = [];
    page.on('request', (request) => {
      const url = request.url();
      if (url.includes('/api/input-images/file') && !url.includes('preview=')) fullSize.push(url);
    });

    await page.getByRole('button', { name: 'From folder' }).click();
    await expect(page.getByRole('heading', { name: 'From the input folder' })).toBeVisible();
    await expect(page.getByText('2 images')).toBeVisible();

    // Subfolders are included, and the grid loads previews only.
    await expect(page.getByRole('img', { name: 'sketch.png' })).toBeVisible();
    await page.screenshot({ path: 'test-results/23-input-folder.png' });

    await page.getByRole('img', { name: 'harbour.png' }).click();

    // The chosen file lands in ComfyUI's input directory under its own name.
    await expect(page.getByText(/harbour\.png/)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('heading', { name: 'From the input folder' })).toBeHidden();

    // …and the original never came down to the browser.
    expect(fullSize).toHaveLength(0);
  });

  /** Editing is the opt-in path: only then are the full bytes worth fetching. */
  test('edits a folder picture before using it', async ({ page }) => {
    const root = seedInputFolder();
    await withApi(async (ctx) => {
      await ctx.patch('/api/settings', { data: { inputRoot: root } });
      await ctx.post('/api/workflows', { data: { name: 'img2img', graph: img2img } });
    });

    await open(page, '/');
    await page.getByRole('button', { name: 'From folder' }).click();
    await page.getByRole('button', { name: 'Edit harbour.png' }).click();

    await expect(page.getByRole('heading', { name: 'Adjust photo' })).toBeVisible();
    await expect(page.getByTestId('editor-output-size')).toHaveText(/900×600/);

    await page.getByRole('button', { name: 'Use' }).click();
    await expect(page.getByText(/harbour_edited\.png/)).toBeVisible({ timeout: 20_000 });
  });

  /**
   * A horizon is never off by ninety degrees, it is off by two — and the crop has
   * to follow, or every straighten leaves black wedges to trim by hand.
   */
  test('straightens by a free angle and crops the empty corners away', async ({ page }) => {
    await seedWorkflow();
    await withApi((ctx) => ctx.post('/api/workflows', { data: { name: 'img2img', graph: img2img } }));

    await open(page, '/');
    await page.getByRole('button', { name: /Choose photo|Replace/ }).click();
    await page.locator('input[type="file"]').setInputFiles({
      name: 'horizon.png',
      mimeType: 'image/png',
      buffer: renderPlaceholder(800, 600, 'horizon'),
    });

    await expect(page.getByRole('heading', { name: 'Adjust photo' })).toBeVisible();
    await expect(page.getByTestId('editor-fine-angle')).toHaveText('0.0°');
    await expect(page.getByTestId('editor-output-size')).toHaveText(/800×600/);

    await page.getByRole('slider', { name: 'Straighten' }).fill('5');
    await expect(page.getByTestId('editor-fine-angle')).toHaveText('+5.0°');

    /*
     * The result must be smaller than the original in both directions: the crop
     * has pulled inside the rotated picture rather than keeping the black
     * corners a rotation leaves behind.
     */
    const size = await page.getByTestId('editor-output-size').innerText();
    const [width, height] = (size.match(/(\d+)×(\d+)/) ?? []).slice(1).map(Number);
    expect(width).toBeGreaterThan(0);
    expect(width).toBeLessThan(800);
    expect(height).toBeLessThan(600);
    await page.screenshot({ path: 'test-results/24-straighten.png' });

    // Back to zero restores the whole frame.
    await page.getByRole('button', { name: '0°', exact: true }).click();
    await expect(page.getByTestId('editor-output-size')).toHaveText(/800×600/);

    // A quarter turn still swaps the sides, and composes with the fine angle.
    await page.getByRole('button', { name: '↻ Right' }).click();
    await expect(page.getByTestId('editor-output-size')).toHaveText(/600×800/);
  });
});

test.describe('living in the gallery', () => {
  test.beforeEach(async () => {
    await resetState();
    await seedWorkflow();
  });

  /** Generate a batch and wait for the images to land. */
  async function generateBatch(page: Page, prompt: string, batch: number) {
    await open(page, '/');
    await page.getByPlaceholder('Describe the image…').fill(prompt);
    if (batch > 1) await page.getByRole('button', { name: String(batch), exact: true }).click();
    await page.getByRole('button', { name: /^Generate/ }).click();

    // Counted for *this* prompt, not the gallery as a whole: an earlier run's
    // images would otherwise satisfy the wait before this one had started.
    await expect
      .poll(
        async () =>
          withApi(async (ctx) => {
            const gallery = (await (await ctx.get('/api/gallery?limit=100')).json()) as {
              items: { title: string; images: unknown[] }[];
            };
            return gallery.items
              .filter((item) => item.title === prompt)
              .reduce((total, item) => total + item.images.length, 0);
          }),
        { timeout: 60_000 },
      )
      .toBeGreaterThanOrEqual(batch);
  }

  /**
   * A batch is not a meaningful boundary when flicking through results, so the
   * viewer swipes across the whole gallery — including from one run into the next.
   */
  test('swipes across every image, not just one run', async ({ page }) => {
    await generateBatch(page, 'first run', 2);
    await generateBatch(page, 'second run', 2);

    await open(page, '/gallery');
    // The newest run is at the top, so the first tile belongs to it.
    await page.locator('main img').first().click();

    // Four pictures across two runs, all in one swipeable list.
    const counter = page.getByText(/^\d+ \/ 4$/);
    await expect(counter).toBeVisible();
    await expect(page.locator('div.z-60 img')).toHaveAttribute('alt', /second run/);

    const stage = page.locator('div.touch-none').first();

    /**
     * A horizontal flick, dispatched as the pointer events the viewer listens
     * for. Driving the handler directly rather than asking the browser to
     * synthesise a touch gesture: what is being tested here is the navigation
     * across runs, not Chromium's gesture recognition.
     */
    const swipe = async (direction: -1 | 1) => {
      const box = (await stage.boundingBox()) as { x: number; y: number; width: number; height: number };
      const midY = box.y + box.height / 2;
      const from = box.x + box.width * (direction < 0 ? 0.8 : 0.2);
      const to = from + direction * box.width * 0.6;

      // `bubbles` matters: React listens at the root, so a non-bubbling event
      // dispatched on a descendant never reaches the handler at all.
      const base = { pointerId: 1, bubbles: true, isPrimary: true };
      await stage.dispatchEvent('pointerdown', { ...base, clientX: from, clientY: midY });
      await stage.dispatchEvent('pointermove', { ...base, clientX: to, clientY: midY });
      await stage.dispatchEvent('pointerup', { ...base, clientX: to, clientY: midY });
    };

    // Swiping to the end crosses out of this run and into the previous one,
    // which is the whole point — a batch is not a boundary worth stopping at.
    await swipe(-1);
    await swipe(-1);
    await swipe(-1);
    await expect(counter).toHaveText('4 / 4');
    await expect(page.locator('div.z-60 img')).toHaveAttribute('alt', /first run/);

    // …and back the other way.
    await swipe(1);
    await expect(counter).toHaveText('3 / 4');
  });

  /** Tapping the picture closes it — the gesture everyone tries first. */
  test('closes an opened image with a tap', async ({ page }) => {
    await generateBatch(page, 'tap to close', 1);
    await open(page, '/gallery');

    await page.locator('img[alt*="tap to close"]').first().click();
    await expect(page.getByRole('button', { name: 'Details' })).toBeVisible();

    const stage = page.locator('div.touch-none').first();
    await stage.click({ position: { x: 40, y: 40 } });

    // Deferred by the double-tap window, so give it a moment.
    await expect(page.getByRole('button', { name: 'Details' })).toBeHidden({ timeout: 5_000 });
  });

  /**
   * Favouriting saved silently: nothing on screen changed, so it looked broken
   * and invited a second tap that saved a duplicate.
   */
  test('shows that an image is favourited, and unfavourites on a second tap', async ({ page }) => {
    await generateBatch(page, 'a keeper too', 1);
    await open(page, '/gallery');
    await page.locator('img[alt*="a keeper too"]').first().click();

    const button = page.getByRole('button', { name: /Favourite/ });
    await expect(button).toHaveAttribute('aria-pressed', 'false');

    await button.click();
    await expect(page.getByRole('button', { name: '★ Favourited' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Favourite/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // Tapping again removes it rather than saving a second copy.
    await page.getByRole('button', { name: '★ Favourited' }).click();
    await expect(page.getByRole('button', { name: '☆ Favourite' })).toBeVisible();

    const favourites = await withApi(async (ctx) =>
      (await (await ctx.get('/api/favorites')).json()) as unknown[],
    );
    expect(favourites).toHaveLength(0);
  });

  /** The action row used to run off the right edge with nothing to say so. */
  test('keeps every viewer action inside the screen', async ({ page }) => {
    await generateBatch(page, 'button row', 1);
    await open(page, '/gallery');
    await page.locator('img[alt*="button row"]').first().click();

    const width = page.viewportSize()?.width ?? 0;
    expect(width).toBeGreaterThan(0);

    for (const name of ['Favourite', 'Save', 'New seed', 'Reuse settings', 'Upscale', 'Details']) {
      const button = page.getByRole('button', { name: new RegExp(name) }).first();
      await expect(button).toBeVisible();
      const box = await button.boundingBox();
      expect(box, `${name} has no box`).not.toBeNull();
      const { x, width: w } = box as { x: number; width: number };
      expect(x, `${name} starts off screen`).toBeGreaterThanOrEqual(0);
      expect(x + w, `${name} runs past the right edge`).toBeLessThanOrEqual(width + 1);
    }
    await page.screenshot({ path: 'test-results/25-viewer-actions.png' });
  });

  /**
   * Comparing a sweep means reading the numbers off the thumbnails. Opening each
   * picture to find them loses the comparison entirely.
   */
  test('draws chosen parameters on thumbnails and on the big picture', async ({ page }) => {
    await generateBatch(page, 'overlay check', 2);
    await open(page, '/gallery');

    // Nothing overlaid until asked.
    await expect(page.getByTestId('param-overlay')).toHaveCount(0);

    await page.getByRole('button', { name: 'Values on thumbnails' }).click();
    await page.getByRole('button', { name: 'Steps', exact: true }).click();
    await page.getByRole('button', { name: 'CFG', exact: true }).click();
    await page.getByRole('button', { name: 'Done' }).click();

    const overlays = page.getByTestId('param-overlay');
    await expect(overlays.first()).toBeVisible();
    // Short labels plus the value: `St20 Cf8`, readable without opening anything.
    await expect(overlays.first()).toContainText('St');
    await expect(overlays.first()).toContainText('20');
    await page.screenshot({ path: 'test-results/26-grid-overlay.png' });

    // The viewer keeps its own, separate selection. Scoped to the viewer: the
    // grid is still mounted behind it, overlays and all.
    await page.locator('img[alt*="overlay check"]').first().click();
    const viewer = page.locator('div.z-60');
    await expect(viewer.getByTestId('param-overlay')).toHaveCount(0);

    await page.getByRole('button', { name: 'Values on the picture' }).click();
    await page.getByRole('button', { name: 'Seed', exact: true }).click();
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(viewer.getByTestId('param-overlay')).toBeVisible();
    await expect(viewer.getByTestId('param-overlay')).toContainText('Se');
    // …and it is the viewer's own list, not the grid's.
    await expect(viewer.getByTestId('param-overlay')).not.toContainText('Cf');

    // The choice belongs to the device, so it survives a reload.
    await page.reload();
    await signIn(page);
    await expect(page.getByTestId('param-overlay').first()).toContainText('St');
  });
});

test.describe('varying the parameters too', () => {
  test.beforeEach(async () => {
    await resetState();
    await seedWorkflow();
  });

  test('sweeps a value across a batch and saves the setup with the prompt one', async ({ page }) => {
    await withApi((ctx) =>
      ctx.post('/api/prompt-blocks', { data: { name: 'Moody', category: 'Mood', text: 'heavy clouds' } }),
    );

    await open(page, '/');
    await page.getByRole('link', { name: 'Random' }).click();
    await page.getByRole('switch', { name: 'Draw the prompt' }).click();

    // The parameters section is collapsed by default — prompts come first.
    await expect(page.getByRole('button', { name: 'Steps', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: /^Parameters/ }).click();
    await page.getByRole('button', { name: '+ Vary a parameter' }).click();
    await page.getByRole('button', { name: 'Steps', exact: true }).click();

    // A rule states its range, and shows exactly what it can produce.
    await page.getByRole('textbox', { name: 'Steps from' }).fill('20');
    await page.getByRole('textbox', { name: 'Steps to' }).fill('40');
    await page.getByRole('textbox', { name: 'Steps step' }).fill('10');
    await expect(page.getByText('20, 30, 40')).toBeVisible();
    await page.screenshot({ path: 'test-results/27-param-variation.png' });

    // Saved as one thing, together with the prompt setup.
    await page.getByRole('button', { name: 'Save current' }).click();
    await page.getByPlaceholder('e.g. Moody landscapes').fill('Sweep');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('button', { name: /Sweep.*1 params/ })).toBeVisible();

    await page.getByRole('link', { name: 'Generate' }).click();

    // And a batch really does draw different values.
    await page.getByPlaceholder('Describe the image…').fill('a sweep');
    await page.getByRole('button', { name: '4', exact: true }).click();
    await page.getByRole('button', { name: /^Generate/ }).click();

    await page.getByRole('link', { name: 'Queue' }).click();
    const cards = page.getByTestId('queue-card');
    await expect(cards.nth(2)).toBeVisible({ timeout: 30_000 });

    const steps = await cards.locator('li', { hasText: 'Steps' }).allInnerTexts();
    expect(steps.length).toBeGreaterThan(2);
    for (const text of steps) expect(['Steps20', 'Steps30', 'Steps40']).toContain(text.replace(/\s/g, ''));

    await withApi((ctx) => ctx.delete('/api/queue'));
    await withApi((ctx) => ctx.post('/api/queue/interrupt'));
  });
});
