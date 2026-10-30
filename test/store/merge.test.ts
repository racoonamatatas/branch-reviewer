import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobStore } from '../../src/server/jobs.js';
import { mergeDatabases } from '../../src/store/merge.js';
import { ReviewStore } from '../../src/store/store.js';
import type { ConsolidationId, RunId } from '../../src/types/ids.js';

let dir: string;
let targetPath: string;
let sourcePath: string;
let clock: number;

beforeEach(() =>
{
    dir = mkdtempSync(join(tmpdir(), 'merge-'));
    targetPath = join(dir, 'target.db');
    sourcePath = join(dir, 'source.db');
    // Rows match on a millisecond created_at, so every write gets its own
    // instant; two seeds landing in one millisecond would read as a copy.
    clock = Date.parse('2026-10-01T00:00:00.000Z');
    vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() =>
{
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
});

function tick(): void
{
    clock += 1000;
    vi.setSystemTime(clock);
}

// One run with two findings, consolidated into a single two-member cluster.
function seed(path: string, head: string): { run: RunId; consolidation: ConsolidationId }
{
    const store = new ReviewStore(path);
    try
    {
        tick();
        const run = store.saveRun({
            owner: 'acme', repo: 'widgets', head, base: 'main', model: 'claude-opus-5', status: 'submitted',
            review: {
                summary: `Reviewed ${head}.`,
                findings: [
                    { file: 'src/a.ts', line: 1, severity: 'warning', title: `${head} first`, detail: 'd' },
                    { file: 'src/b.ts', severity: 'nit', title: `${head} second`, detail: 'd' },
                ],
            },
            turns: 10, costUsd: 1,
            usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 1, cacheCreationInputTokens: 1 },
        });
        const [first, second] = store.getFindings(run);
        tick();
        const consolidation = store.saveConsolidation({
            owner: 'acme', repo: 'widgets', head, base: 'main', runIds: [run], costUsd: 0.1,
            clusters: [{ memberIds: [first!.id, second!.id], representativeId: first!.id, severity: 'warning', occurrence: 1 }],
        });
        return { run, consolidation };
    }
    finally
    {
        store.close();
    }
}

function verifyFirstCluster(path: string, consolidation: ConsolidationId): void
{
    const store = new ReviewStore(path);
    try
    {
        tick();
        store.saveVerification({
            source: 'agent', clusterId: store.getConsolidation(consolidation)!.clusters[0]!.id,
            verdict: 'confirmed', rationale: 'Read the file.', confidence: 'High.', costUsd: 0.2,
        });
    }
    finally
    {
        store.close();
    }
}

function withStore<T>(path: string, read: (store: ReviewStore) => T): T
{
    const store = new ReviewStore(path);
    try
    {
        return read(store);
    }
    finally
    {
        store.close();
    }
}

function heads(store: ReviewStore): string[]
{
    return store.listRuns().map(r => store.getRun(r.id)!.head);
}

