import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import type { NewFinding } from '../../src/schema/schema.js';
import { ReviewStore } from '../../src/store/store.js';
import type { Finding, NewRun } from '../../src/store/store.js';
import type { New } from '../../src/types/common.js';
import { clusterId, consolidationId, runId } from '../../src/types/ids.js';

const submittedRun: NewRun = {
    owner: 'acme',
    repo: 'widgets',
    head: 'feature-x',
    base: 'main',
    model: 'claude-opus-5',
    status: 'submitted',
    review: {
        summary: 'Solid branch, one concern.',
        findings: [
            { file: 'src/a.ts', line: 12, severity: 'warning', title: 'Unbounded query', detail: 'No limit.', suggestion: 'Paginate.' },
            { file: 'src/b.ts', severity: 'nit', title: 'Naming', detail: 'Misleading name.' },
        ],
    },
    turns: 30,
    costUsd: 2.5,
    usage: { inputTokens: 100, outputTokens: 200, cacheReadInputTokens: 3000, cacheCreationInputTokens: 400 },
};

const abortedRun: NewRun = {
    owner: 'acme',
    repo: 'widgets',
    head: 'feature-y',
    base: 'main',
    model: 'claude-opus-5',
    status: 'aborted',
    reason: 'error_max_turns',
    turns: 20,
    costUsd: 1.25,
    usage: { inputTokens: 50, outputTokens: 60, cacheReadInputTokens: 700, cacheCreationInputTokens: 80 },
};

// Compile-time contract: the wire finding (Zod-sourced in schema.ts) must be
// exactly the Finding entity minus what saveRun assigns. Drift fails typecheck.
it('should keep the wire finding equal to the entity minus server-assigned fields', () =>
{
    // Assert
    expectTypeOf<NewFinding>().toEqualTypeOf<Omit<New<Finding>, 'runId'>>();
});

