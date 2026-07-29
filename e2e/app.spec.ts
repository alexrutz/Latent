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
  await page.getByRole('button', { name: 'Import' }).click();
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

    // The tag is lifted out of the text into a real control.
    await expect(page.getByText('pixel_art_xl', { exact: true })).toBeVisible();
    await expect(page.getByText('Plus text: a castle')).toBeVisible();

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
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('in use')).toBeVisible();

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
