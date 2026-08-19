// Cross-run consolidation: semantic clustering of findings from multiple reviews of
// the same target. Key-based identity is dead on arrival — the same defect
// recurs with different wording, angle, and line anchors — so identity is
// judged by a tool-less query(): no MCP servers, no built-ins, one turn,
// pure structured output. The judge proposes the partition; validating it
// is ours, same trust boundary as reviewSchema.parse in the review path.

import { query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { assertSubscriptionCredit, throwIfErrorResult } from '../review/review.js';
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

export interface ClusteringOptions
{
    model?: string;
}

export async function runClustering(findings: Finding[], opts: ClusteringOptions = {}): Promise<ClusterProposal[]>
{
    assertSubscriptionCredit();

    const basePrompt = buildJudgePrompt(findings);
    let violation: string | undefined;

    for (let attempt = 1; attempt <= 2; attempt++)
    {
        const prompt = violation === undefined
            ? basePrompt
            : `${basePrompt}\n\nYour previous partition was invalid: ${violation}. Produce a valid partition.`;

        const clusters = await judgeOnce(prompt, opts);
        violation = validatePartition(findings, clusters);
        if (violation === undefined)
        {
            return clusters;
        }
    }

    throw new Error(`Clustering failed: the judge produced an invalid partition twice (last violation: ${violation}).`);
}

async function judgeOnce(prompt: string, opts: ClusteringOptions): Promise<ClusterProposal[]>
{
    const stream = query({
        prompt,
        options: {
            systemPrompt: JUDGE_SYSTEM_PROMPT,
            model: opts.model,
            // Logically one turn — but structured output arrives as a tool
            // call, so a harness retry (a truncated or invalid first attempt)
            // needs a spare turn to land. A 1-turn budget aborted a real
            // judge call with error_max_turns clustering 12 findings
            // (2026-08-19); 4 keeps the call one-shot with retry headroom.
            maxTurns: 4,
            tools: [],
            outputFormat: { type: 'json_schema', schema: clusterResponseJsonSchema },
        },
    });

    for await (const message of stream)
    {
        if (message.type === 'result')
        {
            // Catches the unauthenticated is_error 'success' result, which
            // otherwise dies below as a Zod parse of an absent
            // structured_output.
            throwIfErrorResult(message);
            if (message.subtype !== 'success')
            {
                throw new Error(`Clustering judge failed: ${message.subtype}`);
            }
            return clusterResponseSchema.parse(message.structured_output).clusters;
        }
    }
    throw new Error('The SDK stream ended without a result message.');
}
