import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, request as apiRequest, test, type Page } from '@playwright/test';

import {
  img2img,
  ltxVideoGguf,
  minimaxMusic,
  sd15Txt2Img,
  videoCombine,
  sd15Txt2ImgUi,
  sd15WithLoraInput,
  uiFormatWorkflow,
  withLlamaServer,
  withPresetChat,
  withTextPreview,
} from '../shared/src/fixtures/workflows.js';
import { defaultSampling } from '../shared/src/apiTypes.js';
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
 * The same, with a pass for the notes about what you like.
 *
 * Those routes want the password a second time — being signed in is
 * deliberately not enough for that one screen — so a test that sets them up
 * buys a pass the way the app does.
 */
/**
 * Open the notes sheet, which asks for the password even though you are in.
 *
 * A helper because it is now two steps everywhere, and because the assertion
 * that it *is* two steps belongs in one test rather than in all of them.
 */
async function openTasteSheet(page: Page) {
  await page.getByRole('button', { name: 'What you like' }).click();
  const sheet = page.getByRole('dialog', { name: 'What you like' });
  const password = sheet.getByLabel('Password');
  if (await password.isVisible().catch(() => false)) {
    await password.fill(PASSWORD);
    await sheet.getByRole('button', { name: 'Open' }).click();
    await expect(password).toBeHidden();
  }
  return sheet;
}

