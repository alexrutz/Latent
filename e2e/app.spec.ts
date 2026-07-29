import { expect, request as apiRequest, test, type Page } from '@playwright/test';

import { sd15Txt2Img, uiFormatWorkflow } from '../shared/src/fixtures/workflows.js';

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

/** Remove every workflow and gallery entry, so a test starts from nothing. */
async function resetState() {
  await withApi(async (ctx) => {
    const workflows = (await (await ctx.get('/api/workflows')).json()) as { id: string }[];
    for (const workflow of workflows) await ctx.delete(`/api/workflows/${workflow.id}`);

    const gallery = (await (await ctx.get('/api/gallery?limit=100')).json()) as {
      items: { id: string }[];
    };
    for (const item of gallery.items) await ctx.delete(`/api/gallery/${item.id}`);
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
