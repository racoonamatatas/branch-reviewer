// The dashboard's wire schemas. Every response is re-validated here and ids
// gain their brands during parse (toTypedId) — the same rule the server
// applies to model-authored ids, because JSON over HTTP is an untrusted
// boundary no matter who wrote the other end. The `satisfies z.ZodType<...>`
// pins each schema's output to the server's own type: a field drifting on
// either side is a compile error in this file, not a runtime surprise in a
// view. Server modules are imported as types only — the ids module is the
// one value import, and it is pure.

import { z } from 'zod';
import type { Coverage } from '@server/coverage/coverage';
import type { Severity } from '@server/schema/schema';
import type { ActivityEvent, PollStatus } from '@server/server/events';
import type { Job, JobState, JobSummary } from '@server/server/jobs';
import type { ClusterDetail, ConsolidationDetail } from '@server/server/server';
import type { Watch } from '@server/server/trigger';
import type {
    Campaign, CampaignRound, CampaignSummary, ConsolidationSummary, Finding, RunSummary,
    StoppedBy, TargetSummary, Verification, VerificationStatus,
} from '@server/store/store';
import {
    campaignId, clusterId, consolidationId, findingId, jobId, runId, toTypedId, verificationId, watchId,
} from '@server/types/ids';

const severitySchema = z.enum(['critical', 'warning', 'nit']) satisfies z.ZodType<Severity>;
const verdictSchema = z.enum(['confirmed', 'refuted', 'undetermined']);
const verificationStatusSchema = z.enum(['pending', 'confirmed', 'refuted', 'undetermined']) satisfies z.ZodType<VerificationStatus>;
const jobStateSchema = z.enum(['held', 'queued', 'running', 'succeeded', 'aborted', 'failed', 'cancelled']) satisfies z.ZodType<JobState>;

export const jobSummarySchema = z.object({
    id: toTypedId(jobId),
    createdAt: z.string(),
    kind: z.enum(['review', 'campaign', 'verify']),
    state: jobStateSchema,
    owner: z.string(),
    repo: z.string(),
    head: z.string(),
    base: z.string(),
    target: z.string(),
    runCount: z.number().int(),
}) satisfies z.ZodType<JobSummary>;

// Lifecycle fields are absent until the store assigns them; JSON drops
// undefined, so absence is the wire shape of "not yet".
const jobCommon = {
    id: toTypedId(jobId),
    createdAt: z.string(),
    owner: z.string(),
    repo: z.string(),
    head: z.string(),
    base: z.string(),
    state: jobStateSchema,
    startedAt: z.string().optional(),
    finishedAt: z.string().optional(),
    error: z.string().optional(),
    runIds: z.array(toTypedId(runId)),
    consolidationId: toTypedId(consolidationId).optional(),
};

export const jobSchema = z.discriminatedUnion('kind', [
    z.object({
        ...jobCommon,
        kind: z.literal('review'),
        params: z.object({
            model: z.string().optional(),
            maxTurns: z.number().int().optional(),
        }),
    }),
    z.object({
        ...jobCommon,
        kind: z.literal('campaign'),
        params: z.object({
            model: z.string().optional(),
            maxTurns: z.number().int().optional(),
            maxRuns: z.number().int(),
            patience: z.number().int().optional(),
            verify: z.boolean(),
            reverify: z.boolean().optional(),
        }),
    }),
    z.object({
        ...jobCommon,
        kind: z.literal('verify'),
        params: z.object({
            model: z.string().optional(),
            maxTurns: z.number().int().optional(),
            reverify: z.boolean().optional(),
        }),
    }),
]) satisfies z.ZodType<Job>;

export const watchSchema = z.object({
    id: toTypedId(watchId),
    createdAt: z.string(),
    owner: z.string(),
    repo: z.string(),
    label: z.string(),
}) satisfies z.ZodType<Watch>;

export const targetSummarySchema = z.object({
    owner: z.string(),
    repo: z.string(),
    head: z.string(),
    base: z.string(),
    runCount: z.number().int(),
    lastRunAt: z.string(),
    totalCostUsd: z.number(),
    latestConsolidationId: toTypedId(consolidationId).optional(),
}) satisfies z.ZodType<TargetSummary>;

export const runSummarySchema = z.object({
    id: toTypedId(runId),
    createdAt: z.string(),
    // 'empty': the compare listed no files, no model ran — its own status,
    // never a submitted review with zero findings.
    status: z.enum(['submitted', 'aborted', 'empty']),
    turns: z.number().int(),
    costUsd: z.number(),
    target: z.string(),
    findingsCount: z.number().int(),
    // Absent on runs saved before the column existed.
    filesChanged: z.number().int().optional(),
}) satisfies z.ZodType<RunSummary>;

export const consolidationSummarySchema = z.object({
    id: toTypedId(consolidationId),
    createdAt: z.string(),
    runIds: z.array(toTypedId(runId)),
    target: z.string(),
    clusterCount: z.number().int(),
}) satisfies z.ZodType<ConsolidationSummary>;