async function withTaste<T>(
  fn: (
    ctx: Awaited<ReturnType<typeof apiRequest.newContext>>,
    headers: Record<string, string>,
  ) => Promise<T>,
) {
  return withApi(async (ctx) => {
    const opened = (await (
      await ctx.post('/api/taste/unlock', { data: { password: PASSWORD } })
    ).json()) as { ticket: string };
    return fn(ctx, { 'x-latent-taste': opened.ticket });
  });
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
 * Only open when the progress bar was left open — see the rule in `LiveBar` —
 * so for most tests there is nothing here to close. Short on purpose: when it
 * is up it is up the moment the run ends, so a long wait here would only be
 * time spent proving a negative.
 */
async function dismissResult(page: Page) {
  const dismiss = page.getByRole('button', { name: 'Dismiss' });
  try {
    await dismiss.waitFor({ state: 'visible', timeout: 1_500 });
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
async function openModule(page: Page, label: 'Blocks' | 'Random' | 'Monitor' | 'Study') {
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

    /*
     * Notes about what the user likes go into the system prompt, so one left
     * behind would quietly colour every later chat test's reply.
     */
    const opened = (await (
      await ctx.post('/api/taste/unlock', { data: { password: PASSWORD } })
    ).json()) as { ticket: string };
    const pass = { 'x-latent-taste': opened.ticket };
    const taste = (await (await ctx.get('/api/taste', { headers: pass })).json()) as {
      categories: { id: string }[];
      entries: { id: string }[];
    };
    for (const entry of taste.entries ?? []) {
      await ctx.delete(`/api/taste/entries/${entry.id}`, { headers: pass });
    }
    for (const category of taste.categories ?? []) {
      await ctx.delete(`/api/taste/categories/${category.id}`, { headers: pass });
    }

    /*
     * System prompts reach into every workflow with a field of the same name,
     * so one left behind would quietly rewrite a later test's text input. The
     * chat's choice of one goes with them.
     */
    const prompts = (await (await ctx.get('/api/system-prompts')).json()) as { id: string }[];
    for (const prompt of prompts) await ctx.delete(`/api/system-prompts/${prompt.id}`);

    /*
     * Model servers are connections now. The ComfyUI one is left alone — it is
     * what the whole suite runs against — but a stale llama entry would point
     * the chat at a port from a previous test.
     */
    const connections = (await (await ctx.get('/api/connections')).json()) as {
      id: string;
      kind: string;
    }[];
    for (const connection of connections) {
      if (connection.kind === 'llama') await ctx.delete(`/api/connections/${connection.id}`);
    }

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

    // Studies own generations of their own, hidden from the gallery — so
    // deleting gallery entries above does not reach them.
    const studies = (await (await ctx.get('/api/studies')).json()) as { id: string }[];
    for (const study of studies) await ctx.delete(`/api/studies/${study.id}`);

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

  test('keeps the finished image reachable instead of closing', async ({ page }) => {
    await open(page, '/');
    await page.getByPlaceholder('Describe the image…').fill('a result that stays put');
    await page.getByRole('button', { name: /^Generate/ }).click();

    /*
     * The run ending used to unmount this bar, which dumped you back on the
     * form at the exact moment the picture became available. It stays — one
     * tap from the picture rather than in front of it, which is the rule the
     * twenty-sixth wave covers.
     */
    await page.getByRole('button', { name: 'Show the finished picture' }).click({
      timeout: 60_000,
    });
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

    // Both kinds of server live in this one section now, so the button says
    // which one it adds.
    await page.getByRole('button', { name: 'Add a ComfyUI connection' }).click();
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
     * pass even if the server quietly served the full-size file — which is
     * exactly what it did for months, because ComfyUI's `preview=` re-encodes
     * without resizing and the mock used to hide that by resizing. So check
     * what the browser actually decoded: the mock renders results at 512px,
     * and a thumbnail is 384.
     */
    const decoded = await page
      .locator('img[alt*="thumbnail check"]')
      .first()
      .evaluate((image: HTMLImageElement) => image.naturalWidth);
    expect(decoded).toBe(384);
  });

  /**
   * A long gallery used to stutter. Two causes, both fixed: reporting an image's
   * size was a React Query mutation that re-rendered every tile on each of the
   * hundred loads, and off-screen tiles were still being laid out and painted.
   */
  test('keeps a long grid cheap to scroll', async ({ page }) => {
    await generate(page, 'scroll load', 8);

    /*
     * Every size report this page makes, from the moment the gallery opens.
     *
     * Watched from before the first tile rather than from after it: a tile
     * scrolled into view for the first time is *allowed* to report — that is
     * the one measurement it exists to take — so what has to be proved is that
     * nothing reports twice, and that can only be seen across the whole visit.
     */
    const reports: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/dimensions')) reports.push(request.postData() ?? '');
    });

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

    await page.locator('main').evaluate((element) => element.scrollTo(0, element.scrollHeight));
    await page.waitForTimeout(600);
    await page.locator('main').evaluate((element) => element.scrollTo(0, 0));
    await page.waitForTimeout(600);

    /*
     * Each image reports its size at most once, ever. Before, this fired on
     * every load and on every remount — the request storm that came with the
     * re-render storm — so scrolling a long grid up and down was a request per
     * tile per pass.
     */
    expect(reports.length).toBeGreaterThan(0);
    expect(new Set(reports).size).toBe(reports.length);
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

    // One tap opens the picture itself, and re-running it is an action on it.
    await favorite.click();
    await expect(page.getByTestId('viewer-image')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reseed', exact: true })).toBeVisible();

    /*
     * Favourites carry their own rating, separate from the gallery's: the
     * stars on the picture say it came out well, these say you want more like
     * it. It lives with the rest of what a favourite knows, behind Details.
     */
    await page.getByRole('button', { name: 'Details' }).click();
    // Scoped to the sheet: the picture's own stars are on the panel behind it,
    // and telling the two apart is the point of them being separate.
    await page
      .getByRole('group', { name: 'Want more like this' })
      .getByRole('button', { name: '4 stars' })
      .click();
    await page.screenshot({ path: 'test-results/12-favourites.png' });

    await page.getByRole('button', { name: 'Done' }).click();
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByText('★★★★').first()).toBeVisible();
  });

  /**
   * A favourite opens in the viewer the gallery opens, in one tap.
   *
   * It used to get a stripped one with nothing on it, so the picture you had
   * already said you cared about was the one you could do least with. Then it
   * got a page of its own in front of the viewer, which was one tap too many
   * for looking at a picture you are already looking at a thumbnail of.
   */
  test('opens a favourite in the gallery’s own viewer', async ({ page }) => {
    await generate(page, 'the same viewer');

    await open(page, '/gallery');
    await page.locator('img[alt*="the same viewer"]').first().click();
    await page.getByRole('button', { name: /Favourite/ }).click();
    await page.getByRole('button', { name: 'Close' }).click();

    await page.getByRole('link', { name: 'Favourites' }).click();
    const favorite = page.locator('img[alt="the same viewer"]').first();
    await expect(favorite).toBeVisible({ timeout: 20_000 });
    await favorite.click();
    await expect(page.getByTestId('viewer-image')).toBeVisible();

    // Every action the gallery's viewer carries, including the rating that
    // stores the bytes on this device.
    for (const name of ['Save', 'Keep', 'Reseed', 'Reuse', 'Upscale', 'Details']) {
      await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
    }
    await expect(page.getByRole('button', { name: 'Favourited' })).toBeVisible();
    await page.screenshot({ path: 'test-results/83-favourite-viewer.png' });

    // Rating from here writes to the run the favourite came from, which is only
    // possible because the viewer is looking at that run rather than at a copy.
    await page.getByRole('button', { name: '3 stars' }).click();
    await expect
      .poll(async () => {
        const gallery = await withApi(async (ctx) => {
          const response = await ctx.get('/api/gallery');
          return (await response.json()) as { items: { images: { rating: number }[] }[] };
        });
        return gallery.items.flatMap((item) => item.images).map((image) => image.rating);
      })
      .toContain(3);

    // And the settings behind the picture are readable, as they are anywhere else.
    await page.getByRole('button', { name: 'Details' }).click();
    await expect(page.getByText('the same viewer').first()).toBeVisible();
  });

  /**
   * Swiping in Favourites moves through the favourites.
   *
   * The list you are looking at is the list you swipe: opening the third
   * favourite and flicking gives the second, exactly as the gallery gives the
   * next picture. It used to give the next image of the *batch* the favourite
   * came out of — pictures you had not asked to see, from a list you were not
   * in.
   */
  test('swipes from one favourite to the next', async ({ page }) => {
    for (const title of ['first favourite', 'second favourite']) {
      await generate(page, title);
      await open(page, '/gallery');
      await page.locator(`img[alt*="${title}"]`).first().click();
      await page.getByRole('button', { name: /Favourite/ }).click();
      await page.getByRole('button', { name: 'Close' }).click();
    }

    await page.getByRole('link', { name: 'Favourites' }).click();
    await expect(page.locator('img[alt="first favourite"]').first()).toBeVisible({
      timeout: 20_000,
    });

    await page.locator('main img').first().click();
    const counter = page.getByText(/^\d+ \/ 2$/);
    await expect(counter).toBeVisible();

    const stage = page.locator('div.touch-none').first();
    const box = (await stage.boundingBox()) as { x: number; y: number; width: number; height: number };
    const midY = box.y + box.height / 2;
    const base = { pointerId: 1, bubbles: true, isPrimary: true };
    const from = box.x + box.width * 0.8;
    const to = from - box.width * 0.6;
    await stage.dispatchEvent('pointerdown', { ...base, clientX: from, clientY: midY });
    await stage.dispatchEvent('pointermove', { ...base, clientX: to, clientY: midY });
    await stage.dispatchEvent('pointerup', { ...base, clientX: to, clientY: midY });

    await expect(counter).toHaveText('2 / 2');
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

    // Anchored: the chat settings on this screen have a "Sparse" step of their
    // own on the prompt-detail scale, whose label merely ends with the word.
    await page.getByRole('button', { name: /^Sparse/ }).click();
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

    // Nothing covers the screen any more, but a stray sheet from an earlier
    // step would, so this stays.
    await dismissResult(page);

    await page.getByRole('link', { name: 'Gallery' }).click();
    await page.locator('main img').first().click({ timeout: 60_000 });
  }

  /**
   * The finished run stays reachable without taking the screen: the bar carries
   * the thumbnail, and the sheet it opens is the same one as before.
   */
  test('offers the finished picture from the bar, one tap away', async ({ page }) => {
    await open(page, '/');
    await page.getByPlaceholder('Describe the image…').fill('show me straight away');
    await page.getByRole('button', { name: /^Generate/ }).click();

    // The bar carries the thumbnail; the sheet is behind one tap.
    const bar = page.getByRole('button', { name: 'Show the finished picture' });
    await expect(bar).toBeVisible({ timeout: 60_000 });
    await bar.click();

    await expect(page.getByRole('dialog').getByText('Rate it')).toBeVisible();
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
    /*
     * Saved by the editor, not exported — which is what is actually on disk —
     * and carrying the prefix, since the scan only reads marked files. The
     * name inside is `from-the-editor`, with the marker stripped.
     */
    writeFileSync(join(workflows, 'API_from-the-editor.json'), JSON.stringify(sd15Txt2ImgUi));

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

  /**
   * Throw away anything a previous test queued or sent.
   *
   * The scripted replies are a queue on the mock, so a test that ends before
   * consuming what it scripted hands its leftovers to whichever test runs next
   * — which then reads a reply meant for something else and fails for a reason
   * that has nothing to do with it. One failure became fourteen that way.
   */
  const resetLlama = async () => {
    const context = await apiRequest.newContext({ baseURL: LLAMA });
    try {
      await context.post('/__reset');
    } finally {
      await context.dispose();
    }
  };

  /** How many requests the model server has been sent so far. */
  const requestCount = async (): Promise<number> => {
    const context = await apiRequest.newContext({ baseURL: LLAMA });
    try {
      return ((await (await context.get('/__requests')).json()) as unknown[]).length;
    } finally {
      await context.dispose();
    }
  };

  /**
   * Press ✦ and take the first of its two options.
   *
   * The button offers rather than fires now — "generate now" and "fresh prompt,
   * then generate" — so every test that used to press it goes through the same
   * two taps a person does.
   */
  const pressPromptButton = async (page: Page) => {
    await page.getByRole('button', { name: 'Build a prompt' }).click();
    await page.getByRole('button', { name: 'Generate now' }).click();
  };

  /** Everything the model server has been sent, for "was this ever said". */
  const allRequests = async (): Promise<string> => {
    const context = await apiRequest.newContext({ baseURL: LLAMA });
    try {
      return JSON.stringify((await (await context.get('/__requests')).json()) as unknown[]);
    } finally {
      await context.dispose();
    }
  };

  /** The whole of the last request, for asserting on what was sent. */
  const lastRequest = async (): Promise<string> => {
    const context = await apiRequest.newContext({ baseURL: LLAMA });
    try {
      const sent = (await (await context.get('/__requests')).json()) as unknown[];
      return JSON.stringify(sent.at(-1) ?? {});
    } finally {
      await context.dispose();
    }
  };

  /** Which tools the last request actually put in front of the model. */
  const lastOffer = async (): Promise<string[]> => {
    const context = await apiRequest.newContext({ baseURL: LLAMA });
    try {
      const sent = (await (await context.get('/__requests')).json()) as {
        tools?: { function: { name: string } }[];
      }[];
      return (sent.at(-1)?.tools ?? []).map((tool) => tool.function.name);
    } finally {
      await context.dispose();
    }
  };

  /**
   * Point the chat at the stand-in model server.
   *
   * A connection like any other now, in the same list as ComfyUI's — which is
   * the whole point of the change: one list, one dialog, one way of saying
   * "talk to this box".
   */
  const useLlama = async (url = LLAMA): Promise<string> => {
    return withApi(async (ctx) => {
      const created = await ctx.post('/api/connections', {
        data: { kind: 'llama', name: `Model server ${url}`, url },
      });
      const connection = (await created.json()) as { id: string };
      await ctx.post(`/api/connections/${connection.id}/activate`);
      return connection.id;
    });
  };

  test.beforeEach(async () => {
    await resetState();
    await resetLlama();
    await useLlama();
    // The whole chat block, not a patch of it: settings merge, so a test that
    // switches a tool off would otherwise leave it off for everything after it.
    await withApi((ctx) =>
      ctx.patch('/api/settings', {
        data: {
          chat: {
            thinking: true,
            generation: { workflowId: '', values: {} },
            // Pinned, all of it: settings merge, so anything a test changes
            // stays changed for every test after it.
            promptButton: 'generate',
            showDiff: { inDialog: true, underPicture: true },
            tools: {
              build_prompt: 'settled',
              prompt_blocks: 'settled',
              ask_user: 'settled',
            },
            // Off unless the test is about it: every render would otherwise be
            // followed by a turn carrying a picture, which is a different reply
            // from the one most of these are asserting on.
            review: { enabled: false, threshold: 'balanced', keepInView: 2, askWhen: 'never' },
            // Pinned for the same reason as everything else here: a run left on
            // would accept the next test's proposals for it.
            autonomous: { enabled: false, maxRounds: 4 },
            // Pinned like the rest: a run left on would take over the next test.
            wander: { workflowId: '', attributes: 3, sampling: 'chat' },
          },
        },
      }),
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

    // And you are still in the conversation, with the picture in it. Being sent
    // to the Generate screen threw away the thread at the moment it paid off.
    expect(new URL(page.url()).pathname).toBe('/chat');
    const picture = page.getByRole('button', { name: /Open picture/ }).first();
    await expect(picture).toBeVisible({ timeout: 60_000 });
    await page.screenshot({ path: 'test-results/60-chat-picture.png' });

    // Tap to look at it properly, tap again to put it away.
    await picture.click();
    const viewer = page.getByTestId('viewer-image');
    await expect(viewer).toBeVisible();
    await viewer.click();
    await expect(viewer).toHaveCount(0);
  });

  /**
   * Looking at what came out, and saying so.
   *
   * The turn after a render used to be the model talking about a picture it had
   * never seen. Shown the result and the prompt together, it can say which
   * parts arrived — and, when they are far enough apart, offer a rewrite that
   * is a proposal like any other.
   */
  test('shows the finished picture to the model and offers its rewrite', async ({ page }) => {
    await seedWorkflow();
    await withApi((ctx) =>
      ctx.patch('/api/settings', {
        data: {
          chat: {
            review: { enabled: true, threshold: 'balanced', keepInView: 2, askWhen: 'never' },
          },
        },
      }),
    );

    await script({
      toolCall: {
        name: 'build_prompt',
        arguments: { prompt: 'a harbour at dawn, soft light', reason: 'Calm and blue.' },
      },
    });

    await open(page, '/chat');
    await page.getByPlaceholder('Say something…').fill('build me a prompt');
    await page.getByRole('button', { name: 'Send' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 30_000 });

    // What it says about the picture, and what it proposes instead.
    await script({
      content: 'The light is right, but there is no harbour in it.',
      toolCall: {
        name: 'revise_prompt',
        arguments: {
          prompt: 'a working harbour at dawn, boats at the quay, soft light',
          reason: 'The harbour itself never appeared.',
          score: 4,
        },
      },
    });

    await dialog.getByRole('button', { name: 'Generate' }).click();

    /*
     * The rewrite waits rather than covering the picture.
     *
     * The whole point of the review is that you see the result first, read what
     * the model made of it, and then decide — so the proposal arrives folded
     * away above the composer, and the transcript behind it stays readable.
     */
    const putAside = page.getByRole('button', { name: /Proposed a rewrite — waiting on you/ });
    await expect(putAside).toBeVisible({ timeout: 90_000 });
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Open picture/ }).first()).toBeVisible();
    await page.screenshot({ path: 'test-results/88-prompt-review-aside.png' });

    // And opens when you go to it.
    await putAside.click();
    const rewrite = page.getByRole('dialog');
    await expect(rewrite.getByText('After looking at the picture')).toBeVisible();
    await expect(rewrite.getByText('matched 4/10')).toBeVisible();
    await expect(rewrite.getByRole('textbox', { name: 'The prompt' })).toHaveValue(
      'a working harbour at dawn, boats at the quay, soft light',
    );
    await page.screenshot({ path: 'test-results/89-prompt-review.png' });

    // The picture went over as a picture, and the only tool on that turn was
    // the rewrite — not a fresh proposal on top of one nobody has looked at.
    expect(await lastOffer()).toEqual(['revise_prompt']);
    expect(await lastRequest()).toContain('image_url');

    // And it is a proposal: refusing it leaves the conversation where it was.
    await script({ content: 'Fair enough.' });
    await rewrite.getByRole('button', { name: 'Reject' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByText('Proposed a rewrite')).toBeVisible();

    /*
     * And the picture is still there for the next thing said about it.
     *
     * The point of keeping it in view: "make the sky darker" has to land on the
     * render rather than on the model's own description of one it saw two turns
     * ago, which every change after that would compound.
     */
    await script({ content: 'Darker it is.' });
    await page.getByPlaceholder('Say something…').fill('make the sky darker');
    // Rejecting is itself a turn — the model is told — so the composer is busy
    // for a moment afterwards, and a Send pressed then does nothing at all.
    const send = page.getByRole('button', { name: 'Send' });
    await expect(send).toBeEnabled({ timeout: 30_000 });
    await send.click();
    await expect(page.getByText('Darker it is.')).toBeVisible({ timeout: 30_000 });
    expect(await lastRequest()).toContain('image_url');
  });

  /**
   * You see it first. The model gets it second.
   *
   * The run finishing is not the same as the render being visible — there is a
   * refetch and a download between the two — and against a fast model the
   * judgement of a picture used to arrive before the picture did. Nothing is
   * sent to the model until the transcript has actually drawn it.
   */
  test('shows the picture before the model is given it', async ({ page }) => {
    await seedWorkflow();
    await withApi((ctx) =>
      ctx.patch('/api/settings', {
        data: {
          chat: {
            review: { enabled: true, threshold: 'balanced', keepInView: 2, askWhen: 'never' },
          },
        },
      }),
    );

    /*
     * The picture is made slow to arrive, which is the only way to tell the two
     * orders apart: with an instant image both sequences look identical.
     */
    await page.route('**/api/view**', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      await route.continue();
    });

    await script({
      toolCall: {
        name: 'build_prompt',
        arguments: { prompt: 'a harbour at dawn', reason: 'Calm.' },
      },
    });

    await open(page, '/chat');
    await page.getByPlaceholder('Say something…').fill('build me a prompt');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 30_000 });

    await script({ content: 'It came out well.' });
    const before = await requestCount();
    await page.getByRole('dialog').getByRole('button', { name: 'Generate' }).click();

    // Wait for the render itself to finish, upstream of anything on screen.
    await expect
      .poll(
        async () =>
          withApi(async (ctx) => {
            const gallery = (await (await ctx.get('/api/gallery')).json()) as {
              items: { status: string; images: unknown[] }[];
            };
            const run = gallery.items[0];
            return run?.status === 'completed' && run.images.length > 0;
          }),
        { timeout: 90_000 },
      )
      .toBe(true);

    /*
     * Finished, and still nothing said about it: the picture is on its way down
     * a deliberately slow connection, and the model has not been handed
     * anything. This is the assertion the whole change is about.
     */
    expect(await requestCount()).toBe(before);
    await expect(page.getByText('It came out well.')).toHaveCount(0);

    // Once it is there to look at, the turn happens.
    await expect(page.getByRole('button', { name: /Open picture/ }).first()).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByText('It came out well.')).toBeVisible({ timeout: 60_000 });
    expect(await requestCount()).toBeGreaterThan(before);
    await page.screenshot({ path: 'test-results/92-picture-first.png' });
  });

  /**
   * Carrying on is an answer.
   *
   * A rewrite waits folded away, and the honest reading of "talk about
   * something else instead" is that you do not want it. Leaving it pending
   * would put the next thing said into a conversation the model thinks is
   * still waiting on a decision.
   */
  test('drops an undecided proposal when you say something else', async ({ page }) => {
    await seedWorkflow();
    await withApi((ctx) =>
      ctx.patch('/api/settings', {
        data: {
          chat: {
            review: { enabled: true, threshold: 'balanced', keepInView: 2, askWhen: 'never' },
          },
        },
      }),
    );

    await script({
      toolCall: {
        name: 'build_prompt',
        arguments: { prompt: 'a harbour at dawn', reason: 'Calm.' },
      },
    });

    await open(page, '/chat');
    await page.getByPlaceholder('Say something…').fill('build me a prompt');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 30_000 });

    await script({
      content: 'The harbour is missing.',
      toolCall: {
        name: 'revise_prompt',
        arguments: {
          prompt: 'a working harbour at dawn',
          reason: 'Put the harbour in.',
          score: 4,
        },
      },
    });
    await page.getByRole('dialog').getByRole('button', { name: 'Generate' }).click();

    const putAside = page.getByRole('button', { name: /Proposed a rewrite — waiting on you/ });
    await expect(putAside).toBeVisible({ timeout: 90_000 });

    // Say something else instead of deciding.
    await script({ content: 'Right, something else then.' });
    await page.getByPlaceholder('Say something…').fill('actually, make it a lighthouse');
    const send = page.getByRole('button', { name: 'Send' });
    await expect(send).toBeEnabled();
    await send.click();

    // The proposal is gone — refused, not left hanging — and the conversation
    // carries on with what was said.
    await expect(putAside).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByText('Right, something else then.')).toBeVisible({ timeout: 30_000 });

    // Refused rather than left hanging — and the model was told so, which is
    // what keeps the next turn from arriving in a conversation still waiting.
    const decided = await withApi(async (ctx) => {
      const chats = (await (await ctx.get('/api/chat/conversations')).json()) as { id: string }[];
      const detail = (await (
        await ctx.get(`/api/chat/conversations/${chats[0]?.id}`)
      ).json()) as {
        messages: { toolCall?: { tool: string }; toolResult?: { decision: string } }[];
      };
      return detail.messages.find((message) => message.toolCall?.tool === 'revise_prompt')
        ?.toolResult?.decision;
    });
    expect(decided).toBe('rejected');

    // It stays reachable, like any other prompt in the transcript.
    await expect(page.getByRole('button', { name: /a working harbour at dawn/ })).toBeVisible();
    await page.screenshot({ path: 'test-results/90-proposal-dropped.png' });
  });

  /**
   * Left to get on with it.
   *
   * Every piece of this existed already — the model writes a prompt, the render
   * comes back, it is shown the picture and proposes a rewrite while the match
   * falls short. The mode is the tap that accepted each of those, made
   * automatic, and the thing worth proving end to end is that the loop actually
   * closes: two renders from one sentence, with nobody touching a dialog, and a
   * stop the moment the model says the picture is good.
   */
  test('accepts its own prompts and carries on until the picture is good', async ({ page }) => {
    await seedWorkflow();
    await withApi((ctx) =>
      ctx.patch('/api/settings', {
        data: {
          chat: {
            review: { enabled: true, threshold: 'balanced', keepInView: 2, askWhen: 'never' },
            autonomous: { enabled: true, maxRounds: 4 },
          },
        },
      }),
    );

    // The whole run, scripted up front: a prompt, a rewrite after seeing the
    // first render, and a verdict that ends it after the second.
    await script(
      {
        toolCall: {
          name: 'build_prompt',
          arguments: { prompt: 'a harbour at dawn', reason: 'Calm.' },
        },
      },
      {
        content: 'The light is right, but there is no harbour in it.',
        toolCall: {
          name: 'revise_prompt',
          arguments: {
            prompt: 'a working harbour at dawn, boats at the quay',
            reason: 'The harbour never appeared.',
            score: 4,
          },
        },
      },
      { content: 'That is the picture — the harbour is there and the light held.' },
    );

    await open(page, '/chat');
    await expect(page.getByTestId('autonomous-strip')).toBeVisible();

    await page.getByPlaceholder('Say something…').fill('make me something at dawn');
    await page.getByRole('button', { name: 'Send' }).click();

    // Both renders arrive without a single tap, and the verdict ends the run.
    await expect(page.getByText('That is the picture')).toBeVisible({ timeout: 120_000 });
    await expect(page.getByRole('button', { name: /Open picture/ })).toHaveCount(2);
    // Nothing was ever left waiting on a decision.
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /waiting on you/ })).toHaveCount(0);
    await expect(page.getByTestId('autonomous-strip')).toContainText('Round 2 of 4');
    await page.screenshot({ path: 'test-results/92-autonomous.png' });

    expect(
      await withApi(async (ctx) => {
        const gallery = (await (await ctx.get('/api/gallery?limit=10')).json()) as {
          items: unknown[];
        };
        return gallery.items.length;
      }),
    ).toBe(2);
  });

  /**
   * The brake.
   *
   * A model convinced its prompt is nearly right will rewrite it indefinitely,
   * and by definition nobody is watching. At the limit the run stops with the
   * last proposal waiting rather than throwing it away — so the work is there
   * when you come back to it.
   */
  test('stops at the round limit with the proposal waiting', async ({ page }) => {
    await seedWorkflow();
    await withApi((ctx) =>
      ctx.patch('/api/settings', {
        data: {
          chat: {
            review: { enabled: true, threshold: 'balanced', keepInView: 2, askWhen: 'never' },
            autonomous: { enabled: true, maxRounds: 1 },
          },
        },
      }),
    );

    await script(
      {
        toolCall: {
          name: 'build_prompt',
          arguments: { prompt: 'a harbour at dawn', reason: 'Calm.' },
        },
      },
      {
        content: 'Still not there.',
        toolCall: {
          name: 'revise_prompt',
          arguments: {
            prompt: 'a working harbour at dawn, boats at the quay',
            reason: 'The harbour never appeared.',
            score: 4,
          },
        },
      },
    );

    await open(page, '/chat');
    await page.getByPlaceholder('Say something…').fill('make me something at dawn');
    await page.getByRole('button', { name: 'Send' }).click();

    // One render, and then it stops — with the rewrite folded away, exactly as
    // an unaccepted proposal always is.
    const putAside = page.getByRole('button', { name: /Proposed a rewrite — waiting on you/ });
    await expect(putAside).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId('autonomous-strip')).toContainText('Stopped after 1 of 1 rounds');
    await expect(page.getByRole('button', { name: /Open picture/ })).toHaveCount(1);

    // And it is still a proposal: opening it gives the ordinary dialog.
    await putAside.click();
    await expect(page.getByRole('dialog').getByText('After looking at the picture')).toBeVisible();
  });

  /**
   * Two ways to press the prompt button, in the space of one.
   *
   * The second exists for a conversation that has converged: every prompt is
   * the last one with two words moved, because the last one is sitting in the
   * history being treated as the thing to improve. Choosing it throws that
   * prompt away — the model is told so — asks for a different composition, and
   * generates it without a dialog in the middle.
   */
  test('offers a fresh composition beside generate now', async ({ page }) => {
    await seedWorkflow();
    await withApi((ctx) =>
      ctx.patch('/api/settings', { data: { chat: { promptButton: 'generate' } } }),
    );

    await script(
      { content: 'A harbour, then.' },
      {
        toolCall: {
          name: 'build_prompt',
          arguments: { prompt: 'a different composition entirely', reason: 'Started over.' },
        },
      },
    );

    await open(page, '/chat');
    await page.getByPlaceholder('Say something…').fill('a harbour');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByText('A harbour, then.')).toBeVisible({ timeout: 30_000 });

    // The button does not fire any more — it offers.
    await page.getByRole('button', { name: 'Build a prompt' }).click();
    await expect(page.getByRole('button', { name: 'Generate now' })).toBeVisible();
    const fresh = page.getByRole('button', { name: 'Fresh prompt, then generate' });
    await expect(fresh).toBeVisible();
    await page.screenshot({ path: 'test-results/100-generate-choice.png' });

    await fresh.click();

    // It generated without asking, and the model was told to start over.
    await expect(page.getByRole('button', { name: /Open picture/ }).first()).toBeVisible({
      timeout: 90_000,
    });
    await expect(page.getByRole('dialog')).toHaveCount(0);
    /*
     * Across every request, not the last one: accepting the prompt starts a
     * turn of its own, so by the time the picture is here the build turn is two
     * requests back.
     */
    expect(await allRequests()).toContain('Throw the last prompt away');
  });

  /**
   * The one screen that asks for the password twice.
   *
   * Everything else in the app is pictures and settings — what a phone on a
   * table shows to whoever picks it up. This is a written description of
   * somebody, so the door asks again, and nothing behind it is on screen until
   * it has been answered: not the notes, not how many there are.
   */
  test('asks for the password before showing what you like', async ({ page }) => {
    await withTaste(async (ctx, headers) => {
      await ctx.post('/api/taste/entries', { data: { text: 'a private note' }, headers });
    });

    await open(page, '/chat');
    await page.getByRole('button', { name: 'What you like' }).click();

    const sheet = page.getByRole('dialog', { name: 'What you like' });
    await expect(sheet.getByLabel('Password')).toBeVisible();
    await expect(sheet.getByText('a private note')).toHaveCount(0);
    await page.screenshot({ path: 'test-results/99-taste-locked.png' });

    // The wrong one says so and shows nothing.
    await sheet.getByLabel('Password').fill('not the password');
    await sheet.getByRole('button', { name: 'Open' }).click();
    await expect(sheet.getByRole('alert')).toBeVisible();
    await expect(sheet.getByText('a private note')).toHaveCount(0);

    await sheet.getByLabel('Password').fill(PASSWORD);
    await sheet.getByRole('button', { name: 'Open' }).click();
    await expect(sheet.getByText('a private note')).toBeVisible({ timeout: 30_000 });

    /*
     * And closing it locks again: the pass is held in the tab and handed back,
     * so coming back is another password rather than a second look.
     */
    await sheet.getByRole('button', { name: 'Done' }).click();
    await page.getByRole('button', { name: 'What you like' }).click();
    await expect(sheet.getByLabel('Password')).toBeVisible();
    await expect(sheet.getByText('a private note')).toHaveCount(0);
  });

  /**
   * The headings, once there are enough of them to need managing.
   *
   * Folded away by default so a dozen fit on a phone screen, renamed in place
   * because a heading is one word, and ordered with the two buttons rather than
   * by dragging — a drag on a list of collapsed rows is a gesture that competes
   * with scrolling it.
   */
  test('folds, renames and reorders what you like', async ({ page }) => {
    await withTaste(async (ctx, headers) => {
      for (const name of ['Colour', 'Places', 'Films']) {
        await ctx.post('/api/taste/categories', { data: { name }, headers });
      }
    });

    await open(page, '/chat');
    const sheet = await openTasteSheet(page);

    // All three are on screen at once, and none of them is open.
    for (const name of ['Colour', 'Places', 'Films']) {
      await expect(sheet.getByRole('button', { name: new RegExp(`^${name}`) })).toBeVisible();
    }
    await expect(sheet.getByRole('button', { name: /^Rename/ })).toHaveCount(0);
    await page.screenshot({ path: 'test-results/98-taste-folded.png' });

    // Opening one shows what is under it, and what can be done to it.
    await sheet.getByRole('button', { name: /^Colour/ }).click();
    await sheet.getByRole('button', { name: 'Rename Colour' }).click();
    const field = sheet.getByRole('textbox', { name: 'Rename Colour' });
    await field.fill('Colour and light');
    await field.blur();
    await expect(sheet.getByRole('button', { name: /^Colour and light/ })).toBeVisible({
      timeout: 30_000,
    });

    /*
     * And the order is the order the model reads them in, so it is worth being
     * able to change. Moving the first one down puts the second one first.
     */
    await sheet.getByRole('button', { name: 'Move Colour and light down' }).click();
    await expect
      .poll(async () =>
        withTaste(async (ctx, headers) => {
          const profile = (await (await ctx.get('/api/taste', { headers })).json()) as {
            categories: { name: string }[];
          };
          return profile.categories.map((category) => category.name);
        }),
      )
      .toEqual(['Places', 'Colour and light', 'Films']);
  });

  /**
   * Wandering: picture after picture, out of the notes, until you stop it.
   *
   * Nothing about this is a conversation — no proposal to accept, no comment on
   * what came out — so what is worth proving is that the loop actually turns:
   * one tap produces a picture, and then another, with nobody touching
   * anything. And that tapping one of them answers the only question an endless
   * stream raises: what was that one?
   */
  test('wanders through what you like, picture after picture', async ({ page }) => {
    await seedWorkflow();
    await withTaste(async (ctx, headers) => {
      await ctx.post('/api/taste/entries', { data: { text: 'low fog over water' }, headers });
      await ctx.post('/api/taste/entries', { data: { text: 'brutalist stairwells' }, headers });
      await ctx.patch('/api/settings', {
        data: { chat: { wander: { attributes: 2, sampling: 'chat' } } },
      });
    });

    // Two rounds of prompts, and a third in case the loop is quicker than the
    // assertions — a queue that runs dry mid-test would fail for the wrong
    // reason.
    await script(
      ...[1, 2, 3].map((round) => ({
        toolCall: {
          name: 'build_prompt',
          arguments: { prompt: `wandering picture ${round}`, reason: 'From the notes.' },
        },
      })),
    );

    await open(page, '/chat');
    await page.getByRole('button', { name: 'Wander through your notes' }).click();

    // It says what it is doing, and offers the way out.
    const strip = page.getByTestId('wander-strip');
    await expect(strip).toBeVisible();

    // Two pictures, with nothing tapped in between.
    await expect(page.getByRole('button', { name: /^Open picture/ })).toHaveCount(2, {
      timeout: 120_000,
    });
    await expect(strip).toContainText('Wandering');
    await page.screenshot({ path: 'test-results/96-wandering.png' });

    /*
     * The notes were drawn on the server and never sent out: what the model was
     * asked is the only place they appear, and the browser sees a prompt.
     */
    const asked = await lastRequest();
    expect(asked).toContain('drawn at random');

    await strip.getByRole('button', { name: 'Stop' }).click();
    await expect(page.getByTestId('wander-strip')).toHaveCount(0);

    /*
     * A picture opens the viewer, here as everywhere else — and the viewer is
     * over the whole conversation, so a swipe is the picture before it rather
     * than the end of a batch of one.
     */
    await page.getByRole('button', { name: /^Open picture/ }).last().click();
    await expect(page.getByTestId('viewer-image')).toBeVisible();
    await expect(page.getByText(/^\d+ \/ 2$/)).toBeVisible();
    await page.screenshot({ path: 'test-results/97-wander-viewer.png' });
    await page.getByRole('button', { name: 'Close' }).click();

    /*
     * What made it is the corner button: in a wandering round the prompt is
     * never written above the picture, so this is the only way to it.
     */
    await page.getByRole('button', { name: /What made picture/ }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('textbox', { name: 'The prompt' })).toHaveValue(
      /wandering picture/,
    );
    await page.screenshot({ path: 'test-results/97-wander-prompt.png' });
  });

  /**
   * Notes about what you like, written from the chat and read by the model.
   *
   * The feature exists for the moment the composer is empty: "give me an idea"
   * is a question nothing can answer well without knowing who is asking. What
   * is worth proving end to end is the whole path — written on the sheet,
   * encrypted on the way to disk, and back out again in the system prompt of
   * the very next message — plus the switch, which is how you change your mind
   * for an evening without deleting anything.
   */
  test('writes down what you like, and puts it in front of the model', async ({ page }) => {
    await script({ content: 'How about a wet street at night?' });

    await open(page, '/chat');
    /*
     * Next to the chat list, because it answers the same question: what now?
     * And behind the password, because what is behind it is a description of a
     * person rather than a setting.
     */
    const sheet = await openTasteSheet(page);
    await expect(sheet).toBeVisible();

    await sheet.getByLabel('Something you like').fill('low fog over water');
    await sheet.getByRole('button', { name: 'Remember it' }).click();
    await expect(sheet.getByText('low fog over water')).toBeVisible({ timeout: 30_000 });

    // A heading, and a note filed under it.
    // Pinned: it stops being a starting point and becomes a rule, so it holds
    // even for a picture that has already been described.
    await sheet.getByRole('button', { name: 'low fog over water always applies' }).click();
    await expect(
      sheet.getByRole('button', { name: 'low fog over water always applies' }),
    ).toHaveAttribute('aria-pressed', 'true');

    await sheet.getByLabel('New category').fill('Weather');
    await sheet.getByRole('button', { name: 'Add category' }).click();

    /*
     * Headings arrive folded: a page of open cards is three of them on a phone,
     * and a list long enough to be worth having is one whose shape you can see.
     */
    await sheet.getByRole('button', { name: /^Weather/ }).click();
    await sheet.getByLabel('Add to Weather').fill('bright noon sun');
    await sheet.getByRole('button', { name: 'Save to Weather' }).click();
    await expect(sheet.getByText('bright noon sun')).toBeVisible({ timeout: 30_000 });

    // Switched off is not deleted: the note stays, silenced.
    await sheet.getByRole('switch', { name: 'bright noon sun feeds in' }).click();
    await expect
      .poll(async () =>
        withTaste(async (ctx, headers) => {
          const profile = (await (await ctx.get('/api/taste', { headers })).json()) as {
            entries: { text: string; active: boolean }[];
          };
          return profile.entries.find((entry) => entry.text === 'bright noon sun')?.active;
        }),
      )
      .toBe(false);

    await sheet.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.screenshot({ path: 'test-results/91-taste-sheet.png' });

    await page.getByPlaceholder('Say something…').fill('give me an idea');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByText('How about a wet street at night?')).toBeVisible({
      timeout: 30_000,
    });

    const sent = await lastRequest();
    expect(sent).toContain('What this person likes');
    expect(sent).toContain('low fog over water');
    // Pinned, so it arrives as a rule that holds — with the limit that keeps it
    // out of prompts it has nothing to do with.
    expect(sent).toContain('Things that always hold');
    expect(sent).toContain('only where it actually bears on the picture');
    // Switched off, so it never left the database.
    expect(sent).not.toContain('bright noon sun');
  });

  /**
   * The picture in the conversation opens the viewer everything else opens.
   *
   * It is the one you are most likely to want to keep the moment you see it —
   * you have just asked for it — and a cut-down viewer here meant going to the
   * gallery to do anything with the result of the conversation you were having.
   */
  test('opens a chat picture in the gallery’s own viewer', async ({ page }) => {
    await seedWorkflow();
    await script({
      toolCall: {
        name: 'build_prompt',
        arguments: { prompt: 'a harbour at dusk', reason: 'Warm.' },
      },
    });

    await open(page, '/chat');
    await page.getByPlaceholder('Say something…').fill('build me a prompt');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 30_000 });

    await script({ content: 'There it is.' });
    await page.getByRole('dialog').getByRole('button', { name: 'Generate' }).click();

    const picture = page.getByRole('button', { name: /Open picture/ }).first();
    await expect(picture).toBeVisible({ timeout: 90_000 });
    await picture.click();

    // Every action the gallery gives a picture, on the one in the conversation.
    for (const name of ['Favourite', 'Save', 'Keep', 'Details']) {
      await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
    }
    await page.getByRole('button', { name: '4 stars' }).click();
    await expect
      .poll(async () =>
        withApi(async (ctx) => {
          const gallery = (await (await ctx.get('/api/gallery')).json()) as {
            items: { images: { rating: number }[] }[];
          };
          return gallery.items[0]?.images?.[0]?.rating ?? 0;
        }),
      )
      .toBe(4);
    await page.screenshot({ path: 'test-results/91-chat-viewer.png' });
  });

  /**
   * A question, with the answers already written.
   *
   * The tool that makes the rest of them worth having: the model stops instead
   * of guessing, and answering is one tap.
   */
  test('asks a question and carries the answer back', async ({ page }) => {
    await script(
      {
        toolCall: {
          name: 'ask_user',
          arguments: {
            question: 'Portrait or landscape?',
            options: ['Portrait', 'Landscape'],
            reason: 'It decides the composition.',
          },
        },
      },
      { content: 'Landscape it is.' },
    );

    await open(page, '/chat');
    await page.getByPlaceholder('Say something…').fill('a harbour');
    await page.getByRole('button', { name: 'Send' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByText('Portrait or landscape?')).toBeVisible();
    await expect(dialog.getByText('It decides the composition.')).toBeVisible();
    /*
     * The answer it did not think of is always available too — folded behind
     * the last chip, because it is reached for far less often than it costs in
     * height when several questions are on screen at once.
     */
    await expect(dialog.getByRole('textbox', { name: /Your own answer to/ })).toHaveCount(0);
    await dialog.getByRole('button', { name: /^Say it yourself/ }).click();
    await expect(dialog.getByRole('textbox', { name: /Your own answer to/ })).toBeVisible();
    await page.screenshot({ path: 'test-results/61-ask-user.png' });

    // Tapping picks; Send confirms. Two taps rather than one, because a call
    // can carry several questions and answering the first should not close it.
    await dialog.getByRole('button', { name: 'Landscape' }).click();
    await dialog.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText('Landscape it is.')).toBeVisible({ timeout: 30_000 });

    /*
     * The model is told the question as well as the answer.
     * "Landscape" alone says nothing about which of several questions it
     * belongs to, so the result is written back as pairs.
     */
    await expect(page.getByText('Portrait or landscape? — Landscape')).toBeVisible();
  });

  /**
   * Four questions at once, with answers long enough to be worth reading.
   *
   * Both halves of the same problem. An answer that says something useful —
   * "warm, low sun through haze" rather than "warm" — used to be cut to one
   * line with an ellipsis, so the button hid the very thing it was offering.
   * And the row it sits in was tall enough that four questions did not fit on
   * a phone, which defeats the point of asking them together.
   */
  test('fits several questions on the screen, answers unabridged', async ({ page }) => {
    const questions = [
      {
        question: 'What light?',
        options: [
          'warm, low sun through haze, long shadows across the grass',
          'flat overcast with no shadows',
        ],
      },
      { question: 'How close?', options: ['a wide shot with room around it', 'tight on the face'] },
      { question: 'What time of year?', options: ['deep winter, everything bare', 'high summer'] },
      { question: 'On film or digital?', options: ['grainy 400-speed colour film', 'clean digital'] },
    ];

    await script({
      toolCall: { name: 'ask_user', arguments: { questions, reason: 'It decides the look.' } },
    });

    await open(page, '/chat');
    await page.getByPlaceholder('Say something…').fill('a house on a hill');
    await page.getByRole('button', { name: 'Send' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 30_000 });

    // Every question is on screen, without scrolling to find the last of them.
    for (const entry of questions) {
      await expect(dialog.getByText(entry.question)).toBeInViewport();
    }
    await page.screenshot({ path: 'test-results/61-ask-user-many.png' });

    /*
     * And the long answer is shown in full: it wraps onto a second line rather
     * than being trimmed, so what the button says is what tapping it means.
     */
    const long = dialog.getByRole('button', {
      name: 'warm, low sun through haze, long shadows across the grass',
    });
    await expect(long).toHaveCSS('text-overflow', 'clip');
    const wrapped = await long.evaluate((node) => {
      const style = getComputedStyle(node);
      const lines = Math.round(
        (node.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) /
          parseFloat(style.lineHeight),
      );
      return { lines, full: node.scrollWidth <= node.clientWidth + 1 };
    });
    expect(wrapped.full).toBe(true);
    expect(wrapped.lines).toBeGreaterThan(1);
  });

  /**
   * The pace setting that is a guarantee rather than an instruction.
   *
   * Every other level is a sentence in the system prompt, which a small model
   * can talk itself out of. Off has to mean the tool is not on offer at all.
   */
  test('does not offer a tool that is switched off', async ({ page }) => {
    await withApi((ctx) =>
      ctx.patch('/api/settings', {
        data: {
          chat: {
            tools: { build_prompt: 'off', prompt_blocks: 'settled', ask_user: 'settled' },
          },
        },
      }),
    );
    await script({ content: 'Tell me more first.' });

    await open(page, '/chat');
    await page.getByPlaceholder('Say something…').fill('give me a prompt');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByText('Tell me more first.')).toBeVisible({ timeout: 30_000 });

    const offered = await lastOffer();
    expect(offered).toContain('ask_user');
    expect(offered).not.toContain('build_prompt');
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

  /**
   * Gemma 4's thought channel, which its template is supposed to keep out of
   * the visible output and in llama.cpp routinely does not.
   */
  test("folds away Gemma's thought channel too", async ({ page }) => {
    await script({
      channelThinking: 'They said calm, so muted colours.',
      content: 'How about a harbour at dawn?',
    });

    await open(page, '/chat');
    await page.getByPlaceholder('Say something…').fill('something calm');
    await page.getByRole('button', { name: 'Send' }).click();

    await expect(page.getByText('How about a harbour at dawn?')).toBeVisible({ timeout: 30_000 });
    // The channel tokens are gone from the answer, not merely hidden.
    await expect(page.getByText(/channel/)).toHaveCount(0);

    const thinking = page.getByRole('button', { name: /Thinking/ });
    await expect(thinking).toBeVisible();
    await thinking.click();
    await expect(page.getByText('They said calm, so muted colours.')).toBeVisible();
  });

  /** A reply full of asterisks is a reply that looks broken. */
  test('renders the Markdown a model writes', async ({ page }) => {
    await script({
      content:
        '## Two directions\n\nEither **a harbour** or `something quieter`.\n\n- dawn light\n- long lens',
    });

    await open(page, '/chat');
    await page.getByPlaceholder('Say something…').fill('ideas?');
    await page.getByRole('button', { name: 'Send' }).click();

    await expect(page.getByText('Two directions')).toBeVisible({ timeout: 30_000 });
    // The marks are gone and the structure is real.
    await expect(page.getByText('**')).toHaveCount(0);
    await expect(page.locator('strong, .font-semibold').getByText('a harbour')).toBeVisible();
    // Scoped: the tab bar is a list of seven too.
    await expect(page.locator('main').getByRole('listitem')).toHaveCount(2);
    await page.screenshot({ path: 'test-results/65-markdown.png' });
  });

  /**
   * Which workflow, chosen on the dialog itself.
   *
   * The same description is worth trying through the fast draft graph and the
   * slow one, and being sent to Settings between the two would be absurd.
   */
  test('picks the workflow to generate with on the dialog', async ({ page }) => {
    await seedWorkflow();
    await seedWorkflow('the other one');
    await script({
      toolCall: {
        name: 'build_prompt',
        arguments: { prompt: 'a harbour at dawn', reason: 'Calm.' },
      },
    });

    await open(page, '/chat');
    await page.getByPlaceholder('Say something…').fill('build me a prompt');
    await page.getByRole('button', { name: 'Send' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 30_000 });

    // Both are offered, and one of them is already the choice.
    const other = dialog.getByRole('button', { name: 'the other one' });
    await expect(other).toBeVisible();
    await other.click();
    await expect(other).toHaveAttribute('aria-pressed', 'true');
    await page.screenshot({ path: 'test-results/66-workflow-picker.png' });

    await dialog.getByRole('button', { name: 'Generate' }).click();

    // It ran through the workflow picked here, not the default one.
    await expect
      .poll(
        async () =>
          withApi(async (ctx) => {
            const gallery = (await (await ctx.get('/api/gallery?limit=10')).json()) as {
              items: { workflowName: string }[];
            };
            return gallery.items[0]?.workflowName ?? '';
          }),
        { timeout: 60_000 },
      )
      .toBe('the other one');
  });

  /**
   * Your own message, immediately.
   *
   * It used to appear only once the whole reply had finished, which against a
   * local model is half a minute of watching your own sentence not be there.
   */
  test('shows what you said before the reply arrives', async ({ page }) => {
    await script({ content: 'A harbour, then.' });

    await open(page, '/chat');
    // Away and back, which is when this went wrong.
    await page.getByRole('link', { name: 'Gallery' }).click();
    await expect(page.getByRole('heading', { name: 'Gallery' })).toBeVisible();
    await page.getByRole('link', { name: 'Chat' }).click();

    await page.getByPlaceholder('Say something…').fill('something calm please');
    await page.getByRole('button', { name: 'Send' }).click();

    /*
     * Scoped to the transcript on purpose: the first thing said also names the
     * conversation, so an unscoped match finds the header too.
     */
    const said = page.getByRole('paragraph').filter({ hasText: 'something calm please' });

    // There before the answer is, and still there after.
    await expect(said).toBeVisible();
    await expect(page.getByText('A harbour, then.')).toBeVisible({ timeout: 30_000 });
    await expect(said).toBeVisible();
    await page.screenshot({ path: 'test-results/67-own-message.png' });
  });

  /**
   * A prompt stays reachable for the rest of the conversation.
   *
   * Wanting the same picture with one thing changed is the commonest thing
   * there is, and the alternative was a trip to the gallery to find the result
   * and press reuse — which loses the conversation the prompt came out of.
   */
  test('runs an earlier prompt again, and can wind back to it', async ({ page }) => {
    await seedWorkflow();
    await script(
      {
        toolCall: {
          name: 'build_prompt',
          arguments: { prompt: 'a harbour at dawn', reason: 'Calm.' },
        },
      },
      { content: 'Queued that one.' },
      { content: 'Talking about something else now.' },
    );

    await open(page, '/chat');
    await page.getByPlaceholder('Say something…').fill('build me a prompt');
    await page.getByRole('button', { name: 'Send' }).click();

    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('dialog').getByRole('button', { name: 'Generate', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 30_000 });

    // Say something else, so there is a tail to wind back over.
    await page.getByPlaceholder('Say something…').fill('never mind, tell me a joke');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByText('Talking about something else now.')).toBeVisible({
      timeout: 30_000,
    });

    // The prompt is still there, as something you can press.
    const again = page.getByRole('button', { name: /a harbour at dawn/ });
    await expect(again).toBeVisible();
    await again.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('button', { name: 'Generate again' })).toBeVisible();
    await page.screenshot({ path: 'test-results/68-revisit.png' });

    await dialog.getByRole('button', { name: 'Generate again' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 30_000 });

    // Two runs of the same prompt now.
    await expect
      .poll(
        async () =>
          withApi(async (ctx) => {
            const gallery = (await (await ctx.get('/api/gallery?limit=20')).json()) as {
              items: { title: string }[];
            };
            return gallery.items.filter((item) => item.title.includes('a harbour at dawn')).length;
          }),
        { timeout: 60_000 },
      )
      .toBe(2);

    // And winding back drops everything said after it.
    await again.click();
    await page.getByRole('button', { name: /Carry on from here/ }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText('never mind, tell me a joke')).toHaveCount(0);
    await expect(again).toBeVisible();
  });

  /** A half-written sentence should survive going to look something up. */
  test('keeps what you were typing when you leave the tab', async ({ page }) => {
    await open(page, '/chat');
    await page.getByPlaceholder('Say something…').fill('a lighthouse, but');

    await page.getByRole('link', { name: 'Gallery' }).click();
    await expect(page.getByRole('heading', { name: 'Gallery' })).toBeVisible();
    await page.getByRole('link', { name: 'Chat' }).click();

    await expect(page.getByPlaceholder('Say something…')).toHaveValue('a lighthouse, but');
  });

  /**
   * The button that asks for a prompt, and queues it without asking twice.
   *
   * Its whole point is that you have finished talking and want the picture, so
   * by default there is no dialog to read.
   */
  test('builds and queues a prompt from the button', async ({ page }) => {
    await seedWorkflow();
    await script({
      toolCall: {
        name: 'build_prompt',
        arguments: { prompt: 'a harbour at dawn', reason: 'Calm.' },
      },
    });

    await open(page, '/chat');
    await pressPromptButton(page);
    // No dialog to decide: it queued.
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

    expect(new URL(page.url()).pathname).toBe('/chat');
    await expect(page.getByRole('button', { name: /Open picture/ }).first()).toBeVisible({
      timeout: 60_000,
    });
    await page.screenshot({ path: 'test-results/70-prompt-button.png' });
  });

  /** The same button, set to show its work first. */
  test('shows the prompt first when the button is set to', async ({ page }) => {
    await seedWorkflow();
    await withApi((ctx) =>
      ctx.patch('/api/settings', {
        data: { chat: { promptButton: 'dialog' } },
      }),
    );
    await script({
      toolCall: {
        name: 'build_prompt',
        arguments: { prompt: 'a lighthouse in fog', reason: 'Quiet.' },
      },
    });

    await open(page, '/chat');
    await pressPromptButton(page);

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByRole('textbox', { name: 'The prompt' })).toHaveValue(
      'a lighthouse in fog',
    );
  });

  /**
   * What changed since the last prompt, marked.
   *
   * Two paragraphs of near-identical prose are hard to compare by eye, which is
   * how you regenerate something you meant to change and do not notice.
   */
  test('marks what changed between one prompt and the next', async ({ page }) => {
    await seedWorkflow();
    /*
     * Four replies, not two: accepting a prompt asks the model for a word
     * about it, and that turn takes the next scripted reply with it.
     */
    await script(
      {
        toolCall: {
          name: 'build_prompt',
          arguments: { prompt: 'a harbour at dawn', reason: 'Calm.' },
        },
      },
      { content: 'Queued the first.' },
      {
        toolCall: {
          name: 'build_prompt',
          arguments: { prompt: 'a harbour at dusk', reason: 'Later.' },
        },
      },
      { content: 'Queued the second.' },
    );

    await open(page, '/chat');
    await pressPromptButton(page);
    await expect(page.getByRole('button', { name: /Open picture/ }).first()).toBeVisible({
      timeout: 60_000,
    });

    // Second prompt, same conversation. The button is hidden while a reply is
    // still arriving, so wait for it rather than racing it.
    await expect(page.getByText('Queued the first.')).toBeVisible({ timeout: 30_000 });
    await pressPromptButton(page);
    await expect
      .poll(
        async () =>
          withApi(async (ctx) => {
            const gallery = (await (await ctx.get('/api/gallery?limit=10')).json()) as {
              items: { title: string }[];
            };
            return gallery.items.filter((item) => item.title.includes('harbour')).length;
          }),
        { timeout: 60_000 },
      )
      .toBe(2);

    /*
     * Both pictures, not both queue entries: the panel is part of the finished
     * run, so a gallery row that exists but has no image yet still shows the
     * progress bar and nothing to open.
     */
    await expect(page.getByRole('button', { name: /Open picture/ })).toHaveCount(2, {
      timeout: 60_000,
    });

    // The prompt is under the picture, and opening it marks the change.
    const panel = page.getByRole('button', { name: 'The prompt used' }).last();
    await expect(panel).toBeVisible();
    await panel.click();
    // The word it replaced is struck through, the new one highlighted — the
    // span carries the text itself, so this reads it rather than its children.
    await expect(page.locator('.line-through').last()).toHaveText('dawn');
    await expect(page.locator('.bg-success\\/20').last()).toHaveText('dusk');
    await page.screenshot({ path: 'test-results/71-prompt-diff.png' });
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

  /**
   * The dialog covers the screen, and the answer is often behind it.
   *
   * "Is this different from the last one?" and "what did I say five messages
   * ago?" are both questions the transcript answers, and the transcript is what
   * the dialog is sitting on top of. Putting it aside has to leave the call
   * exactly where it was.
   */
  test('puts a tool call aside and brings it back', async ({ page }) => {
    await seedWorkflow();
    await withApi((ctx) =>
      ctx.patch('/api/settings', { data: { chat: { promptButton: 'dialog' } } }),
    );
    await script({
      toolCall: {
        name: 'build_prompt',
        arguments: { prompt: 'a lighthouse in fog', reason: 'Quiet.' },
      },
    });

    await open(page, '/chat');
    await pressPromptButton(page);

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('chat-transcript')).toHaveClass(/blur-sm/);

    await dialog.getByRole('button', { name: 'Put this aside' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // The conversation is readable again, not merely uncovered.
    await expect(page.getByTestId('chat-transcript')).not.toHaveClass(/blur-sm/);
    await page.screenshot({ path: 'test-results/77-tool-call-aside.png' });

    // And the way back is pinned where it cannot scroll away.
    const pill = page.getByRole('button', { name: /Proposed a prompt/ });
    await expect(pill).toBeVisible();
    await pill.click();

    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'The prompt' })).toHaveValue(
      'a lighthouse in fog',
    );
  });

  /**
   * Nothing said about a picture until there is a picture.
   *
   * The model's turn after an accepted prompt is *about* the render, and it
   * used to be asked for the moment the job was queued — so it described, and
   * often proposed changing, something that did not exist yet.
   */
  test('waits for the render before the model speaks again', async ({ page }) => {
    /*
     * Sixty steps rather than twenty, so the render lasts long enough to be
     * observed. At the default the whole thing is over in well under a second,
     * which is short enough that "replied too early" and "replied on time"
     * look the same from here.
     */
    const slow = JSON.parse(JSON.stringify(sd15Txt2Img)) as Record<
      string,
      { inputs: Record<string, unknown> }
    >;
    slow['3']!.inputs.steps = 60;
    await withApi((ctx) => ctx.post('/api/workflows', { data: { name: WORKFLOW_NAME, graph: slow } }));

    await withApi((ctx) =>
      ctx.patch('/api/settings', { data: { chat: { promptButton: 'dialog' } } }),
    );
    await script(
      {
        toolCall: {
          name: 'build_prompt',
          arguments: { prompt: 'a harbour at dawn', reason: 'Calm.' },
        },
      },
      { content: 'That one came out well.' },
    );

    await open(page, '/chat');
    await pressPromptButton(page);

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await dialog.getByRole('button', { name: 'Generate', exact: true }).click();

    // Said out loud, so the pause does not read as the chat having died.
    await expect(page.getByText(/Rendering — the reply comes once/)).toBeVisible({
      timeout: 30_000,
    });
    // And nothing from the model while that is up.
    await expect(page.getByText('That one came out well.')).toHaveCount(0);

    await expect(page.getByText('That one came out well.')).toBeVisible({ timeout: 60_000 });

    /*
     * The check that matters: by the time the reply is on screen the run it is
     * about has already finished. Before this, the reply arrived within a
     * fraction of a second of queueing, while the run was still sampling.
     */
    const status = await withApi(async (ctx) => {
      const gallery = (await (await ctx.get('/api/gallery?limit=10')).json()) as {
        items: { title: string; status: string }[];
      };
      return gallery.items.find((item) => item.title.includes('harbour'))?.status ?? '';
    });
    expect(status).toBe('completed');
  });
});

