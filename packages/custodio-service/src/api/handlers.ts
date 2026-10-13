import type { FastifyReply, FastifyRequest } from 'fastify'
import type { z } from 'zod'
import { buildOverview } from '../core/overview.js'
import type { Services } from '../core/services.js'
import { DomainError, notFound } from '../core/shared/errors.js'
import { EVENT_TYPES, type EventType } from '../core/shared/events.js'
import type { Job, JobStatus } from '../core/shared/model.js'
import type { OperationId, RouteDef, ROUTES } from './contract.js'
import type { StoredResponse } from './idempotency.js'
import { streamEvents } from './sse.js'
import { diskView, policyView, projectView, topologyView } from './views.js'

type Infer<T> = T extends z.ZodType ? z.output<T> : undefined

export interface Input<R extends RouteDef> {
  params: R['params'] extends z.ZodType ? z.output<R['params']> : Record<string, never>
  query: R['query'] extends z.ZodType ? z.output<R['query']> : Record<string, never>
  body: Infer<R['body']>
}

export interface Context {
  actor: string
  request: FastifyRequest
  reply: FastifyReply
}

export const HIJACKED = Symbol('hijacked')
export type HandlerResult = StoredResponse | typeof HIJACKED

export type Handlers = {
  [K in OperationId]: (input: Input<(typeof ROUTES)[K]>, ctx: Context) => HandlerResult | Promise<HandlerResult>
}

const ok = (body: unknown): StoredResponse => ({ status: 200, body })
const created = (body: unknown): StoredResponse => ({ status: 201, body })
const accepted = (job: Job): StoredResponse => ({ status: 202, body: { job }, headers: { location: `/v1/jobs/${job.id}` } })

const JOB_STATUSES: JobStatus[] = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted', 'skipped']

export function createHandlers(deps: { services: Services; version: string; startedAt: string; openapi: Record<string, unknown> }): Handlers {
  const s = deps.services
  const core = s.core

  const projectOut = (projectId: string) => projectView(core, s.projects.view(projectId))
  const getPolicy = (policyId: string) => s.policies.get(policyId)

  return {
    getHealth: () => ok({ status: 'ok', version: deps.version, startedAt: deps.startedAt }),
    getOpenApi: () => ok(deps.openapi),
    getOverview: () => ok(buildOverview(core)),

    listDisks: () => ok({ disks: core.store.disks.list().map((d) => diskView(core, d)) }),
    getDisk: ({ params }) => {
      const disk = core.store.disks.get(params.diskId)
      if (!disk) throw notFound('el disco', params.diskId)
      return ok(diskView(core, disk))
    },
    scanDisks: (_input, ctx) => accepted(s.runner.startScan({ actor: ctx.actor })),
    requestRepair: async ({ params }, ctx) => created(await s.repairs.preview(params.diskId, ctx.actor)),

    listProjects: () => ok({ projects: core.store.projects.list().map((p) => projectOut(p.id)) }),
    createProject: ({ body }, ctx) => created(projectOut(s.projects.create(body.name, ctx.actor).id)),
    getProject: ({ params }) => ok(projectOut(params.projectId)),
    getTopology: async ({ params }) => {
      s.projects.get(params.projectId)
      return ok(topologyView(await s.projects.topology(params.projectId)))
    },
    proposeAssignments: ({ params, body }, ctx) => {
      const { plan, topology } = s.plans.proposeAssignments(params.projectId, body.actions, ctx.actor)
      return created({ plan, topology: topologyView(topology) })
    },
    createPolicy: async ({ params, body }, ctx) => created(policyView(core, await s.policies.create(params.projectId, body, ctx.actor))),
    previewDeletion: ({ params, body }, ctx) => created(s.deletions.preview(params.projectId, body, ctx.actor)),
    listDeletions: ({ params }) => {
      s.projects.get(params.projectId)
      return ok({ orders: core.store.deletions.byProject(params.projectId) })
    },

    reconstructProjects: async () => ok({ projects: await s.recovery.reconstruct() }),
    importProject: async ({ body }, ctx) => {
      const found = (await s.recovery.reconstruct()).find((p) => p.id === body.projectId)
      if (!found) throw notFound('en los discos el proyecto', body.projectId)
      s.recovery.import(found, ctx.actor)
      await s.descriptors.syncConnected()
      return created(projectOut(found.id))
    },

    getPlan: ({ params }) => ok(s.plans.get(params.planId)),
    confirmPlan: async ({ params, body }, ctx) => ok(await s.plans.confirm(params.planId, ctx.actor, body.confirm)),

    getPolicy: ({ params }) => ok(policyView(core, getPolicy(params.policyId))),
    updatePolicy: async ({ params, body }, ctx) => ok(policyView(core, await s.policies.update(params.policyId, body, ctx.actor))),
    runPolicy: ({ params, body }, ctx) => {
      const policy = getPolicy(params.policyId)
      const running = core.store.locks.holder(policy.id)
      if (running) throw new DomainError('conflict', 'Esta copia ya está en curso.', { runningJobId: running })
      core.audit.record({
        actor: ctx.actor,
        action: body.dryRun ? 'backup.dry_run_requested' : 'backup.run_requested',
        target: policy.id,
        details: { mode: policy.mode, mirrorDryRunJobId: body.mirrorDryRunJobId ?? null }
      })
      return accepted(s.runner.startBackup(policy.id, { actor: ctx.actor, dryRun: body.dryRun ?? false, mirrorDryRunJobId: body.mirrorDryRunJobId ?? null }))
    },
    getBackupStatus: async ({ query }) => ok(await s.backupStatus.of(query.path)),
    verifyPolicy: ({ params, body }, ctx) => {
      const policy = getPolicy(params.policyId)
      if (core.store.locks.holder(policy.id)) throw new DomainError('conflict', 'Esta copia está trabajando; vuelve a intentarlo cuando termine.')
      return accepted(s.runner.startVerification(policy.id, { actor: ctx.actor, samplePercent: body.samplePercent }))
    },

    listJobs: ({ query }) => {
      const status = query.status
        ?.split(',')
        .map((v) => v.trim())
        .filter((v): v is JobStatus => JOB_STATUSES.includes(v as JobStatus))
      return ok({ jobs: s.runner.list({ policyId: query.policyId, kind: query.kind, status, limit: query.limit }) })
    },
    getJob: ({ params }) => ok(s.runner.get(params.jobId)),
    cancelJob: ({ params }, ctx) => ({ status: 202, body: { job: s.runner.cancel(params.jobId, ctx.actor) } }),

    listEvents: ({ query }) => {
      const types = query.types
        ?.split(',')
        .map((t) => t.trim())
        .filter((t): t is EventType => EVENT_TYPES.includes(t as EventType))
      const events = core.store.outbox.after(query.after, query.limit, types)
      return ok({ events, nextCursor: events.at(-1)?.seq ?? query.after })
    },
    streamEvents: ({ query }, ctx) => {
      streamEvents(ctx.request, ctx.reply, { store: core.store, publisher: core.events, runner: s.runner }, query.after)
      return HIJACKED
    },

    listAudit: ({ query }) => {
      const entries = core.store.audit.after(query.after, query.limit)
      return ok({ entries, nextCursor: entries.at(-1)?.seq ?? query.after })
    }
  }
}