export const findingSchema = z.object({
    id: toTypedId(findingId),
    runId: toTypedId(runId),
    file: z.string(),
    line: z.number().int().optional(),
    severity: severitySchema,
    title: z.string(),
    detail: z.string(),
    suggestion: z.string().optional(),
}) satisfies z.ZodType<Finding>;

// Provenance mirrors the server's union: agent rows carry confidence and
// price, human rows never do, and a human verdict is never undetermined.
const verificationBase = {
    id: toTypedId(verificationId),
    clusterId: toTypedId(clusterId),
    createdAt: z.string(),
    rationale: z.string(),
};

export const verificationSchema = z.discriminatedUnion('source', [
    z.object({
        ...verificationBase,
        source: z.literal('agent'),
        verdict: verdictSchema,
        confidence: z.string(),
        costUsd: z.number(),
    }),
    z.object({
        ...verificationBase,
        source: z.literal('human'),
        verdict: z.enum(['confirmed', 'refuted']),
    }),
]) satisfies z.ZodType<Verification>;

const clusterDetailSchema = z.object({
    id: toTypedId(clusterId),
    severity: severitySchema,
    occurrence: z.number().int(),
    verificationStatus: verificationStatusSchema,
    representative: findingSchema,
    members: z.array(findingSchema),
    verifications: z.array(verificationSchema),
}) satisfies z.ZodType<ClusterDetail>;

export const consolidationDetailSchema = z.object({
    id: toTypedId(consolidationId),
    createdAt: z.string(),
    owner: z.string(),
    repo: z.string(),
    head: z.string(),
    base: z.string(),
    runIds: z.array(toTypedId(runId)),
    clusters: z.array(clusterDetailSchema),
}) satisfies z.ZodType<ConsolidationDetail>;

export const activityEventSchema = z.object({
    seq: z.number().int(),
    at: z.string(),
    source: z.enum(['server', 'worker', 'trigger']),
    text: z.string(),
}) satisfies z.ZodType<ActivityEvent>;

export const pollStatusSchema = z.discriminatedUnion('polling', [
    z.object({ polling: z.literal(false) }),
    z.object({
        polling: z.literal(true),
        intervalMs: z.number(),
        lastAt: z.string().optional(),
    }),
]) satisfies z.ZodType<PollStatus>;

export const coverageSchema = z.object({
    observed: z.number().int(),
    f1: z.number().int(),
    f2: z.number().int(),
    undiscovered: z.number().int(),
    estimatedTotal: z.number().int(),
}) satisfies z.ZodType<Coverage>;

const stoppedBySchema = z.enum(['dry', 'max-runs', 'no-usable-runs', 'empty-diff', 'no-consolidation']) satisfies z.ZodType<StoppedBy>;

// A round is the loop's own snapshot — coverage rides along whole because a
// later estimator tweak must not rewrite what the campaign saw when it
// decided to stop.
const campaignRoundSchema = z.object({
    round: z.number().int(),
    runId: toTypedId(runId).optional(),
    findings: z.number().int(),
    turns: z.number().int(),
    costUsd: z.number(),
    aborted: z.string().optional(),
    failed: z.string().optional(),
    consolidationFailed: z.string().optional(),
    consolidationId: toTypedId(consolidationId).optional(),
    coverage: coverageSchema.optional(),
    novelClusters: z.number().int(),
}) satisfies z.ZodType<CampaignRound>;

export const campaignSummarySchema = z.object({
    id: toTypedId(campaignId),
    createdAt: z.string(),
    owner: z.string(),
    repo: z.string(),
    head: z.string(),
    base: z.string(),
    target: z.string(),
    status: z.enum(['running', 'verifying', 'finished', 'failed']),
    stoppedBy: stoppedBySchema.optional(),
    // false on a live row = liveness unprovable: the loop never proved it
    // holds the lease, the sweep refuses to judge it, and only an operator
    // force-fail can retire it — the UI must be able to say so.
    leased: z.boolean(),
    roundCount: z.number().int(),
    reviewCostUsd: z.number(),
}) satisfies z.ZodType<CampaignSummary>;

// Status mirrors the server's union: a finished campaign always knows why it
// stopped, a failed one always carries its error, a running one claims neither.
const campaignCommon = {
    id: toTypedId(campaignId),
    createdAt: z.string(),
    owner: z.string(),
    repo: z.string(),
    head: z.string(),
    base: z.string(),
    baselineConsolidationId: toTypedId(consolidationId).optional(),
    leased: z.boolean(),
    rounds: z.array(campaignRoundSchema),
};

export const campaignSchema = z.discriminatedUnion('status', [
    z.object({ ...campaignCommon, status: z.literal('running') }),
    // 'verifying': the loop is over (stoppedBy is already durable) but the
    // adversarial passes are still billing — a live phase, not a terminal one.
    z.object({ ...campaignCommon, status: z.literal('verifying'), stoppedBy: stoppedBySchema }),
    z.object({ ...campaignCommon, status: z.literal('finished'), stoppedBy: stoppedBySchema, finishedAt: z.string() }),
    // stoppedBy present exactly when the failure hit during verification.
    z.object({ ...campaignCommon, status: z.literal('failed'), error: z.string(), stoppedBy: stoppedBySchema.optional(), finishedAt: z.string() }),
]) satisfies z.ZodType<Campaign>;
