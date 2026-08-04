import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, request as apiRequest, test, type Page } from '@playwright/test';

import {
  img2img,
  sd15Txt2Img,
  sd15Txt2ImgUi,
  sd15WithLoraInput,
  uiFormatWorkflow,
  withTextPreview,
} from '../shared/src/fixtures/workflows.js';
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
 * Put away the result sheet.
 *
 * A finished run now presents its picture rather than waiting to be tapped, so
 * anything that generates and then goes on to use the app has to close it
 * first — exactly as a person would.
 */
async function dismissResult(page: Page) {
  const dismiss = page.getByRole('button', { name: 'Dismiss' });
  try {
    // Tolerant on purpose: a reload clears the result, so whether the sheet is
    // up depends on when the last picture landed relative to the navigation.
    await dismiss.waitFor({ state: 'visible', timeout: 10_000 });
  } catch {
    return;
  }
  await dismiss.click();
}

/**
 * Blocks, Random and Monitor live behind the "More" tab now, so getting to one
 * is two taps rather than one. In its own helper because every test that uses
 * those screens would otherwise repeat it.
 */
async function openModule(page: Page, label: 'Blocks' | 'Random' | 'Monitor') {
  await page.getByRole('button', { name: 'More modules' }).click();
  await page.getByTestId('more-menu').getByRole('button', { name: label }).click();
  await expect(page.getByTestId('more-menu')).toHaveCount(0);
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

    /*
     * The ComfyUI folder drives importing, the input picker and the workflow
     * scan, so a test that sets one must not leave it for the next — and the
     * queue policy decides whether Generate keeps or drops what is already
     * waiting, which quietly breaks any later test that queues a batch.
     */
    await ctx.patch('/api/settings', {
      data: { comfyRoot: null, importRoot: null, inputRoot: null, queuePolicy: 'append' },
    });

    // Endless generation is server-side and survives a reload, let alone a test.
    await ctx.put('/api/generate/endless', { data: { workflowId: '', values: {}, enabled: false } });
  });

  /*
   * The portable settings files, which are deliberately *not* part of the
   * database: a re-imported workflow adopts the arrangement a previous install
   * had for that name, so leaving them in place would carry one test's form
   * layout into the next one's freshly seeded workflow.
   */
  for (const name of ['latent-settings.json', 'latent-prompt-blocks.json']) {
    rmSync(join('data/e2e', name), { force: true });
  }
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
    await expect(page.getByRole('button', { name: 'Open settings' })).toBeVisible();
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

    // The result opens itself the moment the queue drains; put it away again.
    await dismissResult(page);

    // …and the finished image must land in the gallery.
    await page.getByRole('link', { name: 'Gallery' }).click();
    const thumb = page.locator('img[alt*="red fox"]').first();
    await expect(thumb).toBeVisible({ timeout: 40_000 });
    await page.screenshot({ path: 'test-results/03-gallery.png' });

    // Opening a result offers the actions that make it reusable.
    await thumb.click();
    await expect(page.getByRole('button', { name: 'Reuse' })).toBeVisible();
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

  test('says what is wrong with a graph that produces no image', async ({ page }) => {
    await importViaUi(page, 'no-output', uiFormatWorkflow);
    await expect(page.getByText(/output node/)).toBeVisible();
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

    // The result now presents itself rather than waiting to be tapped: the
    // picture is the thing that was being waited for.
    await expect(page.getByRole('button', { name: 'Open gallery' })).toBeVisible({
      timeout: 60_000,
    });
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

  /**
   * LoRA tags belong to the field that exists to hold them.
   *
   * They used to be offered under the prompt as well, which put them somewhere
   * the workflow may not read and made two controls responsible for one value.
   */
  test('edits LoRA tags in the LoRA field, and nowhere else', async ({ page }) => {
    await resetState();
    await withApi((ctx) =>
      ctx.post('/api/workflows', { data: { name: 'with loras', graph: sd15WithLoraInput } }),
    );

    await open(page, '/');

    // Not under the prompt.
    await expect(page.getByPlaceholder('Describe the image…')).toBeVisible();
    await expect(page.getByRole('button', { name: '+ Add a LoRA' })).toHaveCount(0);

    // The node titled `Lora Input` is the LoRA field, whatever its class.
    await expect(page.getByText('pixel_art_xl', { exact: true })).toBeVisible();

    // Adjusting the strength rewrites the tag it holds.
    const strength = page.getByRole('textbox', { name: 'pixel_art_xl.safetensors strength' });
    await strength.fill('0,45');
    await strength.blur();
    await expect(page.getByText('<lora:pixel_art_xl.safetensors:0.45>')).toBeVisible();

    await page.screenshot({ path: 'test-results/09-loras.png' });

    await page.getByRole('button', { name: 'Remove pixel_art_xl.safetensors' }).click();
    await expect(page.getByRole('button', { name: 'No LoRAs — tap to add one' })).toBeVisible();
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
    // Blocks are made in their own tab now; this is about using them.
    await open(page, '/blocks');
    await page.getByRole('button', { name: 'New block' }).click();
    await page.getByLabel('Block name').fill('Golden hour');
    await page.getByLabel('Block group').fill('Lighting');
    await page.getByLabel('Block text').fill('warm rim light, long shadows');
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    await page.getByRole('link', { name: 'Generate' }).click();
    await page.getByRole('button', { name: '+ Prompt blocks' }).click();

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
    // `count()` does not wait, and the form arrives after the tab bar does.
    await chips.first().waitFor({ state: 'visible', timeout: 20_000 });

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

    const row = page.locator('[data-field="3.steps"]');
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

    /** The editor card for a field, keyed by the id the schema gave it. */
    const row = (id: string) => page.locator(`[data-field="${id}"]`);

    // Push Steps out of the way, then keep that arrangement under a name.
    await row('3.steps').getByRole('button', { name: '→ Advanced' }).click();
    await expect(row('3.steps').getByRole('button', { name: '→ Main' })).toBeVisible();

    await page.getByRole('button', { name: 'Save current' }).click();
    await page.getByPlaceholder('e.g. Quick draft').fill('Sparse');
    // Scoped to the sheet: the Settings page behind it has its own Save buttons.
    await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
    // Scoped to the layout: the Connections list below has an "in use" badge too.
    await expect(page.getByRole('button', { name: /Sparse.*in use/ })).toBeVisible();

    // Undo it by hand, so activating the layout has something to restore.
    await row('3.steps').getByRole('button', { name: '→ Main' }).click();
    await expect(row('3.steps').getByRole('button', { name: '→ Advanced' })).toBeVisible();

    await page.getByRole('button', { name: 'Sparse' }).click();
    await expect(row('3.steps').getByRole('button', { name: '→ Main' })).toBeVisible();
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
    await openModule(page, 'Random');

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
    await openModule(page, 'Random');
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
    await openModule(page, 'Random');
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

    // One level at a time: the root holds one picture and one folder.
    await expect(page.getByText('1 image')).toBeVisible();
    await expect(page.getByRole('img', { name: 'harbour.png' })).toBeVisible();
    await expect(page.getByRole('img', { name: 'sketch.png' })).toHaveCount(0);

    await page.getByRole('button', { name: /^nested/ }).click();
    await expect(page.getByRole('img', { name: 'sketch.png' })).toBeVisible();
    await page.screenshot({ path: 'test-results/23-input-folder.png' });

    // Back up, and take the one at the top.
    await page.getByRole('button', { name: 'all', exact: true }).click();
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

    // The middle of the picture: the top-left corner is the close button now
    // that the chrome floats over a full-bleed image.
    const stage = page.locator('div.touch-none').first();
    const box = await stage.boundingBox();
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);

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

    const button = page.getByRole('button', { name: 'Favourite', exact: true });
    await expect(button).toHaveAttribute('aria-pressed', 'false');

    await button.click();
    // The label carries the state, so it reads correctly as well as looking it.
    await expect(page.getByRole('button', { name: 'Favourited' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Favourited' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // Tapping again removes it rather than saving a second copy.
    await page.getByRole('button', { name: 'Favourited' }).click();
    await expect(page.getByRole('button', { name: 'Favourite', exact: true })).toBeVisible();

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

    for (const name of ['Favourite', 'Save', 'Reseed', 'Reuse', 'Upscale', 'Details']) {
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
    await dismissResult(page);

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
    await openModule(page, 'Random');
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

/**
 * The things that were quietly wrong.
 *
 * Each of these was reported from a phone rather than found in a test, which is
 * the point of writing them down here: the next change should not be able to put
 * any of them back.
 */
test.describe('the fixes wave ten asked for', () => {
  test.beforeEach(async () => {
    await resetState();
    await seedWorkflow();
  });

  /**
   * Leaving the tab unmounts the form; rebuilding it from the workflow's last
   * *submitted* values looked exactly like the app reverting settings on its own.
   */
  test('keeps what is set up while you go and look at something else', async ({ page }) => {
    await open(page, '/');

    await page.getByPlaceholder('Describe the image…').fill('a value that must survive');
    await page.getByRole('button', { name: /Steps/ }).click();
    await page.getByRole('textbox', { name: 'Steps' }).fill('37');
    await page.getByRole('button', { name: 'Done' }).click();
    await page.getByRole('button', { name: '4', exact: true }).click();

    // The round trip that used to lose it.
    await page.getByRole('link', { name: 'Gallery' }).click();
    await expect(page.getByRole('heading', { name: 'Gallery' })).toBeVisible();
    await page.getByRole('link', { name: 'Generate' }).click();

    await expect(page.getByPlaceholder('Describe the image…')).toHaveValue(
      'a value that must survive',
    );
    await expect(page.getByRole('button', { name: /^Steps/ })).toContainText('37');
    await expect(page.getByRole('button', { name: /^Generate ×4/ })).toBeVisible();
  });

  /**
   * The knob is absolutely positioned; with no `left` it sat at the button's
   * centred static position and the translate carried it off the right end.
   */
  test('draws the switch knob inside its own track', async ({ page }) => {
    await open(page, '/settings');

    const track = page.getByRole('switch', { name: 'Blur every image' });
    const knob = track.locator('span');

    for (const state of ['off', 'on']) {
      const outer = await track.boundingBox();
      const inner = await knob.boundingBox();
      expect(outer, `track missing while ${state}`).not.toBeNull();
      expect(inner, `knob missing while ${state}`).not.toBeNull();

      const box = outer as { x: number; width: number };
      const dot = inner as { x: number; width: number };
      expect(dot.x).toBeGreaterThanOrEqual(box.x - 1);
      expect(dot.x + dot.width).toBeLessThanOrEqual(box.x + box.width + 1);

      if (state === 'off') await track.click();
    }
  });

  /** Every phone app does this, and a long gallery is a one-way trip without it. */
  test('goes back to the top when the active tab is tapped again', async ({ page }) => {
    await open(page, '/');
    await page.getByPlaceholder('Describe the image…').fill('something to scroll past');
    await page.getByRole('button', { name: '8', exact: true }).click();
    await page.getByRole('button', { name: /^Generate/ }).click();

    await page.getByRole('link', { name: 'Gallery' }).click();
    await expect(page.locator('main img').nth(5)).toBeVisible({ timeout: 90_000 });

    const scroller = page.locator('main');
    // A page that cannot scroll would pass the assertions below without
    // proving anything.
    expect(
      await scroller.evaluate((el) => el.scrollHeight - el.clientHeight),
    ).toBeGreaterThan(50);

    await scroller.evaluate((element) => element.scrollTo({ top: 400 }));
    await expect.poll(async () => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

    await page.getByRole('link', { name: 'Gallery' }).click();
    await expect.poll(async () => scroller.evaluate((el) => el.scrollTop)).toBe(0);
  });

  /** For looking at the queue on a train. */
  test('blurs every picture when asked, and keeps it blurred', async ({ page }) => {
    await open(page, '/');
    await page.getByPlaceholder('Describe the image…').fill('something to blur');
    await page.getByRole('button', { name: /^Generate/ }).click();

    await page.getByRole('link', { name: 'Gallery' }).click();
    await dismissResult(page);

    const thumb = page.locator('main img').first();
    await expect(thumb).toBeVisible({ timeout: 60_000 });
    await expect(thumb).toHaveCSS('filter', 'none');

    await page.getByRole('button', { name: 'Blur every image' }).click();
    await expect(thumb).not.toHaveCSS('filter', 'none');
    await page.screenshot({ path: 'test-results/31-blur.png' });

    // A reload must not flash the pictures back.
    await page.reload();
    await expect(page.locator('main img').first()).not.toHaveCSS('filter', 'none');
  });

  /** Blocks are built up over time, which is not something to do mid-prompt. */
  test('manages prompt blocks in their own tab', async ({ page }) => {
    await open(page, '/blocks');

    await page.getByRole('button', { name: 'New block' }).click();
    await page.getByRole('textbox', { name: 'Block name' }).fill('Golden hour');
    // `getByLabel`, not `getByRole('textbox')`: an input with a `list` is a
    // combobox as far as the accessibility tree is concerned.
    await page.getByLabel('Block group').fill('Lighting');
    await page.getByRole('textbox', { name: 'Block text' }).fill('warm rim light');
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    await expect(page.getByText('LIGHTING')).toBeVisible();
    await expect(page.getByText('warm rim light')).toBeVisible();
    await page.screenshot({ path: 'test-results/32-blocks.png' });

    // And it is usable where prompts are actually written.
    await page.getByRole('link', { name: 'Generate' }).click();
    await page.getByRole('button', { name: '+ Prompt blocks' }).click();
    await expect(page.getByRole('button', { name: /Golden hour/ })).toBeVisible();
  });

  /**
   * Reordering by dragging, and a width per field — the two things that make the
   * editor a layout tool rather than a list of switches.
   */
  test('rearranges the form by dragging, and the Generate screen follows', async ({ page }) => {
    await open(page, '/settings');
    await page.getByRole('button', { name: 'Edit form' }).click();

    // Width first: a full row is the layout choice the two-column grid needs.
    await page
      .locator('[data-field="3.steps"]')
      .getByRole('button', { name: /Steps Full row/ })
      .click();

    // Then the order. The two rows have to be on screen together for a drag to
    // be possible at all, so this moves a field past its neighbour.
    const fields = page.locator('[data-field]');
    const before = await fields.evaluateAll((rows) =>
      rows.map((row) => row.getAttribute('data-field')),
    );
    const moved = before[2] as string;
    const above = before[1] as string;

    const handle = page.locator(`[data-field="${moved}"]`).getByRole('button', { name: /^Reorder/ });
    const destination = page.locator(`[data-field="${above}"]`);
    await handle.scrollIntoViewIfNeeded();

    const grip = await handle.boundingBox();
    const fromRow = await page.locator(`[data-field="${moved}"]`).boundingBox();
    const toRow = await destination.boundingBox();
    expect(grip).not.toBeNull();
    expect(fromRow).not.toBeNull();
    expect(toRow).not.toBeNull();

    /*
     * What decides the new position is where the *dragged row's* centre ends
     * up, not the pointer — so the pointer travels exactly the distance
     * between the two rows' centres. Aiming at the target row's edge instead
     * depends on how tall the rows happen to be, which is not a thing this
     * test is about.
     */
    const delta =
      toRow!.y + toRow!.height / 2 - (fromRow!.y + fromRow!.height / 2);
    const x = grip!.x + grip!.width / 2;
    const y = grip!.y + grip!.height / 2;

    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + delta, { steps: 8 });
    await page.mouse.move(x, y + delta - 1);
    await page.mouse.up();

    await expect
      .poll(async () => fields.evaluateAll((rows) => rows.map((r) => r.getAttribute('data-field'))))
      .toEqual([before[0], moved, above, ...before.slice(3)]);
    await page.screenshot({ path: 'test-results/33-form-layout.png' });

    // The width, meanwhile, is what the Generate screen renders.
    await page.getByRole('button', { name: 'Done' }).click();
    await page.getByRole('link', { name: 'Generate' }).click();

    const stepsBox = await page.getByRole('button', { name: /^Steps/ }).boundingBox();
    const modelBox = await page.getByRole('button', { name: /^Model/ }).boundingBox();
    // Full row: as wide as the form, not half of it.
    expect(stepsBox!.width).toBeGreaterThan(modelBox!.width * 1.6);
  });

  /**
   * A "preview as text" node is how a graph reports what it decided. Outputs
   * without images were being dropped, which made exactly that invisible.
   */
  test('shows what a preview-as-text node printed', async ({ page }) => {
    // The only workflow, so the screen opens on it rather than needing a switch.
    await resetState();
    await withApi((ctx) =>
      ctx.post('/api/workflows', { data: { name: 'talks back', graph: withTextPreview } }),
    );

    await open(page, '/');
    await page.getByPlaceholder('Describe the image…').fill('tell me what you did');
    await page.getByRole('button', { name: /^Generate/ }).click();

    await page.getByRole('link', { name: 'Gallery' }).click();
    await dismissResult(page);
    await page.locator('main img').first().click({ timeout: 60_000 });

    // Chosen like any other value: a node that writes text is offered by name.
    await page.getByRole('button', { name: 'Values on the picture' }).click();
    await page.getByRole('button', { name: 'What ran', exact: true }).click();
    await page.getByRole('button', { name: 'Done' }).click();

    const overlay = page.locator('div.z-60').getByTestId('param-overlay');
    await expect(overlay).toBeVisible();
    await expect(overlay).toContainText('steps=');
    await page.screenshot({ path: 'test-results/34-text-output.png' });
  });

  /** VRAM on its own is decoration; VRAM with "this is where it started" is not. */
  test('charts the hardware next to the queue events', async ({ page }) => {
    await open(page, '/');
    await page.getByPlaceholder('Describe the image…').fill('watched from the monitor');
    await page.getByRole('button', { name: /^Generate/ }).click();

    await openModule(page, 'Monitor');
    await expect(page.getByTestId('monitor-charts')).toBeVisible({ timeout: 30_000 });
    // The chart's own label, not the picker chip that switches it on.
    await expect(page.getByTestId('monitor-charts').getByText('VRAM')).toBeVisible();

    const events = page.getByTestId('monitor-events');
    await expect(events).toContainText('watched from the monitor', { timeout: 60_000 });
    await page.screenshot({ path: 'test-results/35-monitor.png' });

    // What core ComfyUI does not report is said, not drawn as a flat zero.
    await expect(page.getByText(/Not reported/).first()).toBeVisible();
  });
});

/**
 * Wave eleven: keeping what matters, throwing the rest away, and the several
 * ways the app used to mislead you about what it was doing.
 */
test.describe('keeping, deleting and looking closely', () => {
  test.beforeEach(async () => {
    await resetState();
    await seedWorkflow();
  });

  /** Generate one picture and open it in the viewer. */
  async function generateAndOpen(page: Page, prompt: string) {
    await open(page, '/');
    await page.getByPlaceholder('Describe the image…').fill(prompt);
    await page.getByRole('button', { name: /^Generate/ }).click();

    // The result opens itself now, and it sits over everything else.
    await dismissResult(page);

    await page.getByRole('link', { name: 'Gallery' }).click();
    await page.locator('main img').first().click({ timeout: 60_000 });
  }

  /**
   * Waiting for a render and then being handed a one-line bar you have to tap
   * is the wrong end of the interaction. The picture is the point.
   */
  test('opens the finished picture without being asked', async ({ page }) => {
    await open(page, '/');
    await page.getByPlaceholder('Describe the image…').fill('show me straight away');
    await page.getByRole('button', { name: /^Generate/ }).click();

    // The result sheet, not the collapsed bar.
    await expect(page.getByRole('dialog').getByText('Rate it')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('dialog').getByRole('img')).toBeVisible();
    await page.screenshot({ path: 'test-results/36-result-opens.png' });
  });

  /** A rating is a judgement; being made to pass one to save a file is a tax. */
  test('keeps a picture without rating it, and deletes one for good', async ({ page }) => {
    await generateAndOpen(page, 'keep this one');

    const keep = page.getByRole('button', { name: /Keep/ });
    await expect(keep).toHaveAttribute('aria-pressed', 'false');
    await keep.click();
    await expect(page.getByRole('button', { name: /Kept/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // Kept means copied locally — the same promise a rating makes.
    await expect(page.getByText('Stored on this device')).toBeVisible();
    await page.screenshot({ path: 'test-results/37-keep.png' });

    // And deleting takes two taps, then the picture is gone.
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('button', { name: 'Sure?' }).click();

    await expect(page.locator('main img')).toHaveCount(0, { timeout: 30_000 });
  });

  /**
   * The list grows underneath the viewer, which used to reset a zoom seconds
   * after it was set up — the index of the picture changed, the picture did not.
   */
  test('holds a zoom while the gallery changes underneath it', async ({ page }) => {
    await generateAndOpen(page, 'look closely');

    // The viewer's copy, not the thumbnail behind it.
    const stage = page.getByRole('img', { name: 'look closely' }).last();
    const box = await stage.boundingBox();
    expect(box).not.toBeNull();

    const centre = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
    await page.mouse.dblclick(centre.x, centre.y);

    const zoomed = await stage.evaluate((element) => element.style.transform);
    expect(zoomed).toMatch(/scale\(([2-9]|1\.[5-9])/);

    // Something finishing elsewhere must not disturb it.
    await withApi(async (ctx) => {
      const workflows = (await (await ctx.get('/api/workflows')).json()) as { id: string }[];
      await ctx.post('/api/generate', {
        data: { workflowId: workflows[0]?.id, values: { '6.text': 'a new arrival' } },
      });
    });

    await page.waitForTimeout(4_000);
    expect(await stage.evaluate((element) => element.style.transform)).toBe(zoomed);
    await page.screenshot({ path: 'test-results/38-zoom-held.png' });

    await withApi((ctx) => ctx.post('/api/queue/interrupt'));
  });

  /** The phrases that go on everything, chosen once rather than tapped each time. */
  test('appends the chosen blocks to every prompt', async ({ page }) => {
    await withApi((ctx) =>
      ctx.post('/api/prompt-blocks', {
        data: { name: 'House style', category: 'Style', text: 'muted colours, fine grain' },
      }),
    );

    await open(page, '/');
    await page.getByRole('button', { name: '+ Always append' }).click();
    await page.getByRole('button', { name: /House style/ }).click();
    await expect(page.getByText('muted colours, fine grain')).toBeVisible();
    await page.getByRole('button', { name: 'Done' }).click();

    // The chip says what will happen without opening anything.
    await expect(page.getByRole('button', { name: /Always: House style/ })).toBeVisible();
    await page.screenshot({ path: 'test-results/39-always-blocks.png' });

    await page.getByPlaceholder('Describe the image…').fill('a quiet street');
    await page.getByRole('button', { name: /^Generate/ }).click();

    // Appended on the server, so it lands whatever the prompt came from.
    await expect
      .poll(
        async () =>
          withApi(async (ctx) => {
            const gallery = (await (await ctx.get('/api/gallery?limit=10')).json()) as {
              items: { title: string }[];
            };
            return gallery.items[0]?.title ?? '';
          }),
        { timeout: 60_000 },
      )
      .toContain('muted colours, fine grain');
  });
});

/**
 * Wave twelve: one folder instead of three, the workflows already saved in it,
 * and the compactness the prompt library needs once it is more than a handful
 * of blocks.
 */
test.describe('the twelfth wave', () => {
  /**
   * The whole point of asking for the installation directory: everything that
   * used to be a separate question is now found from it.
   */
  test('reads the workflows out of a ComfyUI folder and lets you choose which appear', async ({
    page,
  }) => {
    await resetState();

    // A stock installation, as far as anything here is concerned.
    const root = mkdtempSync(join(tmpdir(), 'latent-e2e-comfy-'));
    const workflows = join(root, 'user', 'default', 'workflows');
    mkdirSync(workflows, { recursive: true });
    // Saved by the editor, not exported — which is what is actually on disk.
    writeFileSync(join(workflows, 'from-the-editor.json'), JSON.stringify(sd15Txt2ImgUi));

    try {
      await open(page, '/settings');
      await page.getByLabel('ComfyUI folder').fill(root);
      await page.getByRole('button', { name: 'Save' }).first().click();
      await page.getByRole('button', { name: 'Read workflows' }).click();

      // First: the same name is also in the two shortcut dropdowns.
      await expect(page.getByText('from-the-editor').first()).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText('1 of 1 shown')).toHaveCount(0);
      await expect(page.getByText('0 of 1 shown')).toBeVisible();
      await page.screenshot({ path: 'test-results/40-workflow-scan.png' });

      // Switched off on arrival, so the generate picker stays short.
      await page.getByRole('link', { name: 'Generate' }).click();
      await expect(page.getByText('No workflows switched on')).toBeVisible();

      await page.getByRole('link', { name: 'Settings' }).click();
      await page
        .getByRole('switch', { name: /Show from-the-editor in the generate picker/ })
        .click();
      await expect(page.getByText('1 of 1 shown')).toBeVisible();

      // And now it is a workflow you can actually run, converted from the
      // editor's positional widget list on the way in.
      await page.getByRole('link', { name: 'Generate' }).click();
      await expect(page.getByPlaceholder('Describe the image…')).toBeVisible();
      await expect(page.getByRole('button', { name: /Steps.*20/ })).toBeVisible();
    } finally {
      rmSync(root, { recursive: true, force: true });
      await resetState();
    }
  });

  /** Settings is a long page; it must not slide sideways out of the display. */
  test('does not pan sideways', async ({ page }) => {
    await open(page, '/settings');
    const widths = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(widths.scroll).toBeLessThanOrEqual(widths.client);
  });

  /**
   * "Blocks per prompt" with no ceiling.
   *
   * Zero is the stored value, but nobody would type it, so there is a chip
   * that says what it means.
   */
  test('offers an unlimited number of blocks per prompt', async ({ page }) => {
    await resetState();
    // The controls only exist once there is a library to draw from.
    await withApi((ctx) =>
      ctx.post('/api/prompt-blocks', {
        data: { name: 'Rain', category: 'Weather', text: 'wet streets' },
      }),
    );

    await open(page, '/variation');
    await page.getByRole('button', { name: 'At most all' }).click();
    await expect
      .poll(async () =>
        withApi(async (ctx) => {
          const mode = (await (await ctx.get('/api/prompt-mode')).json()) as { maxBlocks: number };
          return mode.maxBlocks;
        }),
      )
      .toBe(0);
    await page.screenshot({ path: 'test-results/41-unlimited-blocks.png' });
  });

  /** Two columns, because the library is long and the phone is narrow. */
  test('lays the prompt library out two blocks to a row', async ({ page }) => {
    await resetState();
    await withApi(async (ctx) => {
      for (const name of ['Golden hour', 'Blue hour', 'Overcast', 'Harsh noon']) {
        await ctx.post('/api/prompt-blocks', {
          data: { name, category: 'Lighting', text: name.toLowerCase() },
        });
      }
    });

    await open(page, '/blocks');
    const first = await page.getByText('Golden hour', { exact: true }).boundingBox();
    const second = await page.getByText('Blue hour', { exact: true }).boundingBox();
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    // Side by side: same row, different column.
    expect(Math.abs(first!.y - second!.y)).toBeLessThan(first!.height);
    expect(second!.x).toBeGreaterThan(first!.x + first!.width);
    await page.screenshot({ path: 'test-results/42-blocks-two-columns.png' });
  });
});

/**
 * Wave thirteen: the gallery's detail surfaces, and the two things that were
 * quietly wrong underneath them.
 */
test.describe('the thirteenth wave', () => {
  /** Get one finished picture into the gallery and open it. */
  const openFirstImage = async (page: import('@playwright/test').Page) => {
    await page.getByRole('link', { name: 'Gallery' }).click();
    const thumb = page.locator('main img').first();
    await expect(thumb).toBeVisible({ timeout: 60_000 });
    await thumb.click();
    await expect(page.getByRole('button', { name: 'Details' })).toBeVisible();
  };

  test.beforeEach(async ({ page }) => {
    await resetState();
    await seedWorkflow();
    await open(page, '/');
    await page.getByPlaceholder('Describe the image…').fill('a heron on a jetty');
    await page.getByRole('button', { name: /^Generate/ }).click();
    await dismissResult(page);
  });

  /**
   * A long value is the one you most want to read and the one least likely to
   * fit, so cutting it off permanently hides exactly what the list is for.
   */
  test('opens a long detail line on a tap and closes it again', async ({ page }) => {
    await openFirstImage(page);
    await page.getByRole('button', { name: 'Details' }).click();

    const row = page.locator('dd', { hasText: 'a heron on a jetty' }).first();
    await expect(row).toHaveClass(/truncate/);

    await row.click();
    await expect(row).not.toHaveClass(/truncate/);
    await page.screenshot({ path: 'test-results/43-detail-expanded.png' });

    await row.click();
    await expect(row).toHaveClass(/truncate/);
  });

  /** Both edges flush, and every action the same size. */
  test('sets the viewer actions in even columns', async ({ page }) => {
    await openFirstImage(page);

    const favourite = await page.getByRole('button', { name: /Favourite/ }).boundingBox();
    const save = await page.getByRole('button', { name: 'Save', exact: true }).boundingBox();
    const keep = await page.getByRole('button', { name: /Keep$/ }).boundingBox();
    expect(favourite).not.toBeNull();

    // Three to a row, so the first three share a top edge and equal widths.
    expect(Math.abs(favourite!.y - save!.y)).toBeLessThan(2);
    expect(Math.abs(save!.y - keep!.y)).toBeLessThan(2);
    expect(Math.abs(favourite!.width - save!.width)).toBeLessThan(2);
    await page.screenshot({ path: 'test-results/44-viewer-actions.png' });
  });

  /** Two columns, because a workflow has more knobs than a phone has rows. */
  test('lists the drawable values two to a row', async ({ page }) => {
    await openFirstImage(page);
    await page.getByRole('button', { name: 'Values on the picture' }).click();

    /*
     * The computed track list, not the geometry of two elements picked out of
     * it: a portalled sheet leaves an older one in the tree, and "these two
     * boxes share a top edge" then quietly compares rows of different lists.
     */
    const list = page.getByTestId('overlay-choices').last();
    await expect(list).toBeVisible();
    const columns = await list.evaluate(
      (element) => getComputedStyle(element).gridTemplateColumns.split(' ').length,
    );
    expect(columns).toBe(2);
    await page.screenshot({ path: 'test-results/45-overlay-picker.png' });
  });

  /**
   * The viewer must not pan sideways however long a chosen value turns out to
   * be — a model's answer is a paragraph, not a number.
   */
  test('never lets the drawn values push the page sideways', async ({ page }) => {
    await openFirstImage(page);
    await page.getByRole('button', { name: 'Values on the picture' }).click();

    // Everything on at once: the widest the overlay can possibly get.
    for (const choice of await page.getByTestId('overlay-choices').last().locator('button').all()) {
      await choice.click();
    }
    // The backdrop, not the Close button: with every value chosen the sheet is
    // tall enough that its own header can sit under the overlay.
    await page.locator('div[role="presentation"]').last().click({ force: true });
    await expect(page.getByRole('button', { name: 'Values on the picture' })).toBeVisible();

    const widths = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(widths.scroll).toBeLessThanOrEqual(widths.client);
    await page.screenshot({ path: 'test-results/46-overlay-wide.png' });
  });
});

/**
 * Wave fourteen: the footer had grown taller than the picture it belongs to,
 * and panning a zoomed image quietly undid the zoom.
 */
test.describe('the fourteenth wave', () => {
  const openFirst = async (page: import('@playwright/test').Page) => {
    await page.getByRole('link', { name: 'Gallery' }).click();
    const thumb = page.locator('main img').first();
    await expect(thumb).toBeVisible({ timeout: 60_000 });
    await thumb.click();
    await expect(page.getByRole('button', { name: 'Details' })).toBeVisible();
  };

  test.beforeEach(async ({ page }) => {
    await resetState();
    await seedWorkflow();
    await open(page, '/');
    await page.getByPlaceholder('Describe the image…').fill('a kestrel over a field');
    await page.getByRole('button', { name: /^Generate/ }).click();
    await dismissResult(page);
  });

  /** The picture is what the screen is for; the actions are not. */
  test('keeps the viewer actions to two short rows', async ({ page }) => {
    await openFirst(page);

    const first = await page.getByRole('button', { name: 'Favourite' }).boundingBox();
    const last = await page.getByRole('button', { name: 'Delete' }).boundingBox();
    expect(first).not.toBeNull();
    expect(last).not.toBeNull();

    // Top of the first row to the bottom of the last: two rows, not four.
    const height = last!.y + last!.height - first!.y;
    expect(height).toBeLessThan(110);
    await page.screenshot({ path: 'test-results/47-viewer-actions-compact.png' });
  });

  /**
   * Panning used to fall through to the tap branch, and a single tap while
   * zoomed means "zoom back out" — so moving a zoomed picture scheduled its own
   * reset a fifth of a second later, every time.
   */
  test('holds the zoom while the picture is panned', async ({ page }) => {
    await openFirst(page);

    // The viewer's own copy, not the thumbnail behind it.
    const stage = page.getByRole('img', { name: /kestrel/ }).last();
    const box = await stage.boundingBox();
    expect(box).not.toBeNull();
    const centre = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };

    await page.mouse.dblclick(centre.x, centre.y);
    const zoomed = await stage.evaluate((element) => element.style.transform);
    expect(zoomed).toMatch(/scale\(([2-9]|1\.[5-9])/);

    // Drag it, the way you would to look at a corner.
    await page.mouse.move(centre.x, centre.y);
    await page.mouse.down();
    await page.mouse.move(centre.x - 70, centre.y - 40, { steps: 10 });
    await page.mouse.up();

    // Well past the double-tap window that used to fire the reset.
    await page.waitForTimeout(900);
    const after = await stage.evaluate((element) => element.style.transform);
    expect(after).toMatch(/scale\(([2-9]|1\.[5-9])/);
    // …and it stayed where it was put.
    expect(after).not.toBe(zoomed);
    await page.screenshot({ path: 'test-results/48-zoom-panned.png' });
  });

  /** A sheet must not be draggable sideways off the screen. */
  test('does not pan the details picker sideways', async ({ page }) => {
    await openFirst(page);
    await page.getByRole('button', { name: 'Values on the picture' }).click();

    // Nothing inside the sheet may reach past its right edge — that overflow is
    // what made the whole panel draggable off the screen.
    const overflow = await page
      .getByTestId('overlay-choices')
      .last()
      .evaluate((element) => {
        const panel = element.parentElement as HTMLElement;
        const right = panel.getBoundingClientRect().right;
        let worst = 0;
        for (const node of panel.querySelectorAll('*')) {
          worst = Math.max(worst, node.getBoundingClientRect().right - right);
        }
        return worst;
      });
    expect(overflow).toBeLessThanOrEqual(1);
  });
});

/**
 * Wave fifteen: the picture gets the whole screen, generation can be left
 * running, and the form editor's order finally reaches the form.
 */
test.describe('the fifteenth wave', () => {
  test('gives the picture the whole screen with the actions floating on it', async ({ page }) => {
    await resetState();
    await seedWorkflow();
    await open(page, '/');
    await page.getByPlaceholder('Describe the image…').fill('a pier at dawn');
    await page.getByRole('button', { name: /^Generate/ }).click();
    await dismissResult(page);

    await page.getByRole('link', { name: 'Gallery' }).click();
    const thumb = page.locator('main img').first();
    await expect(thumb).toBeVisible({ timeout: 60_000 });
    await thumb.click();

    const viewport = page.viewportSize()!;
    const stage = page.locator('div.touch-none').first();
    const box = await stage.boundingBox();

    // The image area is the display, not what is left between two bars.
    expect(box!.height).toBeGreaterThan(viewport.height * 0.95);

    // …and the actions sit on top of it rather than below.
    const favourite = await page.getByRole('button', { name: 'Favourite' }).boundingBox();
    expect(favourite!.y).toBeGreaterThan(box!.y);
    expect(favourite!.y).toBeLessThan(box!.y + box!.height);
    await page.screenshot({ path: 'test-results/49-viewer-full-bleed.png' });
  });

  /**
   * The point of the mode: the queue keeps refilling itself, and Generate
   * becomes a dial rather than a button.
   */
  test('keeps generating until stopped', async ({ page }) => {
    await resetState();
    await seedWorkflow();
    await open(page, '/');
    await page.getByPlaceholder('Describe the image…').fill('endless from the phone');

    await page.getByRole('button', { name: 'Endless generation' }).click();
    await expect(page.getByText(/Generating until stopped/)).toBeVisible();
    // Generate stops queueing and starts updating.
    await expect(page.getByRole('button', { name: 'Update' })).toBeVisible();
    await page.screenshot({ path: 'test-results/50-endless.png' });

    // Nobody taps anything, and pictures keep arriving.
    await expect
      .poll(
        async () =>
          withApi(async (ctx) => {
            const gallery = (await (await ctx.get('/api/gallery?limit=50')).json()) as {
              items: unknown[];
            };
            return gallery.items.length;
          }),
        { timeout: 90_000 },
      )
      .toBeGreaterThanOrEqual(2);

    // A finished run presents itself over everything, as it should — put it
    // away before reaching for the switch underneath.
    await dismissResult(page);
    await page.getByRole('button', { name: 'Endless generation' }).click();
    await expect(page.getByText(/Generating until stopped/)).toHaveCount(0);
    await withApi((ctx) => ctx.post('/api/queue/interrupt'));
  });

  /** Dragging in the editor has to move the field on the screen it edits. */
  test('rearranges the generation section, not only the editor list', async ({ page }) => {
    await resetState();
    await seedWorkflow();

    await open(page, '/settings');
    await page.getByRole('button', { name: 'Edit form' }).click();

    // Move the prompt below its neighbour and check the Generate screen agrees.
    const rows = page.locator('[data-field]');
    const before = await rows.evaluateAll((all) =>
      all.map((row) => row.getAttribute('data-field')),
    );
    const moved = before[0] as string;
    const target = before[1] as string;

    const handle = page.locator(`[data-field="${moved}"]`).getByRole('button', { name: /^Reorder/ });
    await handle.scrollIntoViewIfNeeded();
    const grip = await handle.boundingBox();
    const fromRow = await page.locator(`[data-field="${moved}"]`).boundingBox();
    const toRow = await page.locator(`[data-field="${target}"]`).boundingBox();

    const delta = toRow!.y + toRow!.height / 2 - (fromRow!.y + fromRow!.height / 2);
    const x = grip!.x + grip!.width / 2;
    const y = grip!.y + grip!.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + delta, { steps: 8 });
    await page.mouse.move(x, y + delta + 1);
    await page.mouse.up();

    await expect
      .poll(async () => rows.evaluateAll((all) => all.map((r) => r.getAttribute('data-field'))))
      .toEqual([target, moved, ...before.slice(2)]);

    await page.getByRole('button', { name: 'Done' }).click();
    await page.getByRole('link', { name: 'Generate' }).click();

    /*
     * The two fields, on the Generate screen, in the order just set. This is
     * the assertion the old bucketing-by-role rendering could never satisfy:
     * it kept its own fixed sequence whatever the editor said.
     */
    const promptBox = await page.getByPlaceholder('Describe the image…').boundingBox();
    const negativeBox = await page.getByPlaceholder('What to avoid…').boundingBox();
    expect(promptBox!.y).toBeGreaterThan(negativeBox!.y);
    await page.screenshot({ path: 'test-results/51-form-order.png' });
  });

  /** Squares read as one scale; circles read as a scatter of beads. */
  test('draws the point line as boxes under the Generate button', async ({ page }) => {
    await resetState();
    await seedWorkflow();
    await open(page, '/settings');

    await page.getByRole('button', { name: 'Edit form' }).click();
    const row = page.locator('[data-field="3.steps"]');
    await row.getByRole('button', { name: 'Points' }).click();
    await row.getByRole('textbox', { name: /points from/ }).fill('20');
    await row.getByRole('textbox', { name: /points to/ }).fill('40');
    await row.getByRole('textbox', { name: /points step/ }).fill('10');
    await page.getByRole('button', { name: 'Done' }).click();

    await page.getByRole('link', { name: 'Generate' }).click();
    const point = page.getByRole('button', { name: /^Steps 20$/ });
    await expect(point).toBeVisible();

    const radius = await point.evaluate((element) => getComputedStyle(element).borderTopLeftRadius);
    // A box, not a pill: well under half the 32px height.
    expect(Number.parseFloat(radius)).toBeLessThan(10);

    // And below the Generate button in the stacking order, not over it.
    const generate = page.getByRole('button', { name: /^Generate/ });
    const box = await generate.boundingBox();
    const onTop = await page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.closest('button')?.textContent ?? '',
      { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 },
    );
    expect(onTop).toMatch(/Generate/);
  });
});

/** Wave sixteen: catching up after being away, and reading the timeline. */
test.describe('the sixteenth wave', () => {
  /**
   * The socket is the source of truth while it is connected. It is not a record
   * of what it missed.
   *
   * A phone that locks its screen drops the connection; the runs in flight
   * finish without anybody hearing about it; on reconnect the server sends a
   * snapshot of the *live* state and no `generation` events for what ended in
   * the meantime. So the gallery kept its placeholders and went on saying
   * "rendering" about pictures already on disk.
   *
   * Asserted as the mechanism rather than by staging a locked phone: what the
   * fix adds is a refetch of the history at the two moments the client may have
   * missed something, and that is exactly what this checks. Staging it in a
   * browser is unreliable — Playwright's own network handling makes React Query
   * reconnect and refetch for reasons a backgrounded phone never has.
   */
  test('refetches the history when the app comes back to the foreground', async ({ page }) => {
    await resetState();
    await seedWorkflow();
    await open(page, '/gallery');

    const requests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/gallery')) requests.push(request.url());
    });

    // Settle, so anything the first paint asked for is already counted.
    await page.waitForTimeout(1_000);
    const before = requests.length;

    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

    await expect.poll(() => requests.length).toBeGreaterThan(before);
    await page.screenshot({ path: 'test-results/52-caught-up.png' });
  });

  /** Iterating on a prompt wants the queue gone, not eight more of the old one. */
  test('clears the queue before generating when told to', async ({ page }) => {
    await resetState();
    await seedWorkflow();

    await open(page, '/settings');
    await page.getByRole('button', { name: 'Clear what is waiting' }).click();
    await expect(page.getByRole('button', { name: 'Clear what is waiting' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.screenshot({ path: 'test-results/53-queue-policy.png' });

    await page.getByRole('link', { name: 'Generate' }).click();
    await page.getByRole('button', { name: '8', exact: true }).click();
    await page.getByPlaceholder('Describe the image…').fill('first batch');
    await page.getByRole('button', { name: /^Generate/ }).click();

    // A finished run presents itself over everything; put it away first.
    await dismissResult(page);
    await page.getByPlaceholder('Describe the image…').fill('second batch');
    await page.getByRole('button', { name: /^Generate/ }).click();

    // Nothing from the first batch is left waiting.
    await expect
      .poll(async () =>
        withApi(async (ctx) => {
          const state = (await (await ctx.get('/api/queue')).json()) as {
            pending: { title: string }[];
          };
          return state.pending.filter((entry) => entry.title === 'first batch').length;
        }),
      )
      .toBe(0);

    await withApi(async (ctx) => {
      await ctx.post('/api/queue/interrupt');
      await ctx.patch('/api/settings', { data: { queuePolicy: 'append' } });
    });
  });

  /** Six charts on a phone is six unreadable charts. */
  test('draws only the chosen readings, and names events on the line', async ({ page }) => {
    await resetState();
    await seedWorkflow();
    await open(page, '/');
    await page.getByPlaceholder('Describe the image…').fill('for the timeline');
    await page.getByRole('button', { name: /^Generate/ }).click();
    await dismissResult(page);

    await openModule(page, 'Monitor');
    await expect(page.getByTestId('monitor-picker')).toBeVisible({ timeout: 30_000 });

    // Turn everything off but VRAM.
    for (const name of ['GPU', 'CPU', 'System RAM', 'Sampler', 'Queue']) {
      await page.getByRole('button', { name: `Show ${name}` }).click();
    }
    await expect(page.getByTestId('monitor-charts').locator('svg')).toHaveCount(1);

    // A finer window, so events inside one render are not one smudge.
    await page.getByRole('button', { name: '1 min' }).click();

    // The events stand on the line, turned a quarter clockwise.
    const label = page.getByTestId('monitor-charts').locator('span.rotate-90').first();
    await expect(label).toBeVisible({ timeout: 30_000 });
    // Tailwind v4 uses the standalone `rotate` property, not a `transform`.
    const rotation = await label.evaluate((element) => getComputedStyle(element).rotate);
    expect(rotation).toBe('90deg');
    await page.screenshot({ path: 'test-results/54-monitor-events.png' });

    // The choice survives leaving the tab, because it is about this screen.
    await page.getByRole('link', { name: 'Gallery' }).click();
    await openModule(page, 'Monitor');
    await expect(page.getByTestId('monitor-charts').locator('svg')).toHaveCount(1);
  });
});

/**
 * Wave seventeen: the chat module.
 *
 * Driven against a stand-in for llama.cpp whose replies are scripted, because
 * what these tests are about is the plumbing around the model — the stream, the
 * tool dialogs, and what accepting one actually does — rather than the model.
 */
test.describe('the chat module', () => {
  const LLAMA = 'http://127.0.0.1:8189';

  /** Queue what the mock model will say next. */
  const script = async (...replies: unknown[]) => {
    const context = await apiRequest.newContext({ baseURL: LLAMA });
    try {
      await context.post('/__script', { data: replies });
    } finally {
      await context.dispose();
    }
  };

  test.beforeEach(async () => {
    await resetState();
    await withApi((ctx) =>
      ctx.patch('/api/settings', { data: { chat: { baseUrl: LLAMA, thinking: true } } }),
    );
    // A conversation carries over between tests otherwise, and the transcript
    // is what most of these assert on.
    await withApi(async (ctx) => {
      const chats = (await (await ctx.get('/api/chat/conversations')).json()) as { id: string }[];
      for (const chat of chats) await ctx.delete(`/api/chat/conversations/${chat.id}`);
    });
  });

  /** Chat is the middle tab, and the three set-up modules are behind one more. */
  test('puts Chat in the middle and the rest behind More', async ({ page }) => {
    await open(page, '/');

    const tabs = page.locator('nav li');
    await expect(tabs).toHaveCount(7);

    // Fourth of seven is the middle.
    const labels = await tabs.evaluateAll((all) =>
      all.map((tab) => tab.textContent?.replace(/[^A-Za-z]/g, '') ?? ''),
    );
    expect(labels[3]).toBe('Chat');

    // Blocks, Random and Monitor are not tabs any more.
    expect(labels.join(' ')).not.toContain('Blocks');

    await page.getByRole('button', { name: 'More modules' }).click();
    await expect(page.getByTestId('more-menu')).toBeVisible();
    await page.screenshot({ path: 'test-results/55-tabs.png' });

    await page.getByRole('button', { name: 'Blocks' }).click();
    await expect(page.getByRole('heading', { name: 'Blocks', exact: true })).toBeVisible();
    await expect(page.getByTestId('more-menu')).toHaveCount(0);
  });

  test('streams a reply and folds the reasoning away', async ({ page }) => {
    await script({
      reasoning: 'They want something calm.',
      content: 'How about a harbour at dawn?',
    });

    await open(page, '/chat');
    await page.getByPlaceholder('Say something…').fill('suggest something');
    await page.getByRole('button', { name: 'Send' }).click();

    await expect(page.getByText('How about a harbour at dawn?')).toBeVisible({ timeout: 30_000 });

    // The reasoning is there, and closed.
    const thinking = page.getByRole('button', { name: /Thinking/ });
    await expect(thinking).toBeVisible();
    await expect(page.getByText('They want something calm.')).toHaveCount(0);
    await thinking.click();
    await expect(page.getByText('They want something calm.')).toBeVisible();
    await page.screenshot({ path: 'test-results/56-chat.png' });
  });

  /**
   * The tool this module exists for: a prompt you can send straight to ComfyUI
   * with the settings you already have.
   */
  test('offers a built prompt, and generating it uses the Generate settings', async ({ page }) => {
    await seedWorkflow();
    await script({
      content: 'Here is one.',
      toolCall: {
        name: 'build_prompt',
        arguments: {
          prompt: 'a harbour at dawn, soft light, muted colours',
          reason: 'Calm, blue, early.',
        },
      },
    });

    await open(page, '/chat');
    await page.getByPlaceholder('Say something…').fill('build me a prompt');
    await page.getByRole('button', { name: 'Send' }).click();

    // The dialog floats over the transcript, which is blurred behind it.
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByRole('textbox', { name: 'The prompt' })).toHaveValue(
      'a harbour at dawn, soft light, muted colours',
    );
    // …and it says what generating would actually do.
    await expect(dialog.getByText(/Generating with/)).toBeVisible();
    await expect(dialog.getByText(WORKFLOW_NAME)).toBeVisible();
    await page.screenshot({ path: 'test-results/57-build-prompt.png' });

    await dialog.getByRole('button', { name: 'Generate' }).click();

    // It queued with the same workflow the Generate screen would have used.
    await expect
      .poll(
        async () =>
          withApi(async (ctx) => {
            const gallery = (await (await ctx.get('/api/gallery?limit=10')).json()) as {
              items: { title: string }[];
            };
            return gallery.items[0]?.title ?? '';
          }),
        { timeout: 60_000 },
      )
      .toContain('a harbour at dawn');
  });

  /** Rejecting leaves the conversation exactly where it was. */
  test('carries on chatting when a prompt is rejected', async ({ page }) => {
    await seedWorkflow();
    await script(
      {
        toolCall: {
          name: 'build_prompt',
          arguments: { prompt: 'a harbour at dawn', reason: 'Calm.' },
        },
      },
      { content: 'Fair enough — what would you change?' },
    );

    await open(page, '/chat');
    await page.getByPlaceholder('Say something…').fill('build me a prompt');
    await page.getByRole('button', { name: 'Send' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await dialog.getByRole('button', { name: 'Reject' }).click();

    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText('Fair enough — what would you change?')).toBeVisible({
      timeout: 30_000,
    });
    // Nothing was queued.
    expect(
      await withApi(async (ctx) => {
        const gallery = (await (await ctx.get('/api/gallery?limit=10')).json()) as {
          items: unknown[];
        };
        return gallery.items.length;
      }),
    ).toBe(0);
  });

  /** Blocks arrive one at a time, and only what you keep is saved. */
  test('keeps the proposed blocks you choose, as edited', async ({ page }) => {
    await script(
      {
        content: 'Three ideas.',
        toolCall: {
          name: 'prompt_blocks',
          arguments: {
            reason: 'Lighting you keep asking for.',
            blocks: [
              { action: 'add', name: 'Golden hour', category: 'Lighting', text: 'warm rim light' },
              { action: 'add', name: 'Overcast', category: 'Lighting', text: 'flat grey sky' },
              { action: 'add', name: 'Nonsense', category: 'Lighting', text: 'ignore me' },
            ],
          },
        },
      },
      { content: 'Saved.' },
    );

    await open(page, '/chat');
    await page.getByPlaceholder('Say something…').fill('block ideas please');
    await page.getByRole('button', { name: 'Send' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByRole('button', { name: 'Keep 3' })).toBeVisible();

    // Drop one, and correct another before keeping it.
    await dialog.getByRole('button', { name: 'Keep Nonsense' }).click();
    await expect(dialog.getByRole('button', { name: 'Keep 2' })).toBeVisible();

    await dialog.getByRole('button', { name: 'Edit Overcast' }).click();
    await dialog.getByRole('textbox', { name: 'Block text' }).fill('flat grey daylight');
    await page.screenshot({ path: 'test-results/58-blocks-tool.png' });

    await dialog.getByRole('button', { name: 'Keep 2' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    const blocks = await withApi(async (ctx) =>
      (await (await ctx.get('/api/prompt-blocks')).json()) as { name: string; text: string }[],
    );
    expect(blocks.map((block) => block.name).sort()).toEqual(['Golden hour', 'Overcast']);
    expect(blocks.find((block) => block.name === 'Overcast')?.text).toBe('flat grey daylight');
  });
});
