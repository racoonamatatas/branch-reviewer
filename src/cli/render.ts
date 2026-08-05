// Shared output rendering for the review and history entry points.
// Moved verbatim from cli.ts when history.ts arrived; console.log here is
// the product's stdout, not debug output.

import type { ReviewRunStats } from '../review/review.js';
import type { Review, Severity } from '../schema/schema.js';
import type { StoredMerge } from '../store/store.js';
import { diffUsage, isZeroUsage } from '../usage/usage.js';
import type { TokenUsage } from '../usage/usage.js';

const SEVERITY_ORDER: Severity[] = ['critical', 'warning', 'nit'];

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

    // Observational reconciliation: our streamed sum vs the SDK's totals.
    // A delta is information about what the SDK counts that the stream does
    // not show — it never affects the review or the exit code.
    const delta = diffUsage(stats.usage, stats.streamed);
    if (!isZeroUsage(delta))
    {
        console.log(`  warning: SDK totals differ from streamed sum by ${usageLine(delta)}`);
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

export function printMerge(merge: StoredMerge): void
{
    const totalRuns = merge.runIds.length;
    console.log(`\nmerge #${merge.id}  ${merge.createdAt}  ${merge.owner}/${merge.repo} "${merge.head}" against "${merge.base}"`);
    console.log(`merged runs: [${merge.runIds.join(', ')}] — ${merge.clusters.length} distinct finding(s)\n`);

    const sorted = [...merge.clusters].sort((a, b) =>
        SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
        || b.occurrence - a.occurrence);

    for (const cluster of sorted)
    {
        const f = cluster.representative;
        const line = f.line !== undefined ? `:${f.line}` : '';
        const unverified = cluster.occurrence === 1 && cluster.verificationStatus === 'pending'
            ? ', unverified'
            : '';
        const status = cluster.verificationStatus !== 'pending' ? `, ${cluster.verificationStatus}` : '';
        console.log(`[${cluster.severity}] ${f.file}${line} — ${f.title} (seen in ${cluster.occurrence}/${totalRuns} runs${unverified}${status})`);
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
            console.log(`[${f.severity}] ${f.file}${line} — ${f.title}`);
            console.log(`    ${f.detail}`);
            if (f.suggestion !== undefined)
            {
                console.log(`    suggestion: ${f.suggestion}`);
            }
            console.log('');
        }
    }
}
