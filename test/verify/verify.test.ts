import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepoClient } from '../../src/github/github.js';
import type { NewFinding } from '../../src/schema/schema.js';
import { ReviewStore } from '../../src/store/store.js';
import type { Cluster, Consolidation, Finding, NewRun, Run, VerificationStatus } from '../../src/store/store.js';
import type { Target } from '../../src/types/target.js';
import { clusterId, findingId, runId } from '../../src/types/ids.js';
import { buildVerificationPrompt, verificationQueue, verificationResponseSchema, verifyPending, verifyTarget } from '../../src/verify/verify.js';
import type { VerifyResult } from '../../src/verify/verify.js';

function finding(id: number, run: number, overrides: Partial<Finding> = {}): Finding
{
    return {
        id: findingId(id),
        runId: runId(run),
        file: 'src/a.ts',
        line: 10,
        severity: 'warning',
        title: `Finding ${id}`,
        detail: `Detail ${id}`,
        ...overrides,
    };
}

function cluster(id: number, occurrence: number, overrides: Partial<Cluster> = {}): Cluster
{
    const representative = overrides.representative ?? finding(id, 100);
    return {
        id: clusterId(id),
        severity: representative.severity,
        occurrence,
        verificationStatus: 'pending',
        representative,
        members: [representative],
        ...overrides,
    };
}

describe('buildVerificationPrompt', () =>
{
    it('should carry provenance: cluster id, source run, and occurrence stated as fact', () =>
    {
        // Arrange
        const singleton = cluster(19, 1, { representative: finding(7, 4) });

        // Act
        const prompt = buildVerificationPrompt(singleton, 4);

        // Assert: "reported by 1 of 4", not "only 1 of 4" — the odds are
        // evidence, not a nudge toward refutation.
        expect(prompt).toContain('cluster #19, reported by 1 of 4 independent review runs of this branch (representative from run #4)');
    });

    it('should show every member phrasing and the reviewer confidence', () =>
    {
        // Arrange
        const rep = finding(7, 4, { confidence: 'low' });
        const echo = finding(9, 5, { file: 'src/b.ts', line: 22, title: 'Same defect, other angle' });
        const merged = cluster(19, 2, { representative: rep, members: [rep, echo] });

        // Act
        const prompt = buildVerificationPrompt(merged, 4);

        // Assert
        expect(prompt).toContain('reviewer confidence: low');
        expect(prompt).toContain('Other runs reported the same defect as:');
        expect(prompt).toContain('- (run #5) src/b.ts:22 — Same defect, other angle: Detail 9');
    });

    it('should omit the members section for a singleton', () =>
    {
        // Act
        const prompt = buildVerificationPrompt(cluster(1, 1), 2);

        // Assert
        expect(prompt).not.toContain('Other runs reported');
    });

    it('should include severity, location, title, detail and suggestion', () =>
    {
        // Arrange
        const withSuggestion = cluster(3, 1, {
            representative: finding(3, 100, { suggestion: 'Paginate the query.' }),
        });

        // Act
        const prompt = buildVerificationPrompt(withSuggestion, 4);

        // Assert
        expect(prompt).toContain('[warning] src/a.ts:10 — Finding 3');
        expect(prompt).toContain('Detail 3');
        expect(prompt).toContain('suggestion: Paginate the query.');
    });

    it('should omit the line anchor and suggestion when absent', () =>
    {
        // Arrange
        const bare = cluster(3, 1, { representative: finding(3, 100, { line: undefined }) });

        // Act
        const prompt = buildVerificationPrompt(bare, 4);

        // Assert
        expect(prompt).toContain('src/a.ts — Finding 3');
        expect(prompt).not.toContain('suggestion:');
    });

    it('should present a lapsed verdict as context, not as the answer', () =>
    {
        // Arrange
        const merged = cluster(5, 2, { lapsedVerdict: 'refuted' });

        // Act
        const prompt = buildVerificationPrompt(merged, 3);

        // Assert
        expect(prompt).toContain('An earlier adjudication of part of this group ended "refuted"');
        expect(prompt).toContain('settle the whole group afresh');
    });

    it('should end with the symmetric settle instruction', () =>
    {
        // Act
        const prompt = buildVerificationPrompt(cluster(1, 1), 2);

        // Assert
        expect(prompt).toMatch(/Settle this finding against the diff and the repository, then give your verdict\.$/);
    });
});