describe('mergeDatabases', () =>
{
    it('should append a disjoint source with every reference rewritten', () =>
    {
        // Arrange — both files number from 1, so every source id collides.
        seed(targetPath, 'target-branch');
        const { run, consolidation } = seed(sourcePath, 'source-branch');
        verifyFirstCluster(sourcePath, consolidation);
        const source = new ReviewStore(sourcePath);
        tick();
        const campaign = source.createCampaign({ owner: 'acme', repo: 'widgets', head: 'source-branch', base: 'main' });
        source.recordCampaignBaseline(campaign, consolidation);
        source.appendCampaignRound(campaign, { round: 1, runId: run, findings: 2, turns: 10, costUsd: 1, novelClusters: 1, consolidationId: consolidation, coverage: { observed: 1, f1: 1, f2: 0, undiscovered: 0, estimatedTotal: 1 } });
        source.finishCampaign(campaign, 'max-runs');
        source.close();
        const jobs = new JobStore(sourcePath);
        tick();
        const job = jobs.enqueue({ kind: 'campaign', owner: 'acme', repo: 'widgets', head: 'source-branch', base: 'main', params: { maxRuns: 1, verify: true } });
        jobs.claimNext();
        jobs.recordRun(job, run);
        jobs.recordCampaign(job, campaign);
        jobs.succeed(job, { consolidationId: consolidation });
        jobs.close();

        // Act
        const report = mergeDatabases(targetPath, sourcePath);

        // Assert
        expect(report).toMatchObject({
            runs: { added: 1, shared: 0 }, findings: { added: 2, shared: 0 }, consolidations: { added: 1, shared: 0 },
            clusters: { added: 1, shared: 0 }, verifications: { added: 1, shared: 0 }, campaigns: { added: 1, shared: 0 },
            jobs: { added: 1, shared: 0 },
        });
        withStore(targetPath, store =>
        {
            const imported = store.listRuns().find(r => r.target.includes(' source-branch '))!;
            expect(imported.id).not.toBe(run);
            expect(store.getFindings(imported.id).map(f => f.title)).toEqual(['source-branch first', 'source-branch second']);
            const merged = store.listConsolidations().find(c => c.target.includes(' source-branch '))!;
            const full = store.getConsolidation(merged.id)!;
            expect(full.runIds).toEqual([imported.id]);
            expect(full.clusters[0]!.members.map(m => m.runId)).toEqual([imported.id, imported.id]);
            expect(full.clusters[0]!.verificationStatus).toBe('confirmed');
            const importedCampaign = store.listCampaigns().find(c => c.head === 'source-branch')!;
            const rounds = store.getCampaign(importedCampaign.id)!.rounds;
            expect(rounds.map(r => [r.runId, r.consolidationId])).toEqual([[imported.id, merged.id]]);
        });
        const targetJobs = new JobStore(targetPath);
        const [importedJob] = targetJobs.list();
        const imported = withStore(targetPath, store => store.listRuns().find(r => r.target.includes(' source-branch '))!.id);
        const importedCampaign = withStore(targetPath, store => store.listCampaigns()[0]!.id);
        const importedConsolidation = withStore(targetPath, store => store.listConsolidations().find(c => c.target.includes(' source-branch '))!.id);
        expect(targetJobs.get(importedJob!.id)).toMatchObject({
            state: 'succeeded', runIds: [imported], campaignId: importedCampaign, consolidationId: importedConsolidation,
        });
        targetJobs.close();
    });

    it('should recognise rows both files inherited from a copy and add only what diverged', () =>
    {
        // Arrange — a shared ancestor, then each machine keeps writing.
        const ancestor = seed(sourcePath, 'shared-branch');
        copyFileSync(sourcePath, targetPath);
        seed(targetPath, 'home-branch');
        seed(sourcePath, 'away-branch');
        verifyFirstCluster(sourcePath, ancestor.consolidation);

        // Act
        const report = mergeDatabases(targetPath, sourcePath);

        // Assert
        expect(report).toMatchObject({
            runs: { added: 1, shared: 1 }, findings: { added: 2, shared: 2 },
            consolidations: { added: 1, shared: 1 }, clusters: { added: 1, shared: 1 },
            verifications: { added: 1, shared: 0 },
        });
        withStore(targetPath, store =>
        {
            expect(heads(store).sort()).toEqual(['away-branch', 'home-branch', 'shared-branch']);
            // The verdict reached on the other machine after the copy lands on the shared cluster.
            expect(store.getConsolidation(ancestor.consolidation)!.clusters[0]!.verificationStatus).toBe('confirmed');
        });
    });

    it('should add nothing when the same source is merged twice', () =>
    {
        // Arrange
        seed(targetPath, 'target-branch');
        const { consolidation } = seed(sourcePath, 'source-branch');
        verifyFirstCluster(sourcePath, consolidation);
        mergeDatabases(targetPath, sourcePath);

        // Act
        const report = mergeDatabases(targetPath, sourcePath);

        // Assert
        expect(report).toMatchObject({
            runs: { added: 0, shared: 1 }, findings: { added: 0, shared: 2 }, consolidations: { added: 0, shared: 1 },
            clusters: { added: 0, shared: 1 }, verifications: { added: 0, shared: 1 },
        });
    });

    it('should refuse and leave the target untouched when a shared row diverged', () =>
    {
        // Arrange — the shared consolidation gains a cluster on one side only,
        // which no ordering can pair. The divergence sits after the away
        // run's insert, so only the rollback keeps that run out of the target.
        const { run, consolidation } = seed(sourcePath, 'shared-branch');
        copyFileSync(sourcePath, targetPath);
        seed(sourcePath, 'away-branch');
        const raw = new DatabaseSync(sourcePath);
        raw.prepare("INSERT INTO clusters (consolidation_id, representative_finding_id, severity, occurrence) VALUES (?, 1, 'nit', 1)").run(consolidation);
        raw.close();

        // Act + Assert
        expect(() => mergeDatabases(targetPath, sourcePath)).toThrow(/diverged after a copy/);
        withStore(targetPath, store =>
        {
            expect(heads(store)).toEqual(['shared-branch']);
            expect(store.getFindings(run)).toHaveLength(2);
        });
    });

    it('should import held and queued source jobs as cancelled so the target worker never claims them', () =>
    {
        // Arrange
        const jobs = new JobStore(sourcePath);
        tick();
        jobs.enqueue({ kind: 'review', owner: 'acme', repo: 'widgets', head: 'a', base: 'main', params: {} }, { held: true });
        tick();
        jobs.enqueue({ kind: 'review', owner: 'acme', repo: 'widgets', head: 'b', base: 'main', params: {} });
        jobs.close();

        // Act
        const report = mergeDatabases(targetPath, sourcePath);

        // Assert
        expect(report.jobsCancelled).toBe(2);
        const target = new JobStore(targetPath);
        expect(target.list().map(j => j.state)).toEqual(['cancelled', 'cancelled']);
        expect(target.claimNext()).toBeUndefined();
        target.close();
    });
});