/**
 * Wave eighteen: the rough edges around the chat and the gallery.
 *
 * Three of these are bugs with a shape worth keeping a test for — a choice you
 * could not undo, a button one row too tall, and a preview you could not put
 * away — and one is a setting whose whole point is that it is remembered.
 */
test.describe('the eighteenth wave', () => {
  test.beforeEach(async () => {
    await resetState();
  });

  /** Generate and wait for this prompt's own pictures, not the gallery's. */
  async function generateBatch(page: Page, prompt: string) {
    await seedWorkflow();
    await open(page, '/');
    await page.getByPlaceholder('Describe the image…').fill(prompt);
    await page.getByRole('button', { name: /^Generate/ }).click();
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
      .toBeGreaterThanOrEqual(1);
  }

  /**
   * A value chosen under one workflow, and then the workflow changed.
   *
   * The choice stayed switched on but stopped appearing in the list, because
   * the list is built from what the runs in view actually recorded — so there
   * was no way left to turn it off from the place it was turned on.
   */
  test('lets you unpick a value the runs no longer record', async ({ page }) => {
    await generateBatch(page, 'orphan check');

    // Chosen while a different workflow was in use, which is what the app sees
    // on the next visit: a key nothing in the gallery describes.
    await page.evaluate(() => {
      localStorage.setItem(
        'latent.grid',
        JSON.stringify({ gridParams: ['9.something_else'], overlayLabels: true }),
      );
    });

    await open(page, '/gallery');
    await dismissResult(page);

    const picker = page.getByRole('button', { name: 'Values on thumbnails' });
    await expect(picker).toContainText('1');
    await picker.click();

    const orphan = page.getByRole('button', { name: 'something_else' });
    await expect(orphan).toBeVisible();
    await expect(orphan).toHaveAttribute('aria-pressed', 'true');
    await page.screenshot({ path: 'test-results/62-orphan-value.png' });

    // Unpicked, it stops being listed at all — it was only there because it was
    // switched on, which is the whole point of listing it.
    await orphan.click();
    await expect(orphan).toHaveCount(0);
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(picker).not.toContainText('1');
  });

  /**
   * The picker sat among the viewer's other buttons and was a row taller than
   * all of them, which pushed the whole bar up over the picture.
   */
  test('keeps the values button the same height as the buttons beside it', async ({ page }) => {
    await generateBatch(page, 'height check');
    await open(page, '/gallery');
    await dismissResult(page);

    await page.locator('img[alt*="height check"]').first().click();

    const details = await page.getByRole('button', { name: 'Details' }).boundingBox();
    const values = await page.getByRole('button', { name: 'Values on the picture' }).boundingBox();
    expect(details).not.toBeNull();
    expect(values).not.toBeNull();
    expect(Math.round(values!.height)).toBe(Math.round(details!.height));
    await page.screenshot({ path: 'test-results/63-viewer-bar.png' });
  });

  /**
   * The same words through a different graph.
   *
   * Doing it by hand meant selecting a paragraph on a phone, copying it,
   * switching workflow and pasting — four operations, one of which the software
   * should simply not require.
   */
  test('sends the prompt to another workflow without copying it', async ({ page }) => {
    await seedWorkflow();
    await seedWorkflow('the other one');
    await open(page, '/');

    const picker = page.getByRole('button', { name: 'Choose workflow' });

    // Set something up in the second workflow, so we can see it survives.
    await picker.click();
    await page.getByRole('button', { name: 'the other one' }).click();
    await page.getByPlaceholder('Describe the image…').fill('whatever was here');

    // Back to the first, and send its prompt across.
    await picker.click();
    await page.getByRole('button', { name: WORKFLOW_NAME }).click();
    await page.getByPlaceholder('Describe the image…').fill('a harbour at dawn');

    await page.getByRole('button', { name: 'Send to…' }).click();
    await expect(page.getByRole('heading', { name: 'Send the prompt to' })).toBeVisible();
    await page.getByRole('button', { name: 'the other one' }).click();

    // That workflow is open, with the prompt carried over.
    await expect(picker).toContainText('the other one');
    await expect(page.getByPlaceholder('Describe the image…')).toHaveValue('a harbour at dawn');
    await page.screenshot({ path: 'test-results/69-send-to-workflow.png' });
  });

  /**
   * Folding the input image away, and it staying folded.
   *
   * The preview is the whole picture at thumbnail size on the screen you look
   * at with other people around; the point of the fold is that it is not there
   * until you ask for it, including after a reload.
   */
  test('folds the image input away and remembers it', async ({ page }) => {
    // The img2img fixture, because it is the one with an image input.
    await withApi((ctx) =>
      ctx.post('/api/workflows', { data: { name: 'img2img', graph: img2img } }),
    );
    await open(page, '/');

    const fold = page.getByTestId('image-fold').first();
    await expect(fold).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('button', { name: 'From folder' })).toBeVisible();

    await fold.click();
    await expect(page.getByRole('button', { name: 'From folder' })).toBeHidden();

    await page.reload();
    await signIn(page);
    await expect(page.getByTestId('image-fold').first()).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await page.screenshot({ path: 'test-results/64-folded-input.png' });
  });
});

