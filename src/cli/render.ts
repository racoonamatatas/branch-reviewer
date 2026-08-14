// Shared output rendering for the review and history entry points.
// Moved verbatim from cli.ts when history.ts arrived; console.log here is
// the product's stdout, not debug output.

import type { ReviewRunStats } from '../review/review.js';
import type { Review, Severity } from '../schema/schema.js';
import type { Cluster, Consolidation, Verdict } from '../store/store.js';
import type { TokenUsage } from '../usage/usage.js';
import type { VerificationResponse, VerificationStats } from '../verify/verify.js';

const SEVERITY_ORDER: Severity[] = ['critical', 'warning', 'nit'];

// "undetermined" is a verdict about reachability, not about the finding —
// the report tells the reader what to do with it.
const STATUS_LABEL: Record<Verdict, string> = {
    confirmed: 'confirmed',
    refuted: 'refuted',
    undetermined: 'needs human eyes',
};

export function n(value: number): string
{
    return value.toLocaleString('en-US');
}

export function usageLine(usage: TokenUsage): string
{
    return `${n(usage.inputTokens)} fresh + ${n(usage.cacheReadInputTokens)} cache-read`
        + ` + ${n(usage.cacheCreationInputTokens)} cache-write in / ${n(usage.outputTokens)} out`;
}

export function printStats(stats: ReviewRunStats, verbose: boolean): void
{
    console.log(`\ntokens: ${usageLine(stats.usage)}, ${stats.turns} turn(s), `
        + `$${stats.costUsd.toFixed(4)} (reported; subscription runs are not billed per-token)`);

    for (const [model, m] of Object.entries(stats.perModel))
    {
        console.log(`  ${model}: ${n(m.inputTokens)} fresh + ${n(m.cacheReadInputTokens)} cache-read`
            + ` + ${n(m.cacheCreationInputTokens)} cache-write in / ${n(m.outputTokens)} out,`
            + ` $${m.costUSD.toFixed(4)}, context window ${n(m.contextWindow)}`);
    }

    if (stats.compactions > 0)
    {
        console.log(`  ${stats.compactions} auto-compaction(s) during the run — context was rewritten mid-review`);
    }

    if (verbose)
    {
        console.log('\nper-turn usage (streamed, deduped by message id):');
        for (const turn of stats.turnUsage)
        {
            console.log(`  ${turn.messageId}  ${usageLine(turn.usage)}`);
        }
    }
}

// The verification loop reports by callback so it never writes to stdout;
// this is the shared stdout half, used by both the verify and campaign entry
// points so a verdict reads identically wherever it was produced.
export function printVerdictProgress(indent = '  '): {
    onCluster: (cluster: Cluster) => void;
    onVerdict: (cluster: Cluster, response: VerificationResponse, stats: VerificationStats) => void;
    onFailure: (cluster: Cluster, reason: string) => void;
    onProgress: (event: string) => void;
}
{
    return {
        onCluster: (cluster) =>
        {
            const f = cluster.representative;
            console.log(`\n${indent}--- cluster #${cluster.id}: [${cluster.severity}] ${f.file} — ${f.title}`);
        },
        onVerdict: (_cluster, response, stats) =>
        {
            console.log(`${indent}verdict: ${response.verdict} ($${stats.costUsd.toFixed(4)}, ${stats.turns} turn(s))`);
            console.log(`${indent}rationale: ${response.rationale}`);
            console.log(`${indent}confidence: ${response.confidence}`);
        },
        onFailure: (_cluster, reason) =>
        {
            console.error(`${indent}verification did not complete: ${reason} — cluster stays pending`);
        },
        onProgress: (event) =>
        {
            console.log(`${indent}${event}`);
        },
    };
}

export function printConsolidation(consolidation: Consolidation): void
{
    const totalRuns = consolidation.runIds.length;
    console.log(`\nconsolidation #${consolidation.id}  ${consolidation.createdAt}  ${consolidation.owner}/${consolidation.repo} "${consolidation.head}" against "${consolidation.base}"`);
    console.log(`consolidated runs: [${consolidation.runIds.join(', ')}] — ${consolidation.clusters.length} distinct finding(s)\n`);

    const sorted = [...consolidation.clusters].sort((a, b) =>
        SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
        || b.occurrence - a.occurrence);

    for (const cluster of sorted)
    {
        const f = cluster.representative;
        const line = f.line !== undefined ? `:${f.line}` : '';
        const confidence = f.confidence !== undefined ? `, reviewer confidence ${f.confidence}` : '';
        const unverified = cluster.occurrence === 1 && cluster.verificationStatus === 'pending'
            ? ', unverified'
            : '';
        const status = cluster.verificationStatus !== 'pending' ? `, ${STATUS_LABEL[cluster.verificationStatus]}` : '';
        console.log(`[${cluster.severity}] ${f.file}${line} — ${f.title} (seen in ${cluster.occurrence}/${totalRuns} runs${confidence}${unverified}${status})`);
        console.log(`    ${f.detail}`);
        if (f.suggestion !== undefined)
        {
            console.log(`    suggestion: ${f.suggestion}`);
        }
        if (cluster.members.length > 1)
        {
            const others = cluster.members.filter(m => m.id !== f.id);
            console.log(`    also reported as: ${others.map(m => `"${m.title}" (run ${m.runId})`).join('; ')}`);
        }
        console.log('');
    }
}

export function printReview(review: Review): void
{
    console.log(`\n${review.summary}\n`);
    if (review.findings.length === 0)
    {
        console.log('No findings.');
        return;
    }
    for (const severity of SEVERITY_ORDER)
    {
        for (const f of review.findings.filter(x => x.severity === severity))
        {
            const line = f.line !== undefined ? `:${f.line}` : '';
            const confidence = f.confidence !== undefined ? ` (confidence: ${f.confidence})` : '';
            console.log(`[${f.severity}] ${f.file}${line} — ${f.title}${confidence}`);
            console.log(`    ${f.detail}`);
            if (f.suggestion !== undefined)
            {
                console.log(`    suggestion: ${f.suggestion}`);
            }
            console.log('');
        }
    }
}
