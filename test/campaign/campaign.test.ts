import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { campaignCost, clusterGrowth, runCampaign } from '../../src/campaign/campaign.js';
import type { CampaignResult, RoundOutcome } from '../../src/campaign/campaign.js';
import { ClusteringError } from '../../src/consolidate/consolidate.js';
import type { RepoClient } from '../../src/github/github.js';
import { LENSES } from '../../src/review/lenses.js';
import type { ReviewResult, ReviewRunOptions } from '../../src/review/review.js';
import type { NewFinding } from '../../src/schema/schema.js';
import { ReviewStore } from '../../src/store/store.js';
import type { Consolidation, Run } from '../../src/store/store.js';
import type { Target } from '../../src/types/target.js';
import { consolidationId, runId } from '../../src/types/ids.js';
import type { VerifyPendingSummary } from '../../src/verify/verify.js';

function round(n: number, overrides: Partial<RoundOutcome> = {}): RoundOutcome
{
    return {
        round: n,
        runId: runId(100 + n),
        findings: 5,
        turns: 28,
        costUsd: 2.5,
        consolidationId: consolidationId(n),
        novelClusters: 0,
        ...overrides,
    };
}

function abortedRound(n: number): RoundOutcome
{
    return {
        round: n,
        runId: runId(100 + n),
        findings: 0,
        turns: 20,
        costUsd: 1.25,
        aborted: 'error_max_turns',
        novelClusters: 0,
    };
}

function failedRound(n: number): RoundOutcome
{
    return { round: n, findings: 0, turns: 0, costUsd: 0, failed: 'GitHub API 502', novelClusters: 0 };
}

// ── the loop itself, on a real store with injected runners ──────────────

const fakeClient: RepoClient = {
    compare: async () => [],
    readFile: async () => '',
    listFiles: async () => ({ paths: [], truncated: false }),
};

const target: Target = { owner: 'acme', repo: 'widgets', head: 'feature-x', base: 'main' };

const ZERO = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };

function submittedResult(findings: NewFinding[]): ReviewResult
{
    return {
        status: 'submitted',
        review: { summary: 'test', findings },
        filesChanged: 2,
        stats: { turns: 5, costUsd: 2.5, usage: ZERO, perModel: {}, turnUsage: [], compactions: 0 },
    };
}

function finding(title: string): NewFinding
{
    return { file: 'src/a.ts', severity: 'warning', title, detail: `detail of ${title}` };
}

// A judge stand-in: one singleton cluster per finding, saved for real, with
// a fixed judge cost — everything the loop reads (novelClusters, coverage,
// judgeCostUsd) comes off genuine store rows.
function identityConsolidate(judgeCostUsd = 0.1)
{
    return async (store: ReviewStore, t: Target, runs: Run[]): Promise<Consolidation | undefined> =>
    {
        const findings = runs.flatMap(r => store.getFindings(r.id));
        if (findings.length === 0)
        {
            return undefined;
        }
        const id = store.saveConsolidation({
            ...t,
            runIds: runs.map(r => r.id),
            costUsd: judgeCostUsd,
            clusters: findings.map(f => ({ memberIds: [f.id], representativeId: f.id, severity: f.severity, occurrence: 1 })),
        });
        return store.getConsolidation(id)!;
    };
}

const noVerify = async (): Promise<VerifyPendingSummary> => ({ queued: 0, attempted: 0, verified: 0, failures: 0, costUsd: 0 });

let store: ReviewStore;

beforeEach(() =>
{
    store = new ReviewStore(':memory:');
});

afterEach(() =>
{
    store.close();
});