describe('ReviewStore', () =>
{
    let store: ReviewStore;

    beforeEach(() =>
    {
        store = new ReviewStore(':memory:');
    });

    afterEach(() =>
    {
        store.close();
    });

    it('should round-trip a submitted run with findings', () =>
    {
        // Arrange
        const id = store.saveRun(submittedRun);

        // Act
        const stored = store.getRun(id);

        // Assert
        expect(stored).toEqual({ id, createdAt: expect.any(String) as unknown, ...submittedRun });
    });

    it('should stamp createdAt at save time, never take it from the caller', () =>
    {
        // Arrange
        const id = store.saveRun(submittedRun);

        // Act
        const stored = store.getRun(id);

        // Assert
        expect(stored?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it('should round-trip an aborted run without a review', () =>
    {
        // Arrange
        const id = store.saveRun(abortedRun);

        // Act
        const stored = store.getRun(id);

        // Assert
        expect(stored).toEqual({ id, createdAt: expect.any(String) as unknown, ...abortedRun });
        expect(stored?.review).toBeUndefined();
    });

    it('should keep optional finding fields absent, not null', () =>
    {
        // Arrange
        const id = store.saveRun(submittedRun);

        // Act
        const finding = store.getRun(id)?.review?.findings[1];

        // Assert
        expect(finding).not.toHaveProperty('line');
        expect(finding).not.toHaveProperty('suggestion');
    });

    it('should list runs newest-first with findings counts', () =>
    {
        // Arrange
        const first = store.saveRun(submittedRun);
        const second = store.saveRun(abortedRun);

        // Act
        const summaries = store.listRuns();

        // Assert
        expect(summaries.map(s => s.id)).toEqual([second, first]);
        expect(summaries[1]).toEqual({
            id: first,
            createdAt: expect.any(String) as unknown,
            target: 'acme/widgets feature-x → main',
            status: 'submitted',
            findingsCount: 2,
            turns: 30,
            costUsd: 2.5,
        });
        expect(summaries[0]!.findingsCount).toBe(0);
    });

    it('should pin listRuns to a base when the filter carries one', () =>
    {
        // Arrange: one head reviewed against two bases — two review series.
        const onMain = store.saveRun(submittedRun);
        const onDevelop = store.saveRun({ ...submittedRun, base: 'develop' });

        // Act
        const triple = store.listRuns({ owner: 'acme', repo: 'widgets', head: 'feature-x' });
        const pinned = store.listRuns({ owner: 'acme', repo: 'widgets', head: 'feature-x', base: 'develop' });

        // Assert
        expect(triple.map(r => r.id)).toEqual([onDevelop, onMain]);
        expect(pinned.map(r => r.id)).toEqual([onDevelop]);
    });

    it('should return undefined for an unknown run id', () =>
    {
        // Act
        const stored = store.getRun(runId(999));

        // Assert
        expect(stored).toBeUndefined();
    });

    it('should expose findings with ids and run provenance', () =>
    {
        // Arrange
        const runId = store.saveRun(submittedRun);

        // Act
        const findings = store.getFindings(runId);

        // Assert
        expect(findings).toHaveLength(2);
        expect(findings[0]).toMatchObject({ runId, title: 'Unbounded query' });
        expect(typeof findings[0]!.id).toBe('number');
    });

    describe('consolidations', () =>
    {
        function savedConsolidation()
        {
            const runA = store.saveRun(submittedRun);
            const runB = store.saveRun({ ...submittedRun, head: 'feature-x' });
            const [a1, a2] = store.getFindings(runA);
            const [b1] = store.getFindings(runB);
            const consolidationId = store.saveConsolidation({
                owner: 'acme',
                repo: 'widgets',
                head: 'feature-x',
                base: 'main',
                runIds: [runA, runB],
                clusters: [
                    { memberIds: [a1!.id, b1!.id], representativeId: b1!.id, severity: 'warning', occurrence: 2 },
                    { memberIds: [a2!.id], representativeId: a2!.id, severity: 'nit', occurrence: 1 },
                ],
            });
            return { consolidationId, runA, runB, a1: a1!, a2: a2!, b1: b1! };
        }

        it('should round-trip a consolidation with clusters and members', () =>
        {
            // Arrange
            const { consolidationId, runA, runB, a2, b1 } = savedConsolidation();

            // Act
            const consolidation = store.getConsolidation(consolidationId);

            // Assert
            expect(consolidation?.runIds).toEqual([runA, runB]);
            expect(consolidation?.clusters).toHaveLength(2);
            expect(consolidation?.clusters[0]?.representative.id).toBe(b1.id);
            expect(consolidation?.clusters[0]?.members.map(m => m.id)).toContain(b1.id);
            expect(consolidation?.clusters[0]?.occurrence).toBe(2);
            expect(consolidation?.clusters[1]?.representative.id).toBe(a2.id);
        });

        it('should default every cluster to pending verification', () =>
        {
            // Arrange
            const { consolidationId } = savedConsolidation();

            // Act
            const consolidation = store.getConsolidation(consolidationId);

            // Assert
            expect(consolidation?.clusters.every(c => c.verificationStatus === 'pending')).toBe(true);
        });

        it('should list consolidations with run ids and cluster counts', () =>
        {
            // Arrange
            const { consolidationId, runA, runB } = savedConsolidation();

            // Act
            const summaries = store.listConsolidations();

            // Assert
            expect(summaries).toHaveLength(1);
            expect(summaries[0]).toMatchObject({ id: consolidationId, runIds: [runA, runB], clusterCount: 2 });
        });

        it('should pin listConsolidations to a base when the filter carries one', () =>
        {
            // Arrange: a second rev of the same head against another base.
            const { consolidationId: onMain, runA, a1 } = savedConsolidation();
            const onDevelop = store.saveConsolidation({
                owner: 'acme',
                repo: 'widgets',
                head: 'feature-x',
                base: 'develop',
                runIds: [runA],
                clusters: [{ memberIds: [a1.id], representativeId: a1.id, severity: 'warning', occurrence: 1 }],
            });

            // Act
            const filter = { owner: 'acme', repo: 'widgets', head: 'feature-x' };
            const triple = store.listConsolidations(filter);
            const pinned = store.listConsolidations({ ...filter, base: 'main' });

            // Assert
            expect(triple.map(c => c.id)).toEqual([onDevelop, onMain]);
            expect(pinned.map(c => c.id)).toEqual([onMain]);
        });

        it('should return undefined for an unknown consolidation id', () =>
        {
            // Act
            const consolidation = store.getConsolidation(consolidationId(999));

            // Assert
            expect(consolidation).toBeUndefined();
        });

        describe('verifications', () =>
        {
            function savedClusters()
            {
                const saved = savedConsolidation();
                const consolidation = store.getConsolidation(saved.consolidationId)!;
                return { consolidationId: saved.consolidationId, clusters: consolidation.clusters };
            }

            it('should record a verification and reflect it as the cluster status', () =>
            {
                // Arrange
                const { consolidationId: id, clusters } = savedClusters();

                // Act
                store.saveVerification({
                    source: 'agent',
                    clusterId: clusters[1]!.id,
                    verdict: 'confirmed',
                    rationale: 'The diff shows the unbounded query.',
                    confidence: 'High; only a schema change would overturn it.',
                    costUsd: 0.12,
                });

                // Assert
                const reread = store.getConsolidation(id)!;
                expect(reread.clusters[1]?.verificationStatus).toBe('confirmed');
                expect(reread.clusters[0]?.verificationStatus).toBe('pending');
            });

            it('should round-trip verification fields with a store-stamped createdAt', () =>
            {
                // Arrange
                const { clusters } = savedClusters();
                const cluster = clusters[1]!;

                // Act
                const id = store.saveVerification({
                    source: 'agent',
                    clusterId: cluster.id,
                    verdict: 'undetermined',
                    rationale: 'The consumer lives outside this repo.',
                    confidence: 'Low; a frontend checkout would settle it.',
                    costUsd: 0.34,
                });

                // Assert
                expect(store.getVerifications(cluster.id)).toEqual([{
                    id,
                    clusterId: cluster.id,
                    createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/) as unknown,
                    source: 'agent',
                    verdict: 'undetermined',
                    rationale: 'The consumer lives outside this repo.',
                    confidence: 'Low; a frontend checkout would settle it.',
                    costUsd: 0.34,
                }]);
            });

            it('should keep verifications append-only with the latest verdict winning', () =>
            {
                // Arrange
                const { consolidationId: id, clusters } = savedClusters();
                const cluster = clusters[1]!;

                // Act
                store.saveVerification({
                    source: 'agent',
                    clusterId: cluster.id, verdict: 'confirmed',
                    rationale: 'First pass.', confidence: 'Medium.', costUsd: 0.1,
                });
                store.saveVerification({
                    source: 'agent',
                    clusterId: cluster.id, verdict: 'undetermined',
                    rationale: 'Second pass.', confidence: 'Low.', costUsd: 0.2,
                });

                // Assert
                const verdicts = store.getVerifications(cluster.id).map(v => v.verdict);
                expect(verdicts).toEqual(['confirmed', 'undetermined']);
                expect(store.getConsolidation(id)!.clusters[1]?.verificationStatus).toBe('undetermined');
            });

            it('should record a human verdict with no confidence or cost, updating the cluster status', () =>
            {
                // Arrange
                const { consolidationId: id, clusters } = savedClusters();
                const cluster = clusters[1]!;

                // Act
                const verificationId = store.saveVerification({
                    source: 'human',
                    clusterId: cluster.id,
                    verdict: 'refuted',
                    rationale: 'git ls-files -s shows mode 100755; the precondition holds.',
                });

                // Assert
                expect(store.getVerifications(cluster.id)).toEqual([{
                    id: verificationId,
                    clusterId: cluster.id,
                    createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) as unknown,
                    source: 'human',
                    verdict: 'refuted',
                    rationale: 'git ls-files -s shows mode 100755; the precondition holds.',
                }]);
                expect(store.getConsolidation(id)!.clusters[1]?.verificationStatus).toBe('refuted');
            });

            it('should let a human overrule an agent verdict by appending, and inherit the overrule', () =>
            {
                // Arrange: the agent says undetermined, the human rules.
                const first = savedClusters();
                const cluster = first.clusters[1]!;
                store.saveVerification({
                    source: 'agent',
                    clusterId: cluster.id, verdict: 'undetermined',
                    rationale: 'Needs evidence outside the repo.', confidence: 'Low.', costUsd: 0.3,
                });

                // Act
                store.saveVerification({
                    source: 'human',
                    clusterId: cluster.id, verdict: 'confirmed',
                    rationale: 'Checked the external harness myself.',
                });
                const again = store.saveConsolidation({
                    owner: 'acme', repo: 'widgets', head: 'feature-x', base: 'main',
                    runIds: store.getConsolidation(first.consolidationId)!.runIds,
                    clusters: first.clusters.map(c => ({
                        memberIds: c.members.map(m => m.id),
                        representativeId: c.representative.id,
                        severity: c.severity,
                        occurrence: c.occurrence,
                    })),
                });

                // Assert: both rows survive, the human verdict is the status
                // and the one a re-clustering of the same member set inherits.
                expect(store.getVerifications(cluster.id).map(v => v.source)).toEqual(['agent', 'human']);
                expect(store.getConsolidation(first.consolidationId)!.clusters[1]?.verificationStatus).toBe('confirmed');
                expect(store.getConsolidation(again)!.clusters[1]?.verificationStatus).toBe('confirmed');
            });

            it('should carry a verdict forward to a re-clustering of the same findings', () =>
            {
                // Arrange: verify one cluster, then re-consolidate the same runs
                const first = savedClusters();
                const verified = first.clusters[1]!;
                store.saveVerification({
                    source: 'agent',
                    clusterId: verified.id, verdict: 'confirmed',
                    rationale: 'Earned once.', confidence: 'High.', costUsd: 0.5,
                });

                // Act
                const again = store.saveConsolidation({
                    owner: 'acme', repo: 'widgets', head: 'feature-x', base: 'main',
                    runIds: store.getConsolidation(first.consolidationId)!.runIds,
                    clusters: first.clusters.map(c => ({
                        memberIds: c.members.map(m => m.id),
                        representativeId: c.representative.id,
                        severity: c.severity,
                        occurrence: c.occurrence,
                    })),
                });

                // Assert
                const reread = store.getConsolidation(again)!;
                expect(reread.clusters[1]?.verificationStatus).toBe('confirmed');
                expect(reread.clusters[0]?.verificationStatus).toBe('pending');
                expect(store.getVerifications(reread.clusters[1]!.id)).toEqual([]);
            });

            it('should not carry a verdict forward when the judge regrouped the findings', () =>
            {
                // Arrange
                const first = savedClusters();
                const verified = first.clusters[1]!;
                store.saveVerification({
                    source: 'agent',
                    clusterId: verified.id, verdict: 'refuted',
                    rationale: 'Contrary evidence.', confidence: 'High.', costUsd: 0.5,
                });

                // Act: the same finding, now grouped with another member
                const merged = store.saveConsolidation({
                    owner: 'acme', repo: 'widgets', head: 'feature-x', base: 'main',
                    runIds: store.getConsolidation(first.consolidationId)!.runIds,
                    clusters: [{
                        memberIds: [verified.representative.id, first.clusters[0]!.representative.id],
                        representativeId: verified.representative.id,
                        severity: 'warning',
                        occurrence: 2,
                    }],
                });

                // Assert
                expect(store.getConsolidation(merged)!.clusters[0]?.verificationStatus).toBe('pending');
            });

            it('should carry forward the latest verdict when a member set was adjudicated twice', () =>
            {
                // Arrange
                const first = savedClusters();
                const verified = first.clusters[1]!;
                const memberIds = verified.members.map(m => m.id);
                for (const verdict of ['confirmed', 'undetermined'] as const)
                {
                    store.saveVerification({
                        source: 'agent',
                        clusterId: verified.id, verdict,
                        rationale: `Pass for ${verdict}.`, confidence: 'Medium.', costUsd: 0.1,
                    });
                }

                // Act
                const again = store.saveConsolidation({
                    owner: 'acme', repo: 'widgets', head: 'feature-x', base: 'main',
                    runIds: store.getConsolidation(first.consolidationId)!.runIds,
                    clusters: [{
                        memberIds,
                        representativeId: verified.representative.id,
                        severity: verified.severity,
                        occurrence: verified.occurrence,
                    }],
                });

                // Assert
                expect(store.getConsolidation(again)!.clusters[0]?.verificationStatus).toBe('undetermined');
            });

            it('should reject a verification for an unknown cluster and roll back the row', () =>
            {
                // Arrange
                savedClusters();
                const unknown = clusterId(999);

                // Act + Assert
                expect(() => store.saveVerification({
                    source: 'agent',
                    clusterId: unknown, verdict: 'refuted',
                    rationale: 'n/a', confidence: 'n/a', costUsd: 0,
                })).toThrow('No cluster #999.');
                expect(store.getVerifications(unknown)).toEqual([]);
            });

            it('should migrate a pre-provenance database, branding every existing row agent', () =>
            {
                // Arrange: a database written by the old schema, one verdict
                // recorded before the source column existed.
                const dir = mkdtempSync(join(tmpdir(), 'store-migration-'));
                const path = join(dir, 'reviews.db');
                try
                {
                    const legacy = new DatabaseSync(path);
                    legacy.exec(`
                        CREATE TABLE clusters (id INTEGER PRIMARY KEY AUTOINCREMENT);
                        CREATE TABLE verifications (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            cluster_id INTEGER NOT NULL REFERENCES clusters(id),
                            created_at TEXT NOT NULL,
                            verdict TEXT NOT NULL,
                            rationale TEXT NOT NULL,
                            confidence TEXT NOT NULL,
                            cost_usd REAL NOT NULL
                        );
                        INSERT INTO clusters DEFAULT VALUES;
                        INSERT INTO verifications (cluster_id, created_at, verdict, rationale, confidence, cost_usd)
                            VALUES (1, '2026-08-06T00:00:00.000Z', 'confirmed', 'Old row.', 'High.', 0.5);
                    `);
                    legacy.close();

                    // Act
                    const migrated = new ReviewStore(path);

                    // Assert
                    expect(migrated.getVerifications(clusterId(1))).toEqual([expect.objectContaining({
                        source: 'agent',
                        verdict: 'confirmed',
                        rationale: 'Old row.',
                        confidence: 'High.',
                        costUsd: 0.5,
                    })]);
                    migrated.close();
                }
                finally
                {
                    rmSync(dir, { recursive: true, force: true });
                }
            });
        });
    });
});
