import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';

import { analyseStudy, applyOverrides, planStudy, switchCounts, MAX_SHOTS } from '@latent/shared';
import type {
  CreateStudyRequest,
  ParamValues,
  StudyDetail,
  StudyFactor,
  StudyPreview,
  StudyRating,
  StudySamplingName,
  StudyShotImage,
  StudyStats,
  StudySummary,
  UpdateStudyRequest,
} from '@latent/shared';

import { keepAsFavorite } from './favorites.js';
import type { AppContext } from './context.js';

const SAMPLINGS = new Set<StudySamplingName>(['lhs', 'random']);
const RATINGS = new Set<number>([1, 2, 3]);

/**
 * Trust nothing that arrives as a factor.
 *
 * Factors come from the client as opaque JSON and go straight into the
 * sampler, which will happily be asked for a range of NaN to Infinity in steps
 * of zero and hand back a plan of nothing. Everything is coerced to something
 * the engine survives, and anything unrecognisable is dropped rather than
 * half-repaired — a factor that silently became something else is worse than
 * one that is missing, because the study would run and the results would be
 * about a parameter nobody chose.
 */
function sanitiseFactors(raw: unknown): StudyFactor[] {
  if (!Array.isArray(raw)) return [];
  const out: StudyFactor[] = [];

  for (const entry of raw.slice(0, 24)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const factor = entry as Record<string, unknown>;
    const key = typeof factor.key === 'string' ? factor.key : '';
    if (key === '') continue;

    const label = typeof factor.label === 'string' && factor.label ? factor.label : key;
    const cost = clampInt(factor.cost, 0, 5, 0);

    if (factor.kind === 'categorical') {
      const levels = Array.isArray(factor.levels)
        ? factor.levels.filter(
            (level): level is string | number | boolean =>
              typeof level === 'string' || typeof level === 'number' || typeof level === 'boolean',
          )
        : [];
      if (levels.length === 0) continue;
      out.push({ kind: 'categorical', key, label, levels, cost });
      continue;
    }

    const min = Number(factor.min);
    const max = Number(factor.max);
    if (!Number.isFinite(min) || !Number.isFinite(max)) continue;

    const quantise = factor.quantise as Record<string, unknown> | undefined;
    const mode = quantise?.mode === 'interval' ? 'interval' : 'samples';
    const centre = Number(factor.centre);
    const spread = Number(factor.spread);

    out.push({
      kind: 'numeric',
      key,
      label,
      min,
      max,
      quantise:
        mode === 'interval'
          ? { mode, step: positive(quantise?.step, 1) }
          : { mode, count: clampInt(quantise?.count, 2, 64, 5) },
      distribution:
        factor.distribution === 'normal' ||
        factor.distribution === 'log-uniform' ||
        factor.distribution === 'triangular'
          ? factor.distribution
          : 'uniform',
      ...(Number.isFinite(centre) ? { centre } : {}),
      ...(Number.isFinite(spread) ? { spread } : {}),
      integer: factor.integer === true,
      cost,
    });
  }

  return out;
}

function clampInt(value: unknown, low: number, high: number, fallback: number): number {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) ? Math.min(Math.max(number, low), high) : fallback;
}