/**
 * Wave 23: the gallery gets an order and a shape, the bar stops moving, and
 * the model server gets a password.
 */
test.describe('the twenty-third wave', () => {
  test.beforeEach(async () => {
    await resetState();
    await seedWorkflow();
  });

  /** Generate one picture and wait for it to land. */
  async function makePicture(page: Page, prompt: string, expected: number) {
    await open(page, '/');
    await page.getByPlaceholder('Describe the image…').fill(prompt);
    await page.getByRole('button', { name: /^Generate/ }).click();
    await expect
      .poll(
        async () =>
          withApi(async (ctx) => {
            const gallery = (await (await ctx.get('/api/gallery?limit=50')).json()) as {
              items: { images: unknown[] }[];
            };
            return gallery.items.reduce((total, item) => total + item.images.length, 0);
          }),
        { timeout: 40_000 },
      )
      .toBeGreaterThanOrEqual(expected);
    await dismissResult(page);
  }

  /**
   * Move every run that exists back a day.
   *
   * There is no API for "pretend this happened yesterday", and there should not
   * be — but without one there is only ever a single day and nothing to divide.
   * Straight into the same database the server is reading, which SQLite is
   * happy to allow.
   */
  async function backdateEverything(days: number) {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(join('data/e2e', 'latent.db'));
    try {
      db.prepare('UPDATE generations SET created_at = created_at - ?').run(days * 86_400_000);
    } finally {
      db.close();
    }
  }

  /*
   * The rule above the tab bar.
   *
   * Asserted by measurement rather than by reading the class list, because the
   * complaint was about a line appearing on screen and a class name is not
   * that. Anything that puts a border back — here or on a wrapper — fails.
   */
  test('draws no line across the bottom of the screen', async ({ page }) => {
    await open(page, '/gallery');

    const borders = await page.evaluate(() => {
      const found: string[] = [];
      const bottom = window.innerHeight / 2;
      for (const element of document.querySelectorAll<HTMLElement>('*')) {
        const box = element.getBoundingClientRect();
        if (box.top < bottom || box.width < window.innerWidth * 0.8) continue;
        const style = getComputedStyle(element);
        const width = Number.parseFloat(style.borderTopWidth);
        if (width > 0 && style.borderTopStyle !== 'none') {
          found.push(`${element.tagName}.${element.className} ${style.borderTopWidth}`);
        }
      }
      return found;
    });

    expect(borders).toEqual([]);
  });

  /**
   * Nothing pressable off the side of the screen.
   *
   * The gallery's toolbar grew a control at a time until the last two — the
   * blur and the grid layout — sat past the right-hand edge, where a phone
   * simply cannot reach them: the bar does not scroll, so they were not hidden,
   * they were gone. Measured across every screen rather than asserted on the
   * one that broke, because the way this happens is a control added to a row
   * that already fitted.
   */
  /**
   * The blur is the last button in every top row.
   *
   * It is the one control here reached for without looking — somebody has just
   * sat down beside you — and a button that is third from the right on one
   * screen and last on another is a button you have to find first.
   */
  test('keeps the blur in the same corner on every screen', async ({ page }) => {
    for (const route of ['/gallery', '/chat']) {
      await open(page, route);
      const blur = page.getByRole('button', { name: 'Blur every image' });
      await expect(blur).toBeVisible();

      const box = (await blur.boundingBox())!;
      const others = await page
        .locator('header, .safe-t')
        .first()
        .getByRole('button')
        .all();

      for (const other of others) {
        const at = await other.boundingBox();
        // Same row, and nothing to the right of it.
        if (!at || Math.abs(at.y - box.y) > 8) continue;
        expect(at.x, `a button right of the blur on ${route}`).toBeLessThanOrEqual(box.x + 1);
      }
    }
  });

  test('keeps every control on the screen', async ({ page }) => {
    for (const route of ['/gallery', '/favorites', '/queue', '/generate', '/chat', '/settings']) {
      await open(page, route);
      // The bar renders with the screen; the pictures under it can take longer.
      await expect(page.locator('nav').first()).toBeVisible();

      const escaped = await page.evaluate(() => {
        const width = window.innerWidth;
        return Array.from(document.querySelectorAll<HTMLElement>('button, a, input'))
          .filter((node) => {
            const box = node.getBoundingClientRect();
            if (box.width === 0 && box.height === 0) return false;
            // Half a pixel of slack for sub-pixel layout, and only horizontally:
            // a long screen scrolls, a wide one is broken.
            return box.right > width + 0.5 || box.left < -0.5;
          })
          .map((node) => `${node.getAttribute('aria-label') ?? node.textContent?.trim() ?? ''}`);
      });

      expect(escaped, `controls off the side of ${route}`).toEqual([]);
    }
  });

  /*
   * The drag that took the whole interface with it.
   *
   * A touch drag beginning on the tab bar was handed to the document, which
   * scrolled the app up and left a band of background where it had been. All
   * three conditions that allowed it are asserted, because the gesture itself
   * cannot be: a mouse drag never scrolls a page, so driving one here would
   * pass whether the fix were present or not.
   */
  test('cannot be dragged away by the tab bar', async ({ page }) => {
    await open(page, '/gallery');

    // The bar is not a scrollable surface, so a drag starting on it is not a
    // scroll — which is what stopped the document being handed the gesture.
    await expect(page.locator('nav').first()).toHaveCSS('touch-action', 'none');

    for (const selector of ['html', 'body']) {
      const element = page.locator(selector);
      await expect(element).toHaveCSS('overscroll-behavior-y', 'none');

      /*
       * And there is nothing for it to scroll even if it were handed one.
       * `clip` rather than `hidden` on purpose: `hidden` would make these
       * scroll containers, which silently breaks every sticky header in the
       * app — so the overflow value is asserted too, not just the outcome.
       */
      await expect(element).toHaveCSS('overflow-y', 'clip');
      const scrollable = await element.evaluate(
        (node) => node.scrollHeight > node.clientHeight + 1,
      );
      expect(scrollable).toBe(false);
    }
  });

  test('cuts the gallery into days you can fold away', async ({ page }) => {
    await makePicture(page, 'a lighthouse in fog', 1);
    await backdateEverything(1);
    await makePicture(page, 'a lighthouse at noon', 2);

    await open(page, '/gallery');

    // Two days, most recent first, each counting its own pictures.
    const dividers = page.getByTestId('day-divider');
    await expect(dividers).toHaveCount(2);
    await expect(dividers.nth(0)).toHaveAttribute('aria-label', 'Today, 1 pictures');
    await expect(dividers.nth(1)).toHaveAttribute('aria-label', 'Yesterday, 1 pictures');

    const today = page.locator('img[alt*="at noon"]');
    const yesterday = page.locator('img[alt*="in fog"]');
    await expect(today.first()).toBeVisible();
    await expect(yesterday.first()).toBeVisible();
    await page.screenshot({ path: 'test-results/65-gallery-days.png' });

    // Tapping the divider folds that day away, and only that day.
    await dividers.nth(0).click();
    await expect(dividers.nth(0)).toHaveAttribute('aria-expanded', 'false');
    await expect(today).toHaveCount(0);
    await expect(yesterday.first()).toBeVisible();

    // And it stays folded across a reload — the point of remembering it.
    await open(page, '/gallery');
    await expect(page.getByTestId('day-divider').nth(0)).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('img[alt*="at noon"]')).toHaveCount(0);

    // Tapping again brings it back.
    await page.getByTestId('day-divider').nth(0).click();
    await expect(page.locator('img[alt*="at noon"]').first()).toBeVisible();
  });

  test('sorts the gallery, and drops the day headings when the order crosses them', async ({
    page,
  }) => {
    await makePicture(page, 'the older one', 1);
    await backdateEverything(1);
    await makePicture(page, 'the newer one', 2);

    await open(page, '/gallery');
    await expect(page.getByTestId('day-divider').nth(0)).toHaveAttribute(
      'aria-label',
      /^Today/,
    );

    await page.getByRole('button', { name: 'Sort and filter' }).click();
    await page.getByRole('button', { name: /Oldest first/ }).click();
    await page.getByRole('button', { name: 'Done' }).click();

    // Same two days, the other way up.
    await expect(page.getByTestId('day-divider').nth(0)).toHaveAttribute(
      'aria-label',
      /^Yesterday/,
    );
    await expect(page.locator('img[alt*="older one"]').first()).toBeVisible();

    /*
     * Sorting by rating deliberately mixes days, so heading the list with
     * dates would be a lie about what you are looking at.
     */
    await page.getByRole('button', { name: 'Sort and filter' }).click();
    await page.getByRole('button', { name: /Best rated/ }).click();
    await page.getByRole('button', { name: 'Done' }).click();

    await expect(page.getByTestId('day-divider')).toHaveCount(0);
    await expect(page.locator('img[alt*="one"]').first()).toBeVisible();
    await page.screenshot({ path: 'test-results/66-gallery-sorted.png' });
  });

});


