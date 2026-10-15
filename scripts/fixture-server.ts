// A seeded, in-memory job server for dashboard development: the real HTTP
// surface over :memory: stores, no worker and no trigger attached — nothing
// polls, nothing runs, nothing can bill credit. Every job here is frozen in
// the state it was seeded with. Finding text and targets are invented.
//
//   npm run dashboard:fixture   (then npm run dashboard:dev beside it)

import { EventLog } from '../src/server/events.js';
import { JobStore } from '../src/server/jobs.js';
import { createServer } from '../src/server/server.js';
import { WatchStore } from '../src/server/trigger.js';
import { ReviewStore } from '../src/store/store.js';
import type { Finding, NewCluster } from '../src/store/store.js';
import type { NewFinding } from '../src/schema/schema.js';
import type { RunId } from '../src/types/ids.js';

const PORT = 4780;

const jobs = new JobStore(':memory:');
const watches = new WatchStore(':memory:');
const store = new ReviewStore(':memory:');

// ── watches ─────────────────────────────────────────────
watches.add({ owner: 'acme', repo: 'widgets', label: 'agent-review' });
watches.add({ owner: 'acme', repo: 'gadgets', label: 'agent-review' });

// ── run history for one well-reviewed target ────────────
const finding = (file: string, line: number, severity: NewFinding['severity'], title: string, detail: string, suggestion?: string): NewFinding =>
    ({ file, line, severity, title, detail, ...(suggestion !== undefined ? { suggestion } : {}) });

function seedRun(findings: NewFinding[], turns: number, costUsd: number): RunId
{
    return store.saveRun({
        owner: 'acme', repo: 'widgets', head: 'feature/retry-taxonomy', base: 'main',
        model: 'claude-opus-5', status: 'submitted',
        review: { summary: 'Reviewed the retry taxonomy branch.', findings },
        turns, costUsd,
        usage: { inputTokens: 900, outputTokens: 5200, cacheReadInputTokens: 1_400_000, cacheCreationInputTokens: 60_000 },
    });
}

const sharedTitle = '429 without Retry-After treated as terminal';
const runs = [
    seedRun([
        finding('src/client/retry.ts', 57, 'critical', sharedTitle,
            'classifyError falls through to the terminal branch when the header is missing.',
            'Default to exponential backoff when Retry-After is absent.'),
        finding('src/client/retry.ts', 83, 'warning', 'Backoff jitter synchronized across parallel calls',
            'The jitter seed resets per batch, so parallel retries re-collide.'),
    ], 31, 1.12),
    seedRun([
        finding('src/client/retry.ts', 56, 'critical', 'Missing retry on rate limit without header',
            'A 429 lacking Retry-After abandons the run instead of retrying.'),
        finding('src/client/transport.ts', 112, 'critical', 'Abort signal not propagated to in-flight fetch',
            'The AbortController is created but never passed to fetch; cancellation leaks the request.',
            'Pass { signal: controller.signal } in the fetch init.'),
    ], 27, 0.94),
    seedRun([
        finding('src/client/retry.ts', 57, 'critical', sharedTitle,
            'Terminal classification on missing Retry-After header.'),
        finding('src/errors/errors.ts', 66, 'warning', 'ECONNRESET mapped terminal instead of transient',
            'A mid-stream reset fails the job rather than retrying; intent unclear.'),
    ], 38, 1.31),
    seedRun([
        finding('src/loop/loop.ts', 29, 'warning', 'Possible off-by-one in maxTurns guard',
            'The guard may allow one turn beyond the budget.'),
    ], 24, 0.88),
    seedRun([
        finding('src/client/retry.ts', 57, 'critical', sharedTitle,
            'Missing-header 429s should be retried, not failed.'),
        finding('src/cli/review.ts', 14, 'nit', 'Stale comment references removed --stream flag',
            'The header comment contradicts the argument parser below it.'),
    ], 29, 1.07),
];

// ── one consolidation over those runs ───────────────────
const byTitle = new Map(runs.flatMap(run => store.getFindings(run).map(f => [`${f.runId}:${f.title}`, f] as const)));

function pick(run: RunId, title: string): Finding
{
    const found = byTitle.get(`${run}:${title}`);
    if (found === undefined)
    {
        throw new Error(`fixture bug: no finding "${title}" in run ${run}`);
    }
    return found;
}

const cluster = (members: Finding[], severity: NewCluster['severity']): NewCluster => ({
    memberIds: members.map(f => f.id),
    representativeId: members[0]!.id,
    severity,
    occurrence: new Set(members.map(f => f.runId)).size,
});

const consolidation = store.saveConsolidation({
    owner: 'acme', repo: 'widgets', head: 'feature/retry-taxonomy', base: 'main',
    runIds: runs,
    clusters: [
        cluster([pick(runs[0]!, sharedTitle), pick(runs[1]!, 'Missing retry on rate limit without header'), pick(runs[2]!, sharedTitle), pick(runs[4]!, sharedTitle)], 'critical'),
        cluster([pick(runs[1]!, 'Abort signal not propagated to in-flight fetch')], 'critical'),
        cluster([pick(runs[0]!, 'Backoff jitter synchronized across parallel calls')], 'warning'),
        cluster([pick(runs[2]!, 'ECONNRESET mapped terminal instead of transient')], 'warning'),
        cluster([pick(runs[3]!, 'Possible off-by-one in maxTurns guard')], 'warning'),
        cluster([pick(runs[4]!, 'Stale comment references removed --stream flag')], 'nit'),
    ],
});

