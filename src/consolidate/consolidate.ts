// Cross-run consolidation: semantic clustering of findings from multiple reviews of
// the same target. Key-based identity is dead on arrival — the same defect
// recurs with different wording, angle, and line anchors — so identity is
// judged by a tool-less query(): no MCP servers, no built-ins, one turn,
// pure structured output. The judge proposes the partition; validating it
// is ours, same trust boundary as reviewSchema.parse in the review path.

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { judgeModel } from '../sdk/models.js';
import { assertSubscriptionCredit, requireResult, rethrowUnlessResultExplains } from '../sdk/sdk.js';
import type { Severity } from '../schema/schema.js';
import type { Finding } from '../store/store.js';
import { findingId, toTypedId } from '../types/ids.js';
import type { FindingId } from '../types/ids.js';

// What the judge proposes, not what the store holds: a partition of finding
// ids. It becomes a Cluster entity only after validation, enrichment
// (severity, occurrence) and a save.
export interface ClusterProposal
{
    memberIds: FindingId[];
    representativeId: FindingId;
}

// Ids the judge hands back are the least-trusted numbers in the system:
// authored by a model, not read from our own tables — they gain their
// type during parse.
export const clusterResponseSchema = z.object({
    clusters: z.array(z.object({
        memberIds: z.array(toTypedId(findingId)).min(1)
            .describe('Finding ids that describe the same underlying defect'),
        representativeId: toTypedId(findingId)
            .describe('The member whose formulation is the sharpest and most complete'),
    })),
});

// io: 'input' — the wire shape the model emits, which is what the SDK's
// outputFormat must describe; the default (output side) cannot represent
// a transform and throws at module load.
export const clusterResponseJsonSchema = z.toJSONSchema(clusterResponseSchema, { target: 'draft-7', io: 'input' });

const JUDGE_SYSTEM_PROMPT = `You are a code-review finding deduplicator. You receive findings collected from several independent review runs of the same branch diff.

Group findings that describe the same underlying defect into one cluster. Judge the defect, not the text: the same issue recurs across runs with different wording, a different angle of attack, different severity, and different line anchors. Two findings belong together only if fixing one would fix the other.

Rules:
- Every finding id appears in exactly one cluster.
- A finding with no counterpart stays in a cluster of its own.
- Never group findings merely because they touch the same file or method.
- As representative, pick the member whose formulation is the sharpest and most complete.`;

export function buildJudgePrompt(findings: Finding[]): string
{
    const lines = findings.map(f =>
        `id ${f.id} (run ${f.runId}) [${f.severity}] ${f.file}${f.line !== undefined ? `:${f.line}` : ''} — ${f.title}\n${f.detail}`);
    return `Cluster these ${findings.length} findings.\n\n${lines.join('\n\n')}`;
}

// Returns a violation description, or undefined when the partition is valid.
export function validatePartition(findings: Finding[], clusters: ClusterProposal[]): string | undefined
{
    const expected = new Set<FindingId>(findings.map(f => f.id));
    const seen = new Set<FindingId>();

    for (const cluster of clusters)
    {
        for (const id of cluster.memberIds)
        {
            if (!expected.has(id))
            {
                return `id ${id} is not an input finding id`;
            }
            if (seen.has(id))
            {
                return `id ${id} appears in more than one cluster`;
            }
            seen.add(id);
        }
        if (!cluster.memberIds.includes(cluster.representativeId))
        {
            return `representative ${cluster.representativeId} is not a member of its cluster`;
        }
    }

    const missing = [...expected].filter(id => !seen.has(id));
    if (missing.length > 0)
    {
        return `ids missing from every cluster: ${missing.join(', ')}`;
    }
    return undefined;
}

const SEVERITY_ORDER: Severity[] = ['critical', 'warning', 'nit'];

export function maxSeverity(severities: Severity[]): Severity
{
    for (const severity of SEVERITY_ORDER)
    {
        if (severities.includes(severity))
        {
            return severity;
        }
    }
    return 'nit';
}

export function distinctRuns(findings: Finding[]): number
{
    return new Set(findings.map(f => f.runId)).size;
}

// Every finding its own cluster — trivially valid under validatePartition.
// The degraded fallback when the judge cannot produce a valid partition:
// occurrence collapses to 1 for everything, which over-proposes verification
// rather than hiding findings, and the next consolidation re-clusters from
// scratch, so the degradation is not sticky.
export function identityPartition(findings: Finding[]): ClusterProposal[]
{
    return findings.map(f => ({ memberIds: [f.id], representativeId: f.id }));
}

export interface ClusteringOptions
{
    model?: string;
    // Fired when the judge exhausted its retries and the identity partition
    // was used instead. Reporting is by callback, not console: stdout belongs
    // to the CLI layer.
    onDegraded?: (violation: string) => void;
}

export interface ClusteringOutcome
{
    clusters: ClusterProposal[];
    // Everything the judge billed to produce this partition, retries
    // included — the campaign's headline number is a lie without it.
    costUsd: number;
}