/**
 * Wave 24: the parameter study module.
 *
 * The sampler and the statistics are unit-tested, and the server half is
 * covered end to end against a real ComfyUI. What is left for the browser is
 * the shape of the two phases — that setting one up is possible with a thumb,
 * that a tap on a third of the picture is a rating, and that the pictures stay
 * out of the gallery.
 */
test.describe('parameter studies', () => {
  test.beforeEach(async () => {
    await resetState();
    await seedWorkflow();
    await withApi(async (ctx) => {
      const workflows = (await (await ctx.get('/api/workflows')).json()) as { id: string }[];
      for (const workflow of workflows) {
        await ctx.patch(`/api/workflows/${workflow.id}`, { data: { visible: true } });
      }
    });
  });

  /** Set a study up, run it, and rate what it made — the whole loop by thumb. */
  test('varies a parameter, renders it, and rates by tapping the picture', async ({ page }) => {
    await open(page, '/');
    await openModule(page, 'Study');

    await page.getByRole('button', { name: 'New' }).click();
    await page.getByRole('button', { name: WORKFLOW_NAME }).click();

    // Four pictures is enough to have something to rate and quick to render.
    const count = page.getByLabel('How many pictures');
    await expect(count).toBeVisible();
    await count.fill('4');
    await count.blur();

    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('button', { name: /Steps/ }).first().click();

    // The levels are spelled out, because a range plus a count is not obvious.
    await expect(page.getByText(/^\d+ values?$/)).toBeVisible();
    await page.screenshot({ path: 'test-results/68-study-setup.png' });

    await page.getByRole('button', { name: 'Start rendering' }).click();

    /*
     * Straight to the rating zones.
     *
     * Deliberately not asserting the progress figure on the way past: four
     * shots against the mock render in under a second, and the study turns
     * itself over to its rating phase the moment the last one lands — so any
     * assertion about a partly-rendered study is a race with the thing working
     * properly.
     */
    const good = page.getByTestId('rate-3');
    await expect(good).toBeVisible({ timeout: 60_000 });
    await page.screenshot({ path: 'test-results/69-study-rating.png' });

    /*
     * Three zones on the picture, and the verdicts are mixed so the analysis
     * has something other than one value to work with. Looping until the
     * "everything is rated" state rather than a fixed four times, because a
     * shot that failed to render is not offered.
     */
    const zones = ['rate-3', 'rate-1', 'rate-2', 'rate-3'];
    for (const zone of zones) {
      if (await page.getByText('Everything is rated').isVisible().catch(() => false)) break;
      await page.getByTestId(zone).click();
      await page.waitForTimeout(500);
    }

    await expect(page.getByText('Everything is rated')).toBeVisible({ timeout: 20_000 });

    // And the analysis is underneath, naming the parameter that was varied.
    await expect(page.getByText(/^\d+ rated$/)).toBeVisible();
    await expect(page.getByText('Steps').first()).toBeVisible();
    await page.screenshot({ path: 'test-results/70-study-results.png' });
  });

  /**
   * The reason study output is marked at all: a study is hundreds of frames
   * that differ by one setting, and the gallery is not where those belong.
   */
  test('keeps its pictures out of the gallery, until one is kept', async ({ page }) => {
    const studyId = await withApi(async (ctx) => {
      const workflows = (await (await ctx.get('/api/workflows')).json()) as { id: string }[];
      const workflow = workflows[0] as { id: string };

      const study = (await (
        await ctx.post('/api/studies', {
          data: { name: 'hidden output', workflowId: workflow.id },
        })
      ).json()) as { id: string };

      await ctx.patch(`/api/studies/${study.id}`, {
        data: {
          shotCount: 2,
          factors: [
            {
              kind: 'numeric',
              key: '3.steps',
              label: 'Steps',
              min: 2,
              max: 3,
              quantise: { mode: 'interval', step: 1 },
              distribution: 'uniform',
              integer: true,
              cost: 0,
            },
          ],
        },
      });
      await ctx.post(`/api/studies/${study.id}/start`);
      return study.id;
    });

    // Wait for both to land.
    await expect
      .poll(
        async () =>
          withApi(async (ctx) => {
            const detail = (await (await ctx.get(`/api/studies/${studyId}`)).json()) as {
              rendered: number;
            };
            return detail.rendered;
          }),
        { timeout: 60_000 },
      )
      .toBe(2);

    /*
     * The gallery shows none of them — asserted as "no pictures at all", which
     * is what the claim actually is, rather than by matching the wording of an
     * empty state that is free to change.
     */
    await open(page, '/gallery');
    await expect(page.getByText('Nothing generated yet')).toBeVisible();
    await expect(page.locator('img')).toHaveCount(0);

    // Keep one, and it appears — as an ordinary picture with a favourite.
    await open(page, '/');
    await openModule(page, 'Study');
    await page.getByTestId('study-row').first().click();

    const keep = page.getByRole('button', { name: 'Keep' });
    await expect(keep).toBeVisible({ timeout: 20_000 });
    await keep.click();
    await expect(page.getByRole('button', { name: 'Kept' })).toBeVisible();

    await open(page, '/gallery');
    await expect(page.locator('img').first()).toBeVisible({ timeout: 20_000 });

    await open(page, '/favorites');
    await expect(page.locator('img').first()).toBeVisible({ timeout: 20_000 });

    /*
     * The note saying where it came from is asserted through the API rather
     * than on screen: the favourites list is in thumbnail mode by default, and
     * that mode deliberately shows the picture and nothing else.
     */
    const notes = await withApi(async (ctx) => {
      const favorites = (await (await ctx.get('/api/favorites')).json()) as {
        note: string | null;
      }[];
      return favorites.map((favorite) => favorite.note ?? '');
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('From the study');
  });
});

/**
 * Wave 24: which workflows get read, and how the list is arranged.
 */
test.describe('workflow folders', () => {
  test('groups workflows by their leading name segment', async ({ page }) => {
    await resetState();
    await withApi(async (ctx) => {
      // Two sharing a prefix become a folder; the lone one stays flat.
      for (const name of ['SDXL_fast', 'SDXL_detail', 'standalone']) {
        const created = (await (
          await ctx.post('/api/workflows', { data: { name, graph: sd15Txt2Img } })
        ).json()) as { id: string };
        // Switched off, which is the state a scanned installation arrives in
        // and the one the folders exist to make navigable.
        await ctx.patch(`/api/workflows/${created.id}`, { data: { visible: false } });
      }
    });

    await open(page, '/settings');

    /*
     * Scoped to the workflow list. The names appear again further down the
     * screen in the gallery-shortcut pickers, and an unscoped match would find
     * those and never notice the folder was shut.
     */
    const list = page.getByTestId('workflow-list');
    const folder = list.getByTestId('workflow-folder');
    await expect(folder).toHaveCount(1);
    await expect(folder).toContainText('SDXL');

    // Shut, because nothing inside it is switched on.
    await expect(folder).toHaveAttribute('aria-expanded', 'false');
    await expect(list.getByText('SDXL_fast')).toHaveCount(0);

    await folder.click();
    await expect(list.getByText('SDXL_fast')).toBeVisible();

    // The one that is not part of a pair is not put in a folder of its own.
    await expect(list.getByText('standalone')).toBeVisible();
    await page.screenshot({ path: 'test-results/71-workflow-folders.png' });
  });

  /** The prefix, and the fact that it is dropped from what you see. */
  test('reads only prefixed workflows and hides the prefix', async ({ page }) => {
    await resetState();
    await open(page, '/settings');

    const prefix = page.getByLabel('Workflow name prefix');
    await expect(prefix).toBeVisible();
    await expect(prefix).toHaveValue('API_');
  });
});

/**
 * Wave 25: one list of servers, one collection of instructions.
 *
 * Three changes with one idea behind them — things that were scattered are
 * collected: both kinds of server into one section with one dialog, every
 * system prompt into a list of its own, and the chat's own state out of the
 * screen that happens to be showing it.
 */
test.describe('the twenty-fifth wave', () => {
  test.beforeEach(async () => {
    await resetState();
  });

  /** Both kinds of server sit in one section and share one dialog. */
  test('adds a model server through the same dialog as ComfyUI', async ({ page }) => {
    await open(page, '/settings');

    const connections = page.getByRole('heading', { name: 'Connections' });
    await expect(connections).toBeVisible();

    // One section, both kinds listed under it.
    const section = page.locator('section', { has: connections });
    await expect(section).toContainText('ComfyUI');
    await expect(section).toContainText('Model server');

    await section.getByRole('button', { name: 'Add a Model server connection' }).click();
    const sheet = page.getByRole('dialog');
    await expect(sheet).toBeVisible();

    // The kind is pre-chosen from the button that opened it, and the rest of
    // the form is the one ComfyUI uses.
    await expect(
      sheet.getByRole('button', { name: 'Model server', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await sheet.getByPlaceholder('Rented GPU').fill('Downstairs box');
    await sheet.getByPlaceholder('http://127.0.0.1:8080').fill('http://127.0.0.1:8189');
    await sheet.getByRole('button', { name: 'None', exact: true }).click();
    await sheet.getByRole('button', { name: 'Save' }).click();
    await expect(sheet).toHaveCount(0);

    // Added, in use, and it has not stood ComfyUI down.
    const stored = await withApi(async (ctx) =>
      (await (await ctx.get('/api/connections')).json()) as {
        kind: string;
        name: string;
        isActive: boolean;
      }[],
    );
    expect(stored.find((entry) => entry.name === 'Downstairs box')?.isActive).toBe(true);
    expect(stored.some((entry) => entry.kind === 'comfy' && entry.isActive)).toBe(true);
    await page.screenshot({ path: 'test-results/72-connections.png' });
  });

  /**
   * The point of collecting the prompts: a workflow's text field is filled from
   * the library rather than carrying its own copy of the wording.
   */
  test('fills a workflow’s text field from the prompt named after it', async ({ page }) => {
    // The negative prompt node, titled after the prompt we are about to write.
    const graph = JSON.parse(JSON.stringify(sd15Txt2Img)) as Record<string, unknown>;
    (graph['7'] as { _meta?: unknown })._meta = { title: 'House rules' };
    await withApi((ctx) =>
      ctx.post('/api/workflows', { data: { name: 'Named field', graph } }),
    );

    await open(page, '/settings');
    const prompts = page.locator('section', {
      has: page.getByRole('heading', { name: 'System prompts' }),
    });
    await prompts.getByRole('button', { name: 'Add' }).click();

    const sheet = page.getByRole('dialog');
    await sheet.getByLabel('Prompt name').fill('House rules');
    await sheet.getByLabel('Prompt text').fill('no text, no watermark, no signature');
    await sheet.getByRole('button', { name: 'Save' }).click();
    await expect(sheet).toHaveCount(0);
    await expect(prompts).toContainText('no text, no watermark');
    await page.screenshot({ path: 'test-results/73-system-prompts.png' });

    // The form says where that field's text comes from rather than offering a
    // box whose contents would be replaced on the way out.
    await open(page, '/');
    await expect(page.getByText('from the system prompt “House rules”')).toBeVisible();

    await page.getByPlaceholder('Describe the image…').fill('prompt library check');
    await page.getByRole('button', { name: /^Generate/ }).click();

    // What was actually submitted, which is where the substitution happens.
    await expect
      .poll(
        async () =>
          withApi(async (ctx) => {
            const gallery = (await (await ctx.get('/api/gallery?limit=20')).json()) as {
              items: { title: string; values: Record<string, unknown> }[];
            };
            return gallery.items.find((item) => item.title === 'prompt library check')?.values[
              '7.text'
            ];
          }),
        { timeout: 60_000 },
      )
      .toBe('no text, no watermark, no signature');
  });

  /**
   * The instability this wave was mostly about.
   *
   * Leaving the chat used to abort the reply in flight and destroy everything
   * the screen was holding — the transcript, a half-typed message, a tool
   * dialog waiting on a decision. Coming back then re-opened the conversation
   * from scratch and raced whatever was left, which is how messages went
   * missing. The conversation lives outside the screen now, so this is a
   * render rather than a reload.
   */
  test('keeps the conversation and the reply while another tab is visited', async ({ page }) => {
    const llama = await apiRequest.newContext({ baseURL: 'http://127.0.0.1:8189' });
    try {
      await withApi(async (ctx) => {
        const created = await ctx.post('/api/connections', {
          data: { kind: 'llama', name: 'Mock model server', url: 'http://127.0.0.1:8189' },
        });
        const connection = (await created.json()) as { id: string };
        await ctx.post(`/api/connections/${connection.id}/activate`);
      });
      await llama.post('/__script', { data: [{ content: 'A harbour at dawn, then.' }] });

      await open(page, '/chat');
      await page.getByPlaceholder('Say something…').fill('something calm');
      await page.getByRole('button', { name: 'Send' }).click();
      await expect(page.getByText('A harbour at dawn, then.')).toBeVisible({ timeout: 30_000 });

      // A half-typed message survives the trip too — it is state about the
      // conversation, not about the screen.
      await page.getByPlaceholder('Say something…').fill('and maybe a lighthouse');

      await page.getByRole('link', { name: 'Gallery' }).click();
      await expect(page.getByPlaceholder('Say something…')).toHaveCount(0);
      await page.getByRole('link', { name: 'Chat' }).click();

      await expect(page.getByText('A harbour at dawn, then.')).toBeVisible();
      // The paragraph in the transcript, not the heading the title also became.
      await expect(
        page.getByRole('paragraph').filter({ hasText: 'something calm' }),
      ).toBeVisible();
      await expect(page.getByPlaceholder('Say something…')).toHaveValue(
        'and maybe a lighthouse',
      );
      await page.screenshot({ path: 'test-results/74-chat-return.png' });
    } finally {
      await llama.dispose();
    }
  });

  /**
   * The workflows reach the same model server the chat does.
   *
   * The address is a widget on the node, so it lives inside the workflow — and
   * a rented box gets a new one every time it is started. The form says where
   * the value is coming from rather than offering a box about to be replaced.
   */
  test('shows a llama-server node’s address as the connection’s', async ({ page }) => {
    await withApi(async (ctx) => {
      await ctx.post('/api/workflows', {
        data: { name: 'Asks a llama-server', graph: withLlamaServer },
      });
      const created = await ctx.post('/api/connections', {
        data: {
          kind: 'llama',
          name: 'Rented model server',
          url: 'http://127.0.0.1:8189',
        },
      });
      const connection = (await created.json()) as { id: string };
      await ctx.post(`/api/connections/${connection.id}/activate`);
    });

    await open(page, '/');
    await page.getByRole('button', { name: 'Advanced' }).click();

    // All five widgets that describe how to reach the server, not just one.
    const marked = page.getByText('from the model server “Rented model server”');
    await expect(marked.first()).toBeVisible();
    await expect(marked).toHaveCount(5);
    await expect(page.getByText('http://127.0.0.1:8189').first()).toBeVisible();
    await page.screenshot({ path: 'test-results/75-model-server-field.png' });
  });

  /**
   * The preset-chat node's form, which its own values decide.
   *
   * `/object_info` says `Preset 1…6`; the graph says what they were renamed to,
   * and `slot_count` says how many of them exist. A form built from the
   * definition alone offers a dropdown of names nobody uses and twelve text
   * boxes for six prompts that are not there.
   */
  test('names the preset-chat slots and hides the ones not in use', async ({ page }) => {
    await withApi(async (ctx) => {
      await ctx.post('/api/workflows', {
        data: { name: 'Preset chat', graph: withPresetChat },
      });
    });

    await open(page, '/');
    await page.getByRole('button', { name: 'Advanced' }).click();

    // Each system prompt is headed by its own slot's name.
    await expect(page.getByText('Caption', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Rewrite', { exact: true }).first()).toBeVisible();
    // Three of six slots are in use, so the rest are not on screen at all.
    await expect(page.getByText('System 4', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Name 5', { exact: true })).toHaveCount(0);
    await page.screenshot({ path: 'test-results/76-preset-chat-slots.png' });

    // And the picker offers those same names rather than the declared ones.
    await page.getByRole('button', { name: /^Active/ }).click();
    await expect(page.getByRole('button', { name: 'passthrough', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Rewrite', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Preset 3', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Preset 4', exact: true })).toHaveCount(0);
  });
});

/**
 * The result sheet, and when it is allowed to take the screen.
 *
 * Presenting the picture unasked was right for the case it was written for —
 * watching a render finish — and wrong for the one that actually happens more:
 * you queue something and carry straight on typing the next prompt, and a sheet
 * lands over the keyboard for a picture you were not waiting to look at.
 */
test.describe('the twenty-sixth wave', () => {
  test.beforeEach(async () => {
    await resetState();
    await seedWorkflow();
  });

  test('leaves a finished picture in the bar while you are doing something else', async ({
    page,
  }) => {
    await open(page, '/');
    await page.getByPlaceholder('Describe the image…').fill('quiet result');
    await page.getByRole('button', { name: /^Generate/ }).click();

    // The bar says so, and nothing has covered the form.
    const bar = page.getByRole('button', { name: 'Show the finished picture' });
    await expect(bar).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('button', { name: 'Dismiss' })).toHaveCount(0);
    // Still where you were, with what you typed.
    await expect(page.getByPlaceholder('Describe the image…')).toHaveValue('quiet result');
    await page.screenshot({ path: 'test-results/78-quiet-result.png' });

    /*
     * And the row it shares with Generate still fits on the screen.
     *
     * The bar used to render its full-width shape here — the one meant to span
     * the app above the tab bar — next to a Generate button also asking for the
     * whole row, plus the endless switch. The three together overflowed, and the
     * footer clips what overflows, so the buttons went under the edge.
     */
    const generate = page.getByRole('button', { name: /^Generate/ });
    const endless = page.getByRole('button', { name: 'Endless generation' });
    const [barBox, buttonBox, endlessBox] = await Promise.all([
      bar.boundingBox(),
      generate.boundingBox(),
      endless.boundingBox(),
    ]);
    const viewport = page.viewportSize()!;

    // One row: same top, in order, nothing past the right edge.
    expect(Math.abs(barBox!.y - buttonBox!.y)).toBeLessThan(4);
    expect(Math.abs(barBox!.y - endlessBox!.y)).toBeLessThan(4);
    expect(barBox!.x + barBox!.width).toBeLessThanOrEqual(buttonBox!.x + 1);
    expect(buttonBox!.x + buttonBox!.width).toBeLessThanOrEqual(endlessBox!.x + 1);
    expect(endlessBox!.x + endlessBox!.width).toBeLessThanOrEqual(viewport.width);

    // It still queues, which is the whole point of it being reachable.
    await generate.click();
    await expect(page.getByRole('button', { name: /Queued|Generate/ })).toBeVisible();

    // And the picture is one tap away rather than gone.
    await bar.click();
    await expect(page.getByRole('button', { name: 'Dismiss' })).toBeVisible();
  });

  /**
   * Opening a picture fetches what this screen can show, not the original.
   *
   * On a recent workflow that is the difference between a moment and several
   * seconds — and between two megapixels of bitmap in the browser and sixteen,
   * while it is probably also rendering the next one.
   */
  test('opens a picture at the size of the screen, not the file', async ({ page }) => {
    await open(page, '/');
    await page.getByPlaceholder('Describe the image…').fill('a big one');
    await page.getByRole('button', { name: /^Generate/ }).click();
    await page.getByRole('link', { name: 'Gallery' }).click();

    const requested: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/view')) requested.push(request.url());
    });

    await page.locator('main img').first().click({ timeout: 60_000 });
    const viewer = page.getByTestId('viewer-image');
    await expect(viewer).toBeVisible();

    /*
     * The whole point, stated as a request: the viewer names a box and never
     * asks for the file. A `/api/view` with no `fit` is the old behaviour —
     * twenty megabytes for a screen that can show two — and there must not be
     * one, which is why this asserts on the absence rather than on a pixel
     * count. The mock renders 512², under this phone's 1170-pixel box, and the
     * server refuses to enlarge, so the size that comes back proves nothing.
     */
    await expect
      .poll(() => requested.filter((url) => url.includes('fit=')).length)
      .toBeGreaterThan(0);
    expect(requested.filter((url) => !url.includes('fit=') && !url.includes('preview='))).toEqual(
      [],
    );

    const viewport = page.viewportSize()!;
    const ratio = await page.evaluate(() => window.devicePixelRatio);
    const box = requested.find((url) => url.includes('fit='))!;
    expect(new URL(box).searchParams.get('fit')).toBe(
      `${Math.round(viewport.width * ratio)}x${Math.round(viewport.height * ratio)}`,
    );

    const decoded = await viewer.evaluate((image: HTMLImageElement) => ({
      width: image.naturalWidth,
      height: image.naturalHeight,
    }));
    expect(decoded.width).toBeLessThanOrEqual(Math.round(viewport.width * ratio));
    expect(decoded.height).toBeLessThanOrEqual(Math.round(viewport.height * ratio));
    await page.screenshot({ path: 'test-results/80-view-sized.png' });

    // Half the screen's resolution is half the box, and still a box.
    await page.getByRole('button', { name: 'Close' }).click();
    await page.getByRole('button', { name: 'Grid layout' }).click();
    await page.getByRole('radio', { name: '0.5×' }).click();
    await page.keyboard.press('Escape');

    requested.length = 0;
    await page.locator('main img').first().click();
    await expect(page.getByTestId('viewer-image')).toBeVisible();
    await expect.poll(() => requested.filter((url) => url.includes('fit=')).length).toBeGreaterThan(0);
    const halved = new URL(requested.find((url) => url.includes('fit='))!).searchParams.get('fit')!;
    expect(halved).toBe(
      `${Math.round((viewport.width * ratio) / 2)}x${Math.round((viewport.height * ratio) / 2)}`,
    );

    // And the last step is the way back to the file itself: no box at all.
    await page.getByRole('button', { name: 'Close' }).click();
    await page.getByRole('button', { name: 'Grid layout' }).click();
    await page.getByRole('radio', { name: 'The file' }).click();
    await page.keyboard.press('Escape');

    requested.length = 0;
    await page.locator('main img').first().click();
    await expect(page.getByTestId('viewer-image')).toBeVisible();
    await expect
      .poll(() => requested.filter((url) => !url.includes('fit=') && !url.includes('preview=')).length)
      .toBeGreaterThan(0);
  });

  test('fetches the zoomed-in part at the screen’s resolution too', async ({ page }) => {
    /*
     * A picture with more pixels than this screen, which is the only case where
     * a crop can add anything. The mock renders the size its latent asks for,
     * and 2048² against a 1170-pixel box leaves plenty to zoom into — at the
     * default 512 the server would refuse to enlarge and the viewer would
     * correctly decide a crop was pointless.
     */
    const big = JSON.parse(JSON.stringify(sd15Txt2Img)) as Record<
      string,
      { inputs: Record<string, unknown> }
    >;
    big['5']!.inputs.width = 2048;
    big['5']!.inputs.height = 2048;
    await withApi((ctx) =>
      ctx.post('/api/workflows', { data: { name: WORKFLOW_NAME, graph: big } }),
    );

    await open(page, '/');
    await page.getByPlaceholder('Describe the image…').fill('something to zoom into');
    await page.getByRole('button', { name: /^Generate/ }).click();
    await page.getByRole('link', { name: 'Gallery' }).click();

    const requested: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/view')) requested.push(request.url());
    });

    await page.locator('main img').first().click({ timeout: 60_000 });
    const viewer = page.getByTestId('viewer-image');
    await expect(viewer).toBeVisible();
    // The base layer has to have arrived: the crop is worked out from the copy
    // that was actually delivered, not from anything on record.
    await expect
      .poll(() => viewer.evaluate((image: HTMLImageElement) => image.naturalWidth))
      .toBeGreaterThan(0);

    // Double-tap to zoom, which is the gesture a phone actually uses.
    const box = (await viewer.boundingBox())!;
    const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await page.touchscreen.tap(centre.x, centre.y);
    await page.touchscreen.tap(centre.x, centre.y);

    await expect
      .poll(() => requested.filter((url) => url.includes('crop=')).length, { timeout: 20_000 })
      .toBeGreaterThan(0);

    /*
     * The rectangle is fractions of the picture, and a zoom about the centre
     * asks for the middle of it. Pixels would mean the browser had to know how
     * big the file is — which it does not, having only ever seen a copy.
     */
    const crop = new URL(requested.find((url) => url.includes('crop='))!).searchParams.get('crop')!;
    const [x, y, width, height] = crop.split(',').map(Number) as [number, number, number, number];
    expect(width).toBeGreaterThan(0);
    expect(width).toBeLessThan(1);
    expect(x).toBeGreaterThan(0);
    expect(x + width).toBeLessThanOrEqual(1);
    expect(y + height).toBeLessThanOrEqual(1);

    await expect(page.getByTestId('viewer-detail')).toBeVisible();
    await page.screenshot({ path: 'test-results/81-view-zoomed.png' });
  });

  test('shows the result at once when the progress bar was left open', async ({ page }) => {
    /*
     * Sixty steps, so there is time to open the bar before the run is over —
     * at the default the whole thing is finished inside a second.
     */
    const slow = JSON.parse(JSON.stringify(sd15Txt2Img)) as Record<
      string,
      { inputs: Record<string, unknown> }
    >;
    slow['3']!.inputs.steps = 60;
    await withApi((ctx) =>
      ctx.post('/api/workflows', { data: { name: WORKFLOW_NAME, graph: slow } }),
    );

    await open(page, '/');
    await page.getByPlaceholder('Describe the image…').fill('watched result');
    await page.getByRole('button', { name: /^Generate/ }).click();

    // Watching it: the progress sheet, opened by hand.
    await page.getByRole('button', { name: 'Generation progress' }).click();
    await expect(page.getByRole('button', { name: 'Cancel this run' })).toBeVisible({
      timeout: 30_000,
    });

    // The same sheet becomes the result rather than closing and re-opening.
    await expect(page.getByRole('button', { name: 'Dismiss' })).toBeVisible({ timeout: 60_000 });
    await page.screenshot({ path: 'test-results/79-watched-result.png' });
  });
});

test.describe('the twenty-seventh wave', () => {
  /**
   * Sampling is opt-in, one parameter at a time.
   *
   * The thing worth driving through a browser is the *shape* of the dialog:
   * that a parameter is a switch first and a number second, and that switching
   * one on does not switch the rest on with it. An untouched install sending
   * nothing is what keeps the model server's own launch flags meaningful.
   */
  test('turns on one sampling parameter without touching the others', async ({ page }) => {
    /*
     * Settings live on the server, so a test that changes them has to start
     * from a state it chose rather than from whatever ran before it.
     */
    await withApi(async (ctx) => {
      const settings = (await (await ctx.get('/api/settings')).json()) as {
        chat: Record<string, unknown>;
      };
      await ctx.patch('/api/settings', {
        data: { chat: { ...settings.chat, sampling: defaultSampling() } },
      });
    });

    await open(page, '/settings');

    // The summary says what is happening before the dialog is opened at all.
    await expect(
      page.getByText('The model server’s own, from the flags it was started with.'),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Adjust…' }).click();
    await expect(page.getByRole('heading', { name: 'Sampling' })).toBeVisible();

    // A parameter that is off shows no number to argue with.
    await expect(page.getByRole('textbox', { name: 'Temperature', exact: true })).toHaveCount(0);

    await page.getByRole('switch', { name: 'Temperature' }).click();
    const temperature = page.getByRole('textbox', { name: 'Temperature', exact: true });
    await expect(temperature).toBeVisible();
    await temperature.fill('0,35');

    // And its neighbours stayed out of it.
    await expect(page.getByRole('textbox', { name: 'Top-p', exact: true })).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Min-p', exact: true })).toHaveCount(0);
    await page.screenshot({ path: 'test-results/82-sampling.png' });

    await page.getByRole('button', { name: 'Done' }).click();
    await expect(
      page.getByText('1 parameter overriding the server’s own.'),
    ).toBeVisible();

    // It survives a reload, which is the only proof it reached the server.
    await open(page, '/settings');
    await page.getByRole('button', { name: 'Adjust…' }).click();
    await expect(page.getByRole('textbox', { name: 'Temperature', exact: true })).toHaveValue('0.35');

    // And one button hands the whole lot back.
    await page.getByRole('button', { name: 'Hand all of it back to the server' }).click();
    await expect(page.getByRole('textbox', { name: 'Temperature', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(
      page.getByText('The model server’s own, from the flags it was started with.'),
    ).toBeVisible();
  });
});

/**
 * Sound, from the picker to the player.
 *
 * A music or speech workflow is queued and watched exactly like one that draws
 * a picture. What differs is the far end: there is no frame at all — not a
 * missing one, none — so the tile is a card rather than a thumbnail waiting for
 * a poster, and the viewer is a player rather than something to zoom.
 */
test.describe('generating audio', () => {
  test.beforeEach(async () => {
    await resetState();
  });

  test('marks a sound workflow in the picker and plays what it produced', async ({ page }) => {
    await withApi((ctx) =>
      ctx.post('/api/workflows', { data: { name: 'MiniMax Music', graph: minimaxMusic } }),
    );

    await open(page, '/');
    await page.getByRole('button', { name: 'Workflow' }).click();
    const picker = page.getByRole('dialog', { name: 'Workflow' });
    // Which of these makes a sound is worth knowing before you open the form.
    await expect(
      picker.getByRole('button', { name: /MiniMax Music/ }).getByText('sound'),
    ).toBeVisible();
    await picker.getByRole('button', { name: /MiniMax Music/ }).click();

    // How long the track runs is a control on the main screen, in seconds —
    // the audio equivalent of a video's frame count.
    await expect(page.getByText('Seconds', { exact: true }).first()).toBeVisible();
    await page.screenshot({ path: 'test-results/93-audio-form.png' });

    await page.getByPlaceholder('Describe the image…').first().fill('slow shoegaze instrumental');
    await page.getByRole('button', { name: /^Generate/ }).click();

    await expect
      .poll(
        async () => {
          const gallery = await withApi(async (ctx) => {
            const response = await ctx.get('/api/gallery');
            return (await response.json()) as {
              items: { title: string; images: { kind: string }[] }[];
            };
          });
          return gallery.items.find((item) => item.title === 'slow shoegaze instrumental')
            ?.images?.[0]?.kind;
        },
        { timeout: 60_000 },
      )
      .toBe('audio');

    await open(page, '/gallery');

    // A card, not a thumbnail that never arrives.
    const placeholder = page.getByTestId('audio-placeholder').first();
    await expect(placeholder).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: 'test-results/94-audio-grid.png' });

    await placeholder.click();

    const player = page.getByTestId('viewer-audio').locator('audio');
    await expect(player).toBeVisible();
    await expect(player).toHaveAttribute('src', /\/api\/view\?.*\.wav/);
    await expect(player).toHaveAttribute('controls', '');

    /*
     * It really plays. The mock writes a real WAV precisely so this assertion
     * can exist: `duration` is only a number once something has decoded the
     * file, so this is the browser saying it can play what Latent served.
     */
    await expect
      .poll(async () => player.evaluate((node: HTMLAudioElement) => node.duration), {
        timeout: 30_000,
      })
      .toBeGreaterThan(0);
    await page.screenshot({ path: 'test-results/95-audio-viewer.png' });

    // The actions that hand a picture to another graph are not offered.
    await expect(page.getByRole('button', { name: 'img2img' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Upscale' })).toBeDisabled();

    // Rating stores it here, exactly as it does for a picture.
    await page.getByRole('button', { name: '4 stars' }).click();
    await expect
      .poll(async () => {
        const gallery = await withApi(async (ctx) => {
          const response = await ctx.get('/api/gallery');
          return (await response.json()) as { items: { images: { archived: boolean }[] }[] };
        });
        return gallery.items[0]?.images?.[0]?.archived;
      })
      .toBe(true);

    /*
     * And how long it runs reaches the server from the only thing that can
     * read it — the browser that just played it — so the tile can say.
     */
    await expect
      .poll(
        async () => {
          const gallery = await withApi(async (ctx) => {
            const response = await ctx.get('/api/gallery');
            return (await response.json()) as {
              items: { images: { durationMs: number | null }[] }[];
            };
          });
          return gallery.items[0]?.images?.[0]?.durationMs ?? 0;
        },
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0);
  });
});

/**
 * Video, from the picker to the player.
 *
 * A workflow that ends in a clip is queued and watched exactly like one that
 * draws a picture — what differs is everything about the result: the tile has
 * no still until something makes one, the viewer plays rather than zooms, and
 * the actions that hand a picture to another graph are not offered.
 */
test.describe('generating video', () => {
  test.beforeEach(async () => {
    await resetState();
  });

  /** Queue one run of `graph` and wait for its clip to land in the gallery. */
  async function renderClip(page: Page, name: string, graph: unknown, prompt: string) {
    await withApi((ctx) => ctx.post('/api/workflows', { data: { name, graph } }));

    await open(page, '/');
    await page.getByRole('button', { name: 'Workflow' }).click();
    const picker = page.getByRole('dialog', { name: 'Workflow' });
    await picker.getByRole('button', { name: new RegExp(name) }).click();

    await page.getByPlaceholder('Describe the image…').first().fill(prompt);
    await page.getByRole('button', { name: /^Generate/ }).click();

    await expect
      .poll(
        async () => {
          const gallery = await withApi(async (ctx) => {
            const response = await ctx.get('/api/gallery');
            return (await response.json()) as {
              items: { title: string; images: { filename: string; kind: string }[] }[];
            };
          });
          return gallery.items.find((item) => item.title === prompt)?.images ?? [];
        },
        { timeout: 60_000 },
      )
      .not.toHaveLength(0);
  }

  test('marks a video workflow in the picker and plays what it produced', async ({ page }) => {
    await withApi((ctx) => ctx.post('/api/workflows', { data: { name: 'LTXV', graph: ltxVideoGguf } }));

    await open(page, '/');
    await page.getByRole('button', { name: 'Workflow' }).click();
    // Which of these makes a clip is the first thing worth knowing about a list
    // of workflows, and the name does not reliably say.
    const picker = page.getByRole('dialog', { name: 'Workflow' });
    await expect(picker.getByRole('button', { name: /LTXV/ }).getByText('video')).toBeVisible();
    await picker.getByRole('button', { name: /LTXV/ }).click();

    // The frame count is a control on the main screen, not one integer among
    // twenty behind Advanced.
    await expect(page.getByText('Frames', { exact: true }).first()).toBeVisible();
    await page.screenshot({ path: 'test-results/84-video-form.png' });

    await page.getByPlaceholder('Describe the image…').first().fill('a paper boat');
    await page.getByRole('button', { name: /^Generate/ }).click();

    await expect
      .poll(
        async () => {
          const gallery = await withApi(async (ctx) => {
            const response = await ctx.get('/api/gallery');
            return (await response.json()) as {
              items: { title: string; images: { kind: string }[] }[];
            };
          });
          return gallery.items.find((item) => item.title === 'a paper boat')?.images?.[0]?.kind;
        },
        { timeout: 60_000 },
      )
      .toBe('video');

    await open(page, '/gallery');

    /*
     * No still yet, and the tile says so rather than quietly loading the clip:
     * a grid that autoplays videos pulls tens of megabytes over mobile data,
     * which is the exact thing thumbnails exist to prevent.
     */
    const placeholder = page.getByTestId('video-placeholder').first();
    await expect(placeholder).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: 'test-results/85-video-grid.png' });

    await placeholder.click();

    // A player, with the browser's own controls, pointed at this clip.
    const video = page.getByTestId('viewer-video');
    await expect(video).toBeVisible();
    await expect(video).toHaveAttribute('src', /\/api\/view\?.*\.webm/);
    await expect(video).toHaveAttribute('controls', '');

    /*
     * And it does not own the whole screen.
     *
     * Fitted to the clip's own shape, so the margins around it stay part of the
     * layer that handles a swipe to the next output and a tap to close — the
     * two gestures a picture has, which a full-bleed element would swallow.
     */
    const viewport = page.viewportSize()!;
    const box = (await video.boundingBox())!;
    expect(box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.height).toBeLessThan(viewport.height);

    // Rating a clip stores it here, exactly as it does for a picture.
    await page.getByRole('button', { name: '4 stars' }).click();
    await expect
      .poll(async () => {
        const gallery = await withApi(async (ctx) => {
          const response = await ctx.get('/api/gallery');
          return (await response.json()) as {
            items: { images: { archived: boolean }[] }[];
          };
        });
        return gallery.items[0]?.images?.[0]?.archived;
      })
      .toBe(true);

    // And the two actions that hand a picture to another graph are refused,
    // because a clip is not an input image.
    await expect(page.getByRole('button', { name: 'img2img' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Upscale' })).toBeDisabled();
    await page.screenshot({ path: 'test-results/86-video-viewer.png' });
  });

  /**
   * The other half: VideoHelperSuite files its result under `gifs`, and what it
   * made here is a real animated GIF — which the browser draws as a picture.
   */
  test('shows a clip that a browser draws as an image', async ({ page }) => {
    await renderClip(page, 'Combine', videoCombine, 'a sweeping band');

    await open(page, '/gallery');
    const tile = page.getByTestId('video-placeholder').first();
    await expect(tile).toBeVisible({ timeout: 30_000 });
    await tile.click();

    // Drawn by an `<img>`, so this is the one video the viewer does not play —
    // and the frame it shows is the poster the clip did not have.
    const image = page.getByTestId('viewer-image');
    await expect(image).toBeVisible();
    await expect
      .poll(async () => image.evaluate((element) => (element as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);

    // Having decoded it, the browser hands a still back, and the gallery has a
    // thumbnail for a file this server cannot open.
    await expect
      .poll(
        async () => {
          const gallery = await withApi(async (ctx) => {
            const response = await ctx.get('/api/gallery');
            return (await response.json()) as {
              items: { images: { hasThumbnail: boolean }[] }[];
            };
          });
          return gallery.items[0]?.images?.[0]?.hasThumbnail;
        },
        { timeout: 20_000 },
      )
      .toBe(true);

    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByTestId('video-placeholder')).toHaveCount(0);
    await page.screenshot({ path: 'test-results/87-video-poster.png' });
  });
});
