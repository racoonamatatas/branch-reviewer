import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepoClient } from '../../src/github/github.js';
import { ReviewStore } from '../../src/store/store.js';
import type { Cluster, Finding, VerificationStatus } from '../../src/store/store.js';
import { clusterId, findingId, runId } from '../../src/types/ids.js';
import { buildVerificationPrompt, verificationQueue, verificationResponseSchema, verifyTarget } from '../../src/verify/verify.js';

// verifyTarget's consolidation path ends in a judge call; the mock is the
// paid boundary, everything else (store, selection, reuse) runs real. The
// pure exports (distinctRuns, maxSeverity) stay original — persist.ts needs
// them to turn the mocked proposals into rows.
const runClusteringMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/consolidate/consolidate.js', async (importOriginal) =>
{
    const original = await importOriginal<typeof import('../../src/consolidate/consolidate.js')>();
    return { ...original, runClustering: runClusteringMock };
});

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
    it('should carry provenance: cluster id, source run, and 1-of-K odds', () =>
    {
        // Arrange
        const singleton = cluster(19, 1, { representative: finding(7, 4) });

        // Act
        const prompt = buildVerificationPrompt(singleton, 4);

        // Assert
        expect(prompt).toContain('cluster #19, reported by only 1 of 4 independent review runs of this branch (run #4)');
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

    it('should end with the refute instruction', () =>
    {
        // Act
        const prompt = buildVerificationPrompt(cluster(1, 1), 2);

        // Assert
        expect(prompt).toMatch(/Try to refute this finding against the diff and the repository, then give your verdict\.$/);
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

// The gate that decides whether a judge call gets paid for. Every scenario
// here must finish without touching verifyCluster: clusters are arranged to
// be corroborated (occurrence ≥ 2), so the adversarial queue stays empty and
// no test can reach a real query().
describe('verifyTarget', () =>
{
    const TARGET = { owner: 'acme', repo: 'widgets', head: 'feature-x', base: 'main' };

    // Never called in these tests; present because the signature demands one.
    const client: RepoClient = {
        compare: async () => [],
        readFile: async () => '',
    };

    let store: ReviewStore;

    beforeEach(() =>
    {
        store = new ReviewStore(':memory:');
        runClusteringMock.mockReset();
    });

    afterEach(() =>
    {
        store.close();
    });

    function savedRun(titles: string[], target = TARGET)
    {
        return store.saveRun({
            ...target,
            model: 'claude-opus-5',
            status: 'submitted',
            review: {
                summary: 'reviewed',
                findings: titles.map(title => ({ file: 'src/a.ts', line: 3, severity: 'warning', title, detail: `detail of ${title}` })),
            },
            turns: 10,
            costUsd: 1,
            usage: { inputTokens: 10, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
            filesChanged: 2,
        });
    }

    it('should throw on a target with no submitted runs', async () =>
    {
        // Arrange: an aborted run is not a submitted one.
        store.saveRun({
            ...TARGET,
            model: 'claude-opus-5',
            status: 'aborted',
            reason: 'error_max_turns',
            turns: 10,
            costUsd: 1,
            usage: { inputTokens: 10, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        });

        // Act + Assert
        await expect(verifyTarget(store, client, TARGET)).rejects.toThrow('No submitted runs');
        expect(runClusteringMock).not.toHaveBeenCalled();
    });

    it('should succeed vacuously when no submitted run has findings, writing nothing', async () =>
    {
        // Arrange
        savedRun([]);

        // Act
        const result = await verifyTarget(store, client, TARGET);

        // Assert: no judge call, no consolidation row, an empty summary.
        expect(result).toEqual({ reused: false, summary: { attempted: 0, verified: 0, failures: 0, costUsd: 0 } });
        expect(store.listConsolidations()).toEqual([]);
        expect(runClusteringMock).not.toHaveBeenCalled();
    });

    it('should reuse the latest consolidation when it covers exactly the submitted runs', async () =>
    {
        // Arrange: two runs, one existing rev over both of them.
        const runA = savedRun(['Unbounded query']);
        const runB = savedRun(['Unbounded query']);
        const a = store.getFindings(runA)[0]!;
        const b = store.getFindings(runB)[0]!;
        const existing = store.saveConsolidation({
            ...TARGET,
            runIds: [runA, runB],
            clusters: [{ memberIds: [a.id, b.id], representativeId: a.id, severity: 'warning', occurrence: 2 }],
        });

        // Act
        const result = await verifyTarget(store, client, TARGET);

        // Assert: the rev is reused — a fresh judge call over the same runs
        // would buy nothing.
        expect(result.reused).toBe(true);
        expect(result.consolidationId).toBe(existing);
        expect(runClusteringMock).not.toHaveBeenCalled();
        expect(store.listConsolidations()).toHaveLength(1);
    });

    it('should re-consolidate when a newer submitted run is outside the latest rev', async () =>
    {
        // Arrange: an existing rev over two runs, then a third run lands.
        const runA = savedRun(['Unbounded query']);
        const runB = savedRun(['Unbounded query']);
        const a = store.getFindings(runA)[0]!;
        const b = store.getFindings(runB)[0]!;
        const stale = store.saveConsolidation({
            ...TARGET,
            runIds: [runA, runB],
            clusters: [{ memberIds: [a.id, b.id], representativeId: a.id, severity: 'warning', occurrence: 2 }],
        });
        const runC = savedRun(['Unbounded query']);
        const c = store.getFindings(runC)[0]!;
        runClusteringMock.mockResolvedValue([{ memberIds: [a.id, b.id, c.id], representativeId: a.id }]);

        // Act
        const result = await verifyTarget(store, client, TARGET);

        // Assert: one judge call, and a new rev covering all three runs.
        expect(runClusteringMock).toHaveBeenCalledTimes(1);
        expect(result.reused).toBe(false);
        expect(result.consolidationId).not.toBe(stale);
        const latest = store.listConsolidations({ ...TARGET })[0];
        expect(latest?.id).toBe(result.consolidationId);
        expect(latest?.runIds).toEqual([runA, runB, runC]);
    });

    it('should not reuse a rev of the same head against a different base', async () =>
    {
        // Arrange: the same runIds under another base — without the base pin
        // this rev would satisfy the covered check by member equality alone.
        const runA = savedRun(['Unbounded query']);
        const runB = savedRun(['Unbounded query']);
        const a = store.getFindings(runA)[0]!;
        const b = store.getFindings(runB)[0]!;
        store.saveConsolidation({
            ...TARGET,
            base: 'develop',
            runIds: [runA, runB],
            clusters: [{ memberIds: [a.id, b.id], representativeId: a.id, severity: 'warning', occurrence: 2 }],
        });
        runClusteringMock.mockResolvedValue([{ memberIds: [a.id, b.id], representativeId: a.id }]);

        // Act
        const result = await verifyTarget(store, client, TARGET);

        // Assert: a fresh consolidation against the right base.
        expect(result.reused).toBe(false);
        expect(runClusteringMock).toHaveBeenCalledTimes(1);
    });
});