describe('verificationQueue', () =>
{
    it('should keep only pending occurrence-1 clusters', () =>
    {
        // Arrange
        const clusters = [cluster(1, 1), cluster(2, 3), cluster(3, 1)];

        // Act
        const selected = verificationQueue(clusters);

        // Assert
        expect(selected.map(c => c.id)).toEqual([clusterId(1), clusterId(3)]);
    });

    it('should drop occurrence-1 clusters that already have a verdict', () =>
    {
        // Arrange
        const verdicts: VerificationStatus[] = ['confirmed', 'refuted', 'undetermined'];
        const clusters = verdicts.map((status, i) =>
            cluster(i + 1, 1, { verificationStatus: status }));

        // Act
        const selected = verificationQueue(clusters);

        // Assert
        expect(selected).toEqual([]);
    });

    it('should admit a pending cluster whose members absorbed an adjudicated set, whatever its occurrence', () =>
    {
        // Arrange: the ghost scenario — a refuted singleton merged with a new
        // duplicate would otherwise hide behind the occurrence-1 gate forever.
        const clusters = [
            cluster(1, 2, { lapsedVerdict: 'refuted' }),
            cluster(2, 2),
        ];

        // Act
        const selected = verificationQueue(clusters);

        // Assert
        expect(selected.map(c => c.id)).toEqual([clusterId(1)]);
    });

    it('should re-test settled clusters when reverify is asked for', () =>
    {
        // Arrange
        const clusters = [
            cluster(1, 1, { verificationStatus: 'confirmed' }),
            cluster(2, 1, { verificationStatus: 'pending' }),
            cluster(3, 2, { verificationStatus: 'pending' }),
        ];

        // Act
        const selected = verificationQueue(clusters, true);

        // Assert
        expect(selected.map(c => c.id)).toEqual([clusterId(1), clusterId(2)]);
    });
});

// ── the orchestration layer, on a real store with injected runners ──────

const fakeClient: RepoClient = {
    compare: async () => [],
    readFile: async () => '',
    listFiles: async () => ({ paths: [], truncated: false }),
};

function newRun(head: string, findings: NewFinding[]): NewRun
{
    return {
        owner: 'acme', repo: 'widgets', head, base: 'main', model: 'test',
        status: 'submitted',
        review: { summary: 'test run', findings },
        turns: 1, costUsd: 0,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    };
}

const someFinding = { file: 'src/a.ts', severity: 'warning' as const, title: 'claim', detail: 'evidence' };