describe('runCampaign', () =>
{
    it('should stop after patience barren rounds and still consolidate and verify', async () =>
    {
        // Arrange: round 1 finds two things, later rounds find nothing —
        // novelClusters goes 0 for two consecutive consolidated rounds.
        let round = 0;
        const review = async (): Promise<ReviewResult> =>
        {
            round++;
            return submittedResult(round === 1 ? [finding('a'), finding('b')] : []);
        };
        const verify = vi.fn(noVerify);

        // Act
        const campaign = await runCampaign(store, fakeClient, target, {
            maxRuns: 5,
            verify: true,
            runners: { review, consolidate: identityConsolidate(), verifyPending: verify },
        });

        // Assert: the cap never decided — discovery drying up did. Round 1
        // has no consolidation (one run is not a union), so the two barren
        // rounds are 2 and 3.
        expect(campaign.stoppedBy).toBe('dry');
        expect(campaign.rounds).toHaveLength(3);
        expect(campaign.rounds[0]?.consolidationId).toBeUndefined();
        expect(campaign.rounds.at(-1)?.novelClusters).toBe(0);
        expect(campaign.consolidationId).toBeDefined();
        expect(campaign.runIds).toHaveLength(3);
        expect(verify).toHaveBeenCalledTimes(1);
    });

    it('should stop after two consecutive unusable rounds without discarding anything', async () =>
    {
        // Arrange: a throw and an abort in a row — different failures, same
        // structural signal.
        let round = 0;
        const review = async (): Promise<ReviewResult> =>
        {
            round++;
            if (round === 1)
            {
                throw new Error('GitHub 502');
            }
            return {
                status: 'aborted', reason: 'error_max_turns', filesChanged: 2,
                stats: { turns: 40, costUsd: 1.0, usage: ZERO, perModel: {}, turnUsage: [], compactions: 0 },
            };
        };
        const verify = vi.fn(noVerify);

        // Act
        const campaign = await runCampaign(store, fakeClient, target, {
            maxRuns: 5,
            verify: true,
            runners: { review, consolidate: identityConsolidate(), verifyPending: verify },
        });

        // Assert: the aborted run is stored (it billed), the failed one is
        // not, and nothing was consolidated or verified.
        expect(campaign.stoppedBy).toBe('no-usable-runs');
        expect(campaign.rounds).toHaveLength(2);
        expect(campaign.rounds[0]).toMatchObject({ failed: 'GitHub 502' });
        expect(campaign.rounds[1]).toMatchObject({ aborted: 'error_max_turns' });
        expect(campaign.consolidationId).toBeUndefined();
        expect(verify).not.toHaveBeenCalled();
    });

    it('should salvage the campaign when the judge fails mid-round: paid rounds keep their product', async () =>
    {
        // Arrange: every round finds something; the judge works for round 2's
        // consolidation and dies on round 3's.
        let round = 0;
        const review = async (): Promise<ReviewResult> =>
        {
            round++;
            return submittedResult([finding(`round-${round}`)]);
        };
        const working = identityConsolidate(0.25);
        let judgeCalls = 0;
        const consolidate = async (s: ReviewStore, t: Target, runs: Run[]): Promise<Consolidation | undefined> =>
        {
            judgeCalls++;
            if (judgeCalls === 2)
            {
                throw new ClusteringError('judge 502', 0.15);
            }
            return working(s, t, runs);
        };
        const captured: Consolidation[] = [];
        const verify = vi.fn(async (_s: ReviewStore, _c: RepoClient, consolidation: Consolidation) =>
        {
            captured.push(consolidation);
            return { queued: 0, attempted: 0, verified: 0, failures: 0, costUsd: 0 };
        });

        // Act
        const campaign = await runCampaign(store, fakeClient, target, {
            maxRuns: 3,
            verify: true,
            runners: { review, consolidate, verifyPending: verify },
        });

        // Assert: round 3 records the judge failure and stays out of the
        // stopping rule's input; the campaign's product is round 2's
        // consolidation, which is also what verification ran on. The failed
        // judge attempt's own spend rides its error into the total.
        expect(campaign.stoppedBy).toBe('max-runs');
        expect(campaign.rounds[2]).toMatchObject({ consolidationFailed: 'judge 502' });
        expect(campaign.rounds[2]?.consolidationId).toBeUndefined();
        expect(campaign.consolidationId).toBe(captured[0]?.id);
        expect(campaign.judgeCostUsd).toBeCloseTo(0.25 + 0.15);
        expect(campaign.runIds).toHaveLength(2);
        expect(verify).toHaveBeenCalledTimes(1);
    });

    it('should rotate lens and model per round and record both on the stored run', async () =>
    {
        // Arrange: capture exactly what each round asks the reviewer for.
        let n = 0;
        const seen: ReviewRunOptions[] = [];
        const review = async (_c: RepoClient, _t: unknown, reviewOpts: ReviewRunOptions = {}): Promise<ReviewResult> =>
        {
            seen.push(reviewOpts);
            n++;
            return submittedResult([finding(`round-${n}`)]);
        };

        // Act
        const campaign = await runCampaign(store, fakeClient, target, {
            maxRuns: 3,
            models: ['model-a', 'model-b'],
            verify: false,
            runners: { review, consolidate: identityConsolidate() },
        });

        // Assert: round 1 is the generalist baseline, later rounds take the
        // next lens; models cycle independently on their own shorter list.
        expect(seen.map(o => o.lens?.name)).toEqual([undefined, LENSES[0]?.name, LENSES[1]?.name]);
        expect(seen.map(o => o.model)).toEqual(['model-a', 'model-b', 'model-a']);

        // The run rows carry the same rotation — occurrence downstream can
        // read cross-model agreement only if the model is recorded per run.
        const stored = campaign.rounds.map(r => store.getRun(r.runId!)!);
        expect(stored.map(r => r.model)).toEqual(['model-a', 'model-b', 'model-a']);
        expect(stored.map(r => r.lens)).toEqual([undefined, LENSES[0]?.name, LENSES[1]?.name]);
        expect(campaign.rounds.map(r => r.lens)).toEqual([undefined, LENSES[0]?.name, LENSES[1]?.name]);
    });

    it('should report a baseline consolidation failure instead of swallowing it', async () =>
    {
        // Arrange: two stored runs make the baseline eligible, and the judge
        // dies on it — often the first symptom of a misconfiguration that
        // will hit every round too. The campaign proceeds; the operator hears.
        for (const title of ['a', 'b'])
        {
            store.saveRun({
                ...target, model: 'm', status: 'submitted',
                review: { summary: 't', findings: [finding(title)] },
                turns: 5, costUsd: 1, usage: ZERO,
            });
        }
        let calls = 0;
        const consolidate = async (s: ReviewStore, t: Target, runs: Run[]): Promise<Consolidation | undefined> =>
        {
            calls++;
            if (calls === 1)
            {
                throw new Error('judge auth broken');
            }
            return identityConsolidate()(s, t, runs);
        };
        const baselineFailures: string[] = [];

        // Act
        const campaign = await runCampaign(store, fakeClient, target, {
            maxRuns: 1,
            verify: false,
            onBaselineFailed: error => baselineFailures.push(error),
            runners: { review: async () => submittedResult([]), consolidate },
        });

        // Assert
        expect(baselineFailures).toEqual(['judge auth broken']);
        expect(campaign.rounds).toHaveLength(1);
    });

    it('should stop between rounds when asked, keeping paid rounds and skipping paid verification', async () =>
    {
        // Arrange: the stop signal flips while round 1 is billing — the
        // shape of a SIGTERM landing mid-campaign.
        let stopping = false;
        const review = async (): Promise<ReviewResult> =>
        {
            stopping = true;
            return submittedResult([finding('round-1')]);
        };
        const verify = vi.fn(noVerify);

        // Act
        const campaign = await runCampaign(store, fakeClient, target, {
            maxRuns: 5,
            verify: true,
            shouldStop: () => stopping,
            runners: { review, consolidate: identityConsolidate(), verifyPending: verify },
        });

        // Assert: round 1 completed and saved (its credit was already
        // committed), no round 2 fired, and the verification pass — its own
        // string of paid calls — never started.
        expect(campaign.stoppedBy).toBe('stopped');
        expect(campaign.rounds).toHaveLength(1);
        expect(campaign.rounds[0]?.runId).toBeDefined();
        expect(verify).not.toHaveBeenCalled();
    });

    // A stored submitted run for the target: with it, one campaign round is
    // enough for consolidateTarget's two-run minimum, so `latest` exists and
    // the closing verification gate is actually reached.
    function seedStoredRun(): void
    {
        store.saveRun({
            ...target, model: 'm', status: 'submitted',
            review: { summary: 't', findings: [finding('stored')] },
            turns: 5, costUsd: 1, usage: ZERO,
        });
    }

    it('should surface a shutdown during the final round as stopped: the cut-short verification is not a completed plan', async () =>
    {
        // Arrange: the signal lands while the last planned round is billing —
        // the loop exits by the run cap, never seeing the signal itself. The
        // verify runner behaves like the real one: with the signal up and a
        // non-empty queue, it stops at the first boundary, billing nothing.
        seedStoredRun();
        let stopping = false;
        const review = async (): Promise<ReviewResult> =>
        {
            stopping = true;
            return submittedResult([finding('round-1')]);
        };
        const verify = vi.fn(async (_s: ReviewStore, _c: RepoClient, _con: Consolidation, o?: { shouldStop?: () => boolean }): Promise<VerifyPendingSummary> =>
            ({ queued: 2, attempted: 0, verified: 0, failures: 0, costUsd: 0, ...(o?.shouldStop?.() === true ? { stopped: true } : {}) }));

        // Act
        const campaign = await runCampaign(store, fakeClient, target, {
            maxRuns: 1,
            verify: true,
            shouldStop: () => stopping,
            runners: { review, consolidate: identityConsolidate(), verifyPending: verify },
        });

        // Assert: the pass was entered (the per-cluster guard is what bills
        // nothing), came back cut short, and the campaign says so instead of
        // reading 'max-runs' (rev 17).
        expect(campaign.stoppedBy).toBe('stopped');
        expect(verify).toHaveBeenCalledTimes(1);
        expect(campaign.verification).toMatchObject({ queued: 2, attempted: 0, stopped: true });
    });

    it('should stay a completed plan when the shutdown lands after the last round but nothing was left to verify', async () =>
    {
        // Arrange: same signal timing, but the queue is empty — every
        // cluster already corroborated or settled. Reporting 'stopped'
        // here would tell the operator work was cut short when none was.
        seedStoredRun();
        let stopping = false;
        const review = async (): Promise<ReviewResult> =>
        {
            stopping = true;
            return submittedResult([finding('round-1')]);
        };
        const verify = vi.fn(noVerify);

        // Act
        const campaign = await runCampaign(store, fakeClient, target, {
            maxRuns: 1,
            verify: true,
            shouldStop: () => stopping,
            runners: { review, consolidate: identityConsolidate(), verifyPending: verify },
        });

        // Assert
        expect(campaign.stoppedBy).toBe('max-runs');
        expect(campaign.verification).toMatchObject({ queued: 0, attempted: 0 });
    });

    it('should mark the campaign stopped when the verification pass itself is cut short mid-queue', async () =>
    {
        // Arrange: the signal arrives after the rounds are done, while the
        // closing verification is walking its per-cluster paid calls.
        seedStoredRun();
        const review = async (): Promise<ReviewResult> => submittedResult([finding('round-1')]);
        const verify = vi.fn(async (): Promise<VerifyPendingSummary> =>
            ({ queued: 3, attempted: 1, verified: 1, failures: 0, costUsd: 0.5, stopped: true }));

        // Act
        const campaign = await runCampaign(store, fakeClient, target, {
            maxRuns: 1,
            verify: true,
            shouldStop: () => false,
            runners: { review, consolidate: identityConsolidate(), verifyPending: verify },
        });

        // Assert: the partial summary is kept (its verdicts billed and
        // saved), and the plan still reads as cut short.
        expect(campaign.stoppedBy).toBe('stopped');
        expect(campaign.verification).toMatchObject({ verified: 1, stopped: true });
    });

    it('should hand its stop signal to the verification pass', async () =>
    {
        // Arrange
        seedStoredRun();
        const shouldStop = (): boolean => false;
        let received: unknown;
        const verify = vi.fn(async (_s: ReviewStore, _c: RepoClient, _con: Consolidation, verifyOpts?: { shouldStop?: () => boolean }): Promise<VerifyPendingSummary> =>
        {
            received = verifyOpts?.shouldStop;
            return { queued: 0, attempted: 0, verified: 0, failures: 0, costUsd: 0 };
        });

        // Act
        await runCampaign(store, fakeClient, target, {
            maxRuns: 1,
            verify: true,
            shouldStop,
            runners: { review: async () => submittedResult([finding('a')]), consolidate: identityConsolidate(), verifyPending: verify },
        });

        // Assert
        expect(received).toBe(shouldStop);
    });

    it('should keep every round identical when lenses are off and one model is given', async () =>
    {
        // Arrange
        const seen: ReviewRunOptions[] = [];
        const review = async (_c: RepoClient, _t: unknown, reviewOpts: ReviewRunOptions = {}): Promise<ReviewResult> =>
        {
            seen.push(reviewOpts);
            return submittedResult([]);
        };

        // Act
        await runCampaign(store, fakeClient, target, {
            maxRuns: 2,
            model: 'model-a',
            rotateLenses: false,
            verify: false,
            runners: { review, consolidate: identityConsolidate() },
        });

        // Assert: the pre-rotation behavior is still reachable, exactly.
        expect(seen.map(o => o.lens)).toEqual([undefined, undefined]);
        expect(seen.map(o => o.model)).toEqual(['model-a', 'model-a']);
    });
});

