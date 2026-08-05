// Cross-run merge: semantic clustering of findings from multiple reviews of
// the same target. Key-based identity is dead on arrival — the same defect
// recurs with different wording, angle, and line anchors — so identity is
// judged by a tool-less query(): no MCP servers, no built-ins, one turn,
// pure structured output. The judge proposes the partition; validating it
// is ours, same trust boundary as reviewSchema.parse in the review path.

import { query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { assertSubscriptionCredit } from '../review/review.js';
import type { Finding, Severity } from '../schema/schema.js';

// A finding as the merge sees it: the immutable fact plus its DB identity
// and which run produced it.
export interface MergeableFinding extends Finding
{
    id: number;
    runId: number;
}

export interface Cluster
{
    memberIds: number[];
    representativeId: number;
}

export const clusterResponseSchema = z.object({
    clusters: z.array(z.object({
        memberIds: z.array(z.number().int()).min(1)
            .describe('Finding ids that describe the same underlying defect'),
        representativeId: z.number().int()
            .describe('The member whose formulation is the sharpest and most complete'),
    })),
});

export const clusterResponseJsonSchema = z.toJSONSchema(clusterResponseSchema, { target: 'draft-7' });

const JUDGE_SYSTEM_PROMPT = `You are a code-review finding deduplicator. You receive findings collected from several independent review runs of the same branch diff.

Group findings that describe the same underlying defect into one cluster. Judge the defect, not the text: the same issue recurs across runs with different wording, a different angle of attack, different severity, and different line anchors. Two findings belong together only if fixing one would fix the other.

Rules:
- Every finding id appears in exactly one cluster.
- A finding with no counterpart stays in a cluster of its own.
- Never merge findings merely because they touch the same file or method.
- As representative, pick the member whose formulation is the sharpest and most complete.`;

export function buildJudgePrompt(findings: MergeableFinding[]): string
{
    const lines = findings.map(f =>
        `id ${f.id} (run ${f.runId}) [${f.severity}] ${f.file}${f.line !== undefined ? `:${f.line}` : ''} — ${f.title}\n${f.detail}`);
    return `Cluster these ${findings.length} findings.\n\n${lines.join('\n\n')}`;
}

// Returns a violation description, or undefined when the partition is valid.
export function validatePartition(findings: MergeableFinding[], clusters: Cluster[]): string | undefined
{
    const expected = new Set(findings.map(f => f.id));
    const seen = new Set<number>();

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

export function distinctRuns(findings: MergeableFinding[]): number
{
    return new Set(findings.map(f => f.runId)).size;
}

export interface ClusteringOptions
{
    model?: string;
}

export async function runClustering(findings: MergeableFinding[], opts: ClusteringOptions = {}): Promise<Cluster[]>
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

async function judgeOnce(prompt: string, opts: ClusteringOptions): Promise<Cluster[]>
{
    const stream = query({
        prompt,
        options: {
            systemPrompt: JUDGE_SYSTEM_PROMPT,
            model: opts.model,
            maxTurns: 1,
            tools: [],
            outputFormat: { type: 'json_schema', schema: clusterResponseJsonSchema },
        },
    });

    for await (const message of stream)
    {
        if (message.type === 'result')
        {
            if (message.subtype !== 'success')
            {
                throw new Error(`Clustering judge failed: ${message.subtype}`);
            }
            return clusterResponseSchema.parse(message.structured_output).clusters;
        }
    }
    throw new Error('The SDK stream ended without a result message.');
}
