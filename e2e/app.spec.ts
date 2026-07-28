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

async function withApi<T>(fn: (ctx: Awaited<ReturnType<typeof apiRequest.newContext>>) => Promise<T>) {
  const ctx = await apiRequest.newContext({ baseURL: BASE_URL });
  try {
    return await fn(ctx);
  } finally {
    await ctx.dispose();
  }
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
  await page.goto('/settings');
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
    await page.goto('/');
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

    await page.goto('/');
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
      await page.goto(path);
      await page.waitForTimeout(400);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${path} scrolls sideways`).toBeLessThanOrEqual(1);
    }
  });
});