function positive(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export function registerStudyRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/studies', async () => ctx.store.listStudies() satisfies StudySummary[]);

  app.get('/api/studies/running', async () => ctx.studyRunner.state);

  app.get<{ Params: { id: string } }>('/api/studies/:id', async (request, reply) => {
    const study = ctx.store.getStudy(request.params.id);
    if (!study) return reply.code(404).send({ error: 'No such study' });
    return study satisfies StudyDetail;
  });

  app.post<{ Body: CreateStudyRequest }>('/api/studies', async (request, reply) => {
    const body = request.body ?? ({} as CreateStudyRequest);
    const workflow = ctx.store.getWorkflow(body.workflowId);
    if (!workflow) return reply.code(404).send({ error: 'Workflow not found' });

    const id = randomUUID();
    ctx.store.insertStudy({
      id,
      name: body.name?.trim() || `Study of ${workflow.name}`,
      workflowId: workflow.id,
      workflowName: workflow.name,
      /*
       * Drawn once and kept, so the plan is reproducible: re-planning after a
       * change gives a comparable draw rather than a different universe, and
       * the same study can be described to somebody else.
       */
      seed: Math.floor(Math.random() * 2 ** 31),
    });

    /*
     * The workflow's own last values as the starting point, so the prompt and
     * everything not being varied is already what you last generated with.
     */
    ctx.store.updateStudy(id, { base: workflow.lastValues });
    return reply.code(201).send(ctx.store.getStudy(id));
  });

  app.patch<{ Params: { id: string }; Body: UpdateStudyRequest }>(
    '/api/studies/:id',
    async (request, reply) => {
      const study = ctx.store.getStudy(request.params.id);
      if (!study) return reply.code(404).send({ error: 'No such study' });

      const body = request.body ?? {};
      ctx.store.updateStudy(study.id, {
        ...(body.name === undefined ? {} : { name: body.name.trim() || study.name }),
        ...(body.factors === undefined ? {} : { factors: sanitiseFactors(body.factors) }),
        ...(body.base === undefined ? {} : { base: body.base }),
        ...(body.sampling && SAMPLINGS.has(body.sampling) ? { sampling: body.sampling } : {}),
        ...(body.shotCount === undefined
          ? {}
          : { shotCount: clampInt(body.shotCount, 1, MAX_SHOTS, study.shotCount) }),
        ...(body.seed === undefined ? {} : { seed: clampInt(body.seed, 0, 2 ** 31, study.seed) }),
      });
      return ctx.store.getStudy(study.id);
    },
  );

  app.delete<{ Params: { id: string } }>('/api/studies/:id', async (request, reply) => {
    if (ctx.studyRunner.state.studyId === request.params.id) ctx.studyRunner.pause();
    ctx.store.deleteStudy(request.params.id);
    return reply.code(204).send();
  });

  /**
   * What the plan would look like, without committing to it.
   *
   * Drawn fresh from the stored setup each time, so the setup screen can show
   * what a choice costs — "4 model loads" against "196 model loads" is the
   * difference between an afternoon and a weekend, and nothing about the
   * numbers you typed makes that visible.
   */
  app.get<{ Params: { id: string } }>('/api/studies/:id/preview', async (request, reply) => {
    const study = ctx.store.getStudy(request.params.id);
    if (!study) return reply.code(404).send({ error: 'No such study' });

    const factors = sanitiseFactors(study.factors);
    const shots = planStudy({
      factors,
      shots: study.shotCount,
      sampling: study.sampling,
      seed: study.seed,
    });

    return {
      shots: shots.length,
      switches: switchCounts(shots, factors),
      sample: shots.slice(0, 8) as ParamValues[],
    } satisfies StudyPreview;
  });

  /**
   * Draw the plan and start rendering it.
   *
   * Planning and starting are one call on purpose. A plan that exists but has
   * not started is a state with nothing useful to do in it, and keeping them
   * apart would let the factors be edited in between — leaving a run whose
   * shots no longer match the study describing them.
   */
  app.post<{ Params: { id: string } }>('/api/studies/:id/start', async (request, reply) => {
    const study = ctx.store.getStudy(request.params.id);
    if (!study) return reply.code(404).send({ error: 'No such study' });
    if (!study.workflowId || !ctx.store.getWorkflow(study.workflowId)) {
      return reply.code(400).send({ error: 'That workflow has been deleted' });
    }

    const factors = sanitiseFactors(study.factors);
    if (factors.length === 0) {
      return reply.code(400).send({ error: 'Nothing is being varied yet' });
    }

    /*
     * Resuming keeps the plan. Only a study that has never run — or one being
     * deliberately restarted from its draft state — is drawn again; re-drawing
     * on resume would throw away every picture already rendered.
     */
    const existing = ctx.store.listShots(study.id);
    if (existing.length === 0 || study.status === 'draft') {
      const shots = planStudy({
        factors,
        shots: study.shotCount,
        sampling: study.sampling,
        seed: study.seed,
      });
      ctx.store.replaceShots(
        study.id,
        shots.map((values) => ({ id: randomUUID(), values: values as ParamValues })),
      );
    }

    ctx.studyRunner.start(study.id);
    return ctx.store.getStudy(study.id);
  });

  app.post<{ Params: { id: string } }>('/api/studies/:id/pause', async (request, reply) => {
    const study = ctx.store.getStudy(request.params.id);
    if (!study) return reply.code(404).send({ error: 'No such study' });
    ctx.studyRunner.pause();
    return ctx.store.getStudy(study.id);
  });

  /** Move to the rating phase without waiting for the rest to render. */
  app.post<{ Params: { id: string } }>('/api/studies/:id/finish', async (request, reply) => {
    const study = ctx.store.getStudy(request.params.id);
    if (!study) return reply.code(404).send({ error: 'No such study' });
    if (ctx.studyRunner.state.studyId === study.id) ctx.studyRunner.pause();
    ctx.store.updateStudy(study.id, { status: 'rating' });
    return ctx.store.getStudy(study.id);
  });

  app.get<{ Params: { id: string } }>('/api/studies/:id/shots', async (request, reply) => {
    const study = ctx.store.getStudy(request.params.id);
    if (!study) return reply.code(404).send({ error: 'No such study' });
    return ctx.store.listShots(study.id);
  });

  /**
   * The next picture to judge, drawn at random from those not yet rated.
   *
   * Random is the methodological point, not a flourish. The plan runs in cost
   * order, so the pictures arrive grouped by model and by resolution; rating
   * them in that order means forty frames from one checkpoint in a row, and by
   * the tenth you have recalibrated to it. What you would be measuring is
   * drift in your own eye.
   */
  app.get<{ Params: { id: string } }>('/api/studies/:id/next', async (request, reply) => {
    const study = ctx.store.getStudy(request.params.id);
    if (!study) return reply.code(404).send({ error: 'No such study' });

    const shot = ctx.store.randomUnratedShot(study.id);
    if (!shot?.generationId) return reply.code(204).send();

    const record = ctx.store.getGeneration(shot.generationId);
    const image = record?.images[0];
    if (!record || !image) return reply.code(204).send();

    return { shot, image, record } satisfies StudyShotImage;
  });

  app.put<{ Params: { id: string; shotId: string }; Body: { rating: StudyRating | null } }>(
    '/api/studies/:id/shots/:shotId/rating',
    async (request, reply) => {
      const shot = ctx.store.getShot(request.params.shotId);
      if (!shot || shot.studyId !== request.params.id) {
        return reply.code(404).send({ error: 'No such shot' });
      }

      const rating = request.body?.rating ?? null;
      if (rating !== null && !RATINGS.has(rating)) {
        return reply.code(400).send({ error: 'A rating is 1, 2 or 3' });
      }
      ctx.store.setShotRating(shot.id, rating);
      return ctx.store.getShot(shot.id);
    },
  );

  /**
   * Keep a study's picture: into the gallery, and into the favourites.
   *
   * A study is a bulk experiment whose output is deliberately hidden, but
   * every so often one of the hundred frames is genuinely good — and losing it
   * because the module that made it throws its results away would be a poor
   * trade. This is the door out: the run stops being a study run and becomes
   * an ordinary one, after which nothing anywhere treats it specially.
   */
  app.post<{ Params: { id: string; shotId: string } }>(
    '/api/studies/:id/shots/:shotId/keep',
    async (request, reply) => {
      const shot = ctx.store.getShot(request.params.shotId);
      if (!shot || shot.studyId !== request.params.id) {
        return reply.code(404).send({ error: 'No such shot' });
      }
      if (!shot.generationId) return reply.code(400).send({ error: 'That shot has no picture' });

      const record = ctx.store.getGeneration(shot.generationId);
      const image = record?.images[0];
      if (!record || !image) return reply.code(400).send({ error: 'That shot has no picture' });

      /*
       * Promote first, then favourite. Favouriting archives the bytes, and the
       * archive is what lets the picture outlive the rented box — so doing it
       * in this order means a kept picture is durable from the moment it
       * appears in the gallery rather than a few seconds later.
       */
      ctx.store.promoteStudyGeneration(record.id);

      const study = ctx.store.getStudy(shot.studyId);
      const kept = await keepAsFavorite(app, ctx, {
        generationId: record.id,
        image,
        note: study ? `From the study “${study.name}”` : null,
      });
      if (!kept) return reply.code(500).send({ error: 'Could not keep that picture' });

      return reply.code(kept.created ? 201 : 200).send(kept.favorite);
    },
  );

  /**
   * The whole analysis, computed on demand.
   *
   * Not cached: it is a walk over a few hundred rows and some arithmetic, and
   * every rating changes the answer. A cache would mean a results screen that
   * lags one tap behind the rating that produced it.
   */
  app.get<{ Params: { id: string } }>('/api/studies/:id/stats', async (request, reply) => {
    const study = ctx.store.getStudy(request.params.id);
    if (!study) return reply.code(404).send({ error: 'No such study' });

    const rated = ctx.store.ratedShots(study.id);
    const unrated = ctx.store
      .listShots(study.id)
      .filter((shot) => shot.status === 'done' && shot.rating === null).length;

    return analyseStudy(
      rated.map((entry) => ({
        values: entry.values as Record<string, string | number | boolean>,
        rating: entry.rating,
      })),
      sanitiseFactors(study.factors),
      unrated,
    ) satisfies StudyStats;
  });

  /**
   * Every field of the study's workflow, as candidates to vary.
   *
   * The whole schema, not the tidied-up form the Generate screen shows: a
   * study can legitimately vary something hidden away in Advanced, and "which
   * parameters can I sweep" is a different question from "which do I set
   * before every render".
   */
  app.get<{ Params: { id: string } }>('/api/studies/:id/fields', async (request, reply) => {
    const study = ctx.store.getStudy(request.params.id);
    if (!study?.workflowId) return reply.code(404).send({ error: 'No such study' });

    const detail = ctx.store.getWorkflow(study.workflowId);
    if (!detail) return reply.code(404).send({ error: 'That workflow has been deleted' });

    return applyOverrides(detail.schema, detail.overrides);
  });
}