describe('clusterGrowth', () =>
{
    it('should report new clusters per consolidated round', () =>
    {
        // Arrange
        const rounds = [round(1, { novelClusters: 3 }), round(2, { novelClusters: 1 })];

        // Act
        const growth = clusterGrowth(rounds);

        // Assert
        expect(growth).toEqual([{ round: 1, novelClusters: 3 }, { round: 2, novelClusters: 1 }]);
    });

    it('should exclude aborted rounds, which say nothing about saturation', () =>
    {
        // Arrange
        const rounds = [round(1, { novelClusters: 2 }), abortedRound(2), round(3, { novelClusters: 1 })];

        // Act
        const growth = clusterGrowth(rounds);

        // Assert
        expect(growth.map(g => g.round)).toEqual([1, 3]);
    });

    it('should exclude rounds that threw before producing a run', () =>
    {
        // Arrange
        const rounds = [round(1, { novelClusters: 2 }), failedRound(2)];

        // Act
        const growth = clusterGrowth(rounds);

        // Assert
        expect(growth.map(g => g.round)).toEqual([1]);
    });
});

describe('campaignCost', () =>
{
    it('should roll up review, judge, and verification costs separately', () =>
    {
        // Arrange
        const campaign: CampaignResult = {
            rounds: [round(1), round(2)],
            consolidationId: consolidationId(2),
            runIds: [runId(101), runId(102)],
            reviewCostUsd: 5,
            judgeCostUsd: 0.4,
            verification: { queued: 3, attempted: 3, verified: 3, failures: 0, costUsd: 2.5 },
            stoppedBy: 'dry',
        };

        // Act
        const cost = campaignCost(campaign);

        // Assert
        expect(cost).toEqual({ reviews: 5, judge: 0.4, verification: 2.5, total: 7.9 });
    });

    it('should count verification as free when it was skipped', () =>
    {
        // Arrange
        const campaign: CampaignResult = {
            rounds: [round(1)],
            consolidationId: consolidationId(1),
            runIds: [runId(101)],
            reviewCostUsd: 2.5,
            judgeCostUsd: 0,
            stoppedBy: 'max-runs',
        };

        // Act
        const cost = campaignCost(campaign);

        // Assert
        expect(cost).toEqual({ reviews: 2.5, judge: 0, verification: 0, total: 2.5 });
    });
});