function verified(verdict: 'confirmed' | 'refuted' | 'undetermined', costUsd = 0.5): VerifyResult
{
    return {
        status: 'verified',
        response: { verdict, rationale: 'because', confidence: 'sure' },
        stats: { turns: 3, costUsd, usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
    };
}

let store: ReviewStore;

beforeEach(() =>
{
    store = new ReviewStore(':memory:');
});

afterEach(() =>
{
    store.close();
});

// A consolidation over the given runs, one singleton cluster per finding —
// built directly on the store so no judge is involved.
function savedIdentityConsolidation(runIds: Parameters<ReviewStore['getFindings']>[0][]): Consolidation
{
    const findings = runIds.flatMap(id => store.getFindings(id));
    const id = store.saveConsolidation({
        owner: 'acme', repo: 'widgets', head: 'feature-x', base: 'main',
        runIds,
        clusters: findings.map(f => ({ memberIds: [f.id], representativeId: f.id, severity: f.severity, occurrence: 1 })),
    });
    return store.getConsolidation(id)!;
}

describe('verifyPending', () =>
{
    it('should record each verdict as it lands and continue past failures', async () =>
    {
        // Arrange: three pending singletons; the runner confirms the first,
        // aborts on the second, throws on the third.
        const run = store.saveRun(newRun('feature-x', [
            { ...someFinding, title: 'first' },
            { ...someFinding, title: 'second' },
            { ...someFinding, title: 'third' },
        ]));
        const consolidation = savedIdentityConsolidation([run]);
        let call = 0;
        const runner = async (): Promise<VerifyResult> =>
        {
            call++;
            if (call === 1)
            {
                return verified('confirmed', 0.5);
            }
            if (call === 2)
            {
                return {
                    status: 'aborted', reason: 'error_max_turns',
                    stats: { turns: 24, costUsd: 0.3, usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
                };
            }
            throw new Error('GitHub 502');
        };

        // Act
        const summary = await verifyPending(store, fakeClient, consolidation, { runner });

        // Assert: the confirmed verdict is durable, the failures stay pending
        // for a later re-run, and the aborted attempt's cost still counts.
        expect(summary).toEqual({ attempted: 3, verified: 1, failures: 2, costUsd: 0.8 });
        const reread = store.getConsolidation(consolidation.id)!;
        expect(reread.clusters.map(c => c.verificationStatus)).toEqual(['confirmed', 'pending', 'pending']);
    });

    it('should verify nothing when every cluster is settled and reverify is off', async () =>
    {
        // Arrange
        const run = store.saveRun(newRun('feature-x', [someFinding]));
        const consolidation = savedIdentityConsolidation([run]);
        store.saveVerification({
            source: 'agent', clusterId: consolidation.clusters[0]!.id,
            verdict: 'confirmed', rationale: 'done', confidence: 'high', costUsd: 0.2,
        });
        const runner = vi.fn();

        // Act
        const summary = await verifyPending(store, fakeClient, store.getConsolidation(consolidation.id)!, { runner });

        // Assert
        expect(summary.attempted).toBe(0);
        expect(runner).not.toHaveBeenCalled();
    });
});

describe('verifyTarget', () =>
{
    const target = { owner: 'acme', repo: 'widgets', head: 'feature-x', base: 'main' };

    it('should throw on a target with no submitted runs: such a job is a caller mistake', async () =>
    {
        // Act + Assert
        await expect(verifyTarget(store, fakeClient, target)).rejects.toThrow('No submitted runs');
    });

    it('should succeed vacuously when the runs have no findings, consolidating nothing', async () =>
    {
        // Arrange
        store.saveRun(newRun('feature-x', []));

        // Act
        const result = await verifyTarget(store, fakeClient, target);

        // Assert: nothing existed to consolidate, so nothing was saved and
        // nothing was billed.
        expect(result.consolidationId).toBeUndefined();
        expect(result.summary).toEqual({ attempted: 0, verified: 0, failures: 0, costUsd: 0 });
        expect(store.listConsolidations()).toEqual([]);
    });

    it('should reuse a consolidation that covers exactly the submitted runs: no judge call to re-buy', async () =>
    {
        // Arrange: the gate this test exists for — NOTES #134.
        const runA = store.saveRun(newRun('feature-x', [someFinding]));
        const runB = store.saveRun(newRun('feature-x', [{ ...someFinding, file: 'src/b.ts' }]));
        const existing = savedIdentityConsolidation([runA, runB]);
        const consolidate = vi.fn(async (): Promise<Consolidation | undefined> => undefined);
        const runner = async (): Promise<VerifyResult> => verified('refuted');

        // Act
        const result = await verifyTarget(store, fakeClient, target, { consolidate, runner });

        // Assert
        expect(consolidate).not.toHaveBeenCalled();
        expect(result.consolidationId).toBe(existing.id);
        expect(result.summary.verified).toBe(2);
    });

    it('should re-consolidate when a newer run is not covered by the latest consolidation', async () =>
    {
        // Arrange
        const runA = store.saveRun(newRun('feature-x', [someFinding]));
        savedIdentityConsolidation([runA]);
        const runB = store.saveRun(newRun('feature-x', [{ ...someFinding, file: 'src/b.ts' }]));
        const consolidate = vi.fn(async (_store: ReviewStore, _target: Target, runs: Run[]) =>
            savedIdentityConsolidation(runs.map(r => r.id)));
        const runner = async (): Promise<VerifyResult> => verified('confirmed');

        // Act
        const result = await verifyTarget(store, fakeClient, target, { consolidate, runner });

        // Assert: consolidation was re-bought over both runs, then verified.
        expect(consolidate).toHaveBeenCalledTimes(1);
        expect(consolidate.mock.calls[0]![2].map(r => r.id)).toEqual([runA, runB]);
        expect(result.consolidationId).toBeDefined();
        expect(result.summary.attempted).toBe(2);
    });

    it('should not mistake a different-base consolidation of the same head for coverage', async () =>
    {
        // Arrange: same head consolidated against another base — the quad
        // filter must not reuse it.
        const runA = store.saveRun(newRun('feature-x', [someFinding]));
        const otherBase = store.saveRun({ ...newRun('feature-x', [someFinding]), base: 'release/2.0' });
        store.saveConsolidation({
            owner: 'acme', repo: 'widgets', head: 'feature-x', base: 'release/2.0',
            runIds: [otherBase],
            clusters: store.getFindings(otherBase).map(f => ({ memberIds: [f.id], representativeId: f.id, severity: f.severity, occurrence: 1 })),
        });
        const consolidate = vi.fn(async (): Promise<Consolidation | undefined> => savedIdentityConsolidation([runA]));
        const runner = async (): Promise<VerifyResult> => verified('confirmed');

        // Act
        await verifyTarget(store, fakeClient, target, { consolidate, runner });

        // Assert
        expect(consolidate).toHaveBeenCalledTimes(1);
    });
});

describe('verificationResponseSchema', () =>
{
    it('should accept a valid response', () =>
    {
        // Arrange
        const wire = {
            verdict: 'undetermined',
            rationale: 'The consumer component is not in this repository.',
            confidence: 'Low; a frontend checkout would settle it.',
        };

        // Act
        const response = verificationResponseSchema.parse(wire);

        // Assert
        expect(response).toEqual(wire);
    });

    it('should reject an unknown verdict', () =>
    {
        // Arrange
        const wire = { verdict: 'plausible', rationale: 'r', confidence: 'c' };

        // Act
        const parsed = verificationResponseSchema.safeParse(wire);

        // Assert
        expect(parsed.success).toBe(false);
    });
});