const clusters = store.getConsolidation(consolidation)!.clusters;
const clusterOf = (title: string) => clusters.find(c => c.representative.title === title)!;

store.saveVerification({
    source: 'agent',
    clusterId: clusterOf('Abort signal not propagated to in-flight fetch').id,
    verdict: 'confirmed',
    rationale: 'The controller is constructed at transport.ts:98 and referenced nowhere else; the fetch init demonstrably lacks a signal key.',
    confidence: 'High — the refutation attempt found positive evidence for the finding instead.',
    costUsd: 0.42,
});
store.saveVerification({
    source: 'agent',
    clusterId: clusterOf('Possible off-by-one in maxTurns guard').id,
    verdict: 'refuted',
    rationale: 'The counter increments before the guard and a test pins the boundary: a budget of 3 yields exactly 3 turns.',
    confidence: 'High — the boundary behavior is directly asserted by an existing test.',
    costUsd: 0.31,
});
store.saveVerification({
    source: 'agent',
    clusterId: clusterOf('ECONNRESET mapped terminal instead of transient').id,
    verdict: 'undetermined',
    rationale: 'The mapping is real and untested, but a reset after a captured result may be deliberately terminal. Design intent is not recoverable from the code.',
    confidence: 'Needs a human who knows the intent.',
    costUsd: 0.38,
});

// ── the campaign record those runs came from ────────────
// Rounds are as-it-happened snapshots: round 1 has no consolidation (one
// run is below the union guard), later rounds carry the estimate the loop
// saw. f2 stays 0 here, so the coverage tail is the bias-corrected form.
const target = { owner: 'acme', repo: 'widgets', head: 'feature/retry-taxonomy', base: 'main' } as const;

const campaign = store.createCampaign(target);
const novelPerRound = [0, 1, 1, 1, 1];
const observedPerRound = [0, 3, 4, 5, 6];
runs.forEach((run, i) =>
{
    const observed = observedPerRound[i]!;
    const f1 = Math.max(0, observed - 1);
    const undiscovered = (f1 * (f1 - 1)) / 2;
    const stored = store.getRun(run)!;
    store.appendCampaignRound(campaign, {
        round: i + 1,
        runId: run,
        findings: stored.review?.findings.length ?? 0,
        turns: stored.turns,
        costUsd: stored.costUsd,
        novelClusters: novelPerRound[i]!,
        ...(i > 0
            ? {
                consolidationId: consolidation,
                coverage: { observed, f1, f2: 0, undiscovered, estimatedTotal: observed + undiscovered },
            }
            : {}),
    });
});
store.finishCampaign(campaign, 'max-runs');

// A CLI-shaped campaign: a running record with no job carrying it (round 1
// still in flight, nothing appended yet). This is what the sheet's
// campaign-record liveness path renders — pulses and gates without any job.
// Marked leased, the normal healthy shape (unproven rows render the
// force-fail hint instead).
store.markCampaignLeased(store.createCampaign({ owner: 'acme', repo: 'gadgets', head: 'feature/uploads', base: 'develop' }));

// ── a queue in every state ──────────────────────────────
const done = jobs.enqueue({ kind: 'campaign', ...target, params: { maxRuns: 5, verify: true } });
jobs.claimNext();
jobs.recordCampaign(done, campaign);
for (const run of runs)
{
    jobs.recordRun(done, run);
}
jobs.succeed(done, { consolidationId: consolidation });

const failed = jobs.enqueue({ kind: 'review', owner: 'acme', repo: 'gadgets', head: 'fix/dedupe', base: 'develop', params: {} });
jobs.claimNext();
jobs.fail(failed, 'Terminal: branch not found.');

const cancelled = jobs.enqueue({ kind: 'review', owner: 'acme', repo: 'widgets', head: 'feature/old-idea', base: 'main', params: {} });
jobs.cancel(cancelled);

const aborted = jobs.enqueue({ kind: 'review', ...target, params: { maxTurns: 20 } });
jobs.claimNext();
jobs.abort(aborted, 'error_max_turns');

const running = jobs.enqueue({ kind: 'campaign', ...target, params: { maxRuns: 5, verify: true } });
jobs.claimNext();
jobs.recordRun(running, runs[0]!);

jobs.enqueue({ kind: 'review', owner: 'acme', repo: 'gadgets', head: 'feature/uploads', base: 'develop', params: {} });
jobs.enqueue({ kind: 'review', owner: 'acme', repo: 'widgets', head: 'slice-9-trigger', base: 'main', params: {} });

// ── serve ───────────────────────────────────────────────
// A pollerless activity feed with a few staged lines, so the panel has
// something to render during UI work.
const activityLog = new EventLog();
activityLog.push('server', 'fixture server started — in-memory, no worker, no trigger');
activityLog.push('trigger', 'poll pass: 1 watch(es) — 0 enqueued, 2 seen before, 0 deferred');
activityLog.push('worker', 'job #3: run saved as #2 (submitted, 5 findings)');
const server = createServer({ jobs, watches, store, activity: { log: activityLog, poll: () => ({ polling: false }) } });
server.listen(PORT, '127.0.0.1', () =>
{
    console.log(`fixture server on http://127.0.0.1:${PORT} — in-memory, no worker, no trigger, no credit`);
});