// A structural judge failure still spent money — this attempt, and any
// capped attempt before it. A bare throw discarded that meter (rev 21);
// this error carries it so the caller's accounting can absorb it.
export class ClusteringError extends Error
{
    readonly costUsd: number;

    constructor(message: string, costUsd: number)
    {
        super(message);
        this.name = 'ClusteringError';
        this.costUsd = costUsd;
    }
}

export async function runClustering(findings: Finding[], opts: ClusteringOptions = {}): Promise<ClusteringOutcome>
{
    assertSubscriptionCredit();

    const basePrompt = buildJudgePrompt(findings);
    let violation: string | undefined;
    let problem: string | undefined;
    let costUsd = 0;

    for (let attempt = 1; attempt <= 2; attempt++)
    {
        const prompt = violation === undefined
            ? basePrompt
            : `${basePrompt}\n\nYour previous partition was invalid: ${violation}. Produce a valid partition.`;

        const attempted = await judgeOnce(prompt, opts);
        costUsd += attempted.costUsd;
        if (attempted.failed !== undefined)
        {
            if (attempted.structural === true)
            {
                // An outage, not a bad answer — no retry. The meter rides
                // the throw: this attempt billed, and so did any capped
                // attempt before it (rev 21).
                throw new ClusteringError(`Clustering judge failed: ${attempted.failed}`, costUsd);
            }
            // A capped run billed like any attempt and must degrade like one
            // — a throw would lose the meter AND skip the fallback below. A
            // turn cap retries with the base prompt (nothing to feed back);
            // a schema miss feeds the mismatch back so the retry is a
            // correction, not a re-flip of the same coin (rev 21).
            problem = `judge run failed: ${attempted.failed}`;
            violation = attempted.retryFeedback;
            continue;
        }
        violation = validatePartition(findings, attempted.clusters);
        if (violation === undefined)
        {
            return { clusters: attempted.clusters, costUsd };
        }
        problem = violation;
    }

    // Two failed attempts in a row: the judge cannot be trusted with this
    // input today, but the findings are already paid for and a campaign's
    // whole product hangs off the consolidation. Degrade instead of throwing.
    opts.onDegraded?.(problem!);
    return { clusters: identityPartition(findings), costUsd };
}

// One judge call. `failed` carries an attempt failure with the cost the
// attempt still billed: retryable ones (the turn cap; output that missed the
// schema, with the mismatch as retryFeedback), or `structural` ones the
// caller turns into a ClusteringError so no meter is lost. A plain throw is
// reserved for what never billed a result: no credit, a dead stream.
type JudgeAttempt =
    | { clusters: ClusterProposal[]; costUsd: number; failed?: undefined; structural?: undefined; retryFeedback?: undefined }
    | { failed: string; costUsd: number; structural?: true; retryFeedback?: string; clusters?: undefined };

async function judgeOnce(prompt: string, opts: ClusteringOptions): Promise<JudgeAttempt>
{
    const stream = query({
        prompt,
        options: {
            systemPrompt: JUDGE_SYSTEM_PROMPT,
            model: opts.model ?? judgeModel(),
            // Not 1: Sonnet answers and then hands back structured output in
            // a second round-trip, so a cap of 1 aborted every judge call the
            // moment the judge moved off Opus (caught live by the first
            // rotating campaign; deterministic in the CLI). tools: [] is
            // what bounds this loop — the cap is just a backstop.
            maxTurns: 4,
            tools: [],
            outputFormat: { type: 'json_schema', schema: clusterResponseJsonSchema },
        },
    });

    // The stream is consumed to the end, with the same rescue the review and
    // verify sites use: after an error result the SDK errors the stream, and
    // an early return would leave that rejection to iterator.return() —
    // whose behavior we'd rather not depend on (rev 19).
    let seen: SDKResultMessage | undefined;
    try
    {
        for await (const message of stream)
        {
            if (message.type === 'result')
            {
                seen = message;
            }
        }
    }
    catch (error)
    {
        rethrowUnlessResultExplains(seen, error);
    }
    // requireResult also catches the unauthenticated is_error 'success'
    // result, which otherwise dies below as a schema check of an absent
    // structured_output.
    const result = requireResult(seen);
    if (result.subtype !== 'success')
    {
        // Only the turn cap earns the retry-then-degrade path: it is the
        // judge failing at this input. Any other subtype is structural, and
        // degrading over it would dress an outage as a clustering (rev 19) —
        // but its cost is still real, so it goes back as data, not a throw.
        if (result.subtype === 'error_max_turns')
        {
            return { failed: result.subtype, costUsd: result.total_cost_usd };
        }
        return { failed: result.subtype, structural: true, costUsd: result.total_cost_usd };
    }
    // A response that missed the schema is the same class of attempt failure
    // as a capped run: paid for, worth one retry, never worth a throw that
    // loses the meter.
    const parsed = clusterResponseSchema.safeParse(result.structured_output);
    if (!parsed.success)
    {
        return {
            failed: 'structured output did not match the cluster schema',
            retryFeedback: 'the response did not match the required schema — '
                + parsed.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
            costUsd: result.total_cost_usd,
        };
    }
    return { clusters: parsed.data.clusters, costUsd: result.total_cost_usd };
}
