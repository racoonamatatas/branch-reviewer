import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import type { RoundOutcome } from '../../src/campaign/campaign.js';
import { ReviewStore } from '../../src/store/store.js';
import type { CampaignRound, NewRun } from '../../src/store/store.js';
import { campaignId } from '../../src/types/ids.js';
import type { CampaignId, ConsolidationId, RunId } from '../../src/types/ids.js';

const run: NewRun = {
    owner: 'acme',
    repo: 'widgets',
    head: 'feature-x',
    base: 'main',
    model: 'claude-opus-5',
    status: 'submitted',
    review: {
        summary: 'Solid branch, one concern.',
        findings: [
            { file: 'src/a.ts', line: 12, severity: 'warning', title: 'Unbounded query', detail: 'No limit.' },
            { file: 'src/b.ts', severity: 'nit', title: 'Naming', detail: 'Misleading name.' },
        ],
    },
    turns: 30,
    costUsd: 2.5,
    usage: { inputTokens: 100, outputTokens: 200, cacheReadInputTokens: 3000, cacheCreationInputTokens: 400 },
};

const target = { owner: run.owner, repo: run.repo, head: run.head, base: run.base };

// Compile-time contract: the loop's per-round outcome must be exactly what
// the store persists — a field added to one without the other fails typecheck
// before it can silently drop from history.
it('should keep the round outcome equal to the stored campaign round', () =>
{
    // Assert
    expectTypeOf<RoundOutcome>().toEqualTypeOf<CampaignRound>();
});

describe('ReviewStore campaigns', () =>
{
    let store: ReviewStore;

    beforeEach(() =>
    {
        store = new ReviewStore(':memory:');
    });

    // Two stored runs consolidated into one cluster — the FK targets a round needs.
    function storedConsolidation(): { runIds: [RunId, RunId]; consolidationId: ConsolidationId }
    {
        const first = store.saveRun(run);
        const second = store.saveRun(run);
        const members = [...store.getFindings(first), ...store.getFindings(second)].map(f => f.id);
        const id = store.saveConsolidation({
            ...target,
            runIds: [first, second],
            clusters: [{ memberIds: members, representativeId: members[0]!, severity: 'warning', occurrence: 2 }],
        });
        return { runIds: [first, second], consolidationId: id };
    }

    function fullRound(runId: RunId, consolidationId: ConsolidationId): CampaignRound
    {
        return {
            round: 1,
            runId,
            findings: 2,
            turns: 30,
            costUsd: 2.5,
            consolidationId,
            coverage: { observed: 3, f1: 2, f2: 1, undiscovered: 2, estimatedTotal: 5 },
            novelClusters: 1,
        };
    }

    it('should create a campaign as running with no rounds', () =>
    {
        // Act
        const id = store.createCampaign(target);
        const campaign = store.getCampaign(id);

        // Assert
        expect(campaign).toMatchObject({ ...target, status: 'running', rounds: [] });
        expect(campaign?.baselineConsolidationId).toBeUndefined();
    });

    it('should return undefined for an unknown campaign', () =>
    {
        // Assert
        expect(store.getCampaign(campaignId(999))).toBeUndefined();
    });

    it('should round-trip rounds in order with coverage intact', () =>
    {
        // Arrange
        const { runIds, consolidationId } = storedConsolidation();
        const id = store.createCampaign(target);

        // Act — a full round, then a failed one that never stored a run.
        store.appendCampaignRound(id, fullRound(runIds[1], consolidationId));
        store.appendCampaignRound(id, { round: 2, findings: 0, turns: 0, costUsd: 0, failed: 'fetch failed', novelClusters: 0 });
        const rounds = store.getCampaign(id)!.rounds;

        // Assert
        expect(rounds).toEqual([
            fullRound(runIds[1], consolidationId),
            { round: 2, findings: 0, turns: 0, costUsd: 0, failed: 'fetch failed', novelClusters: 0 },
        ]);
    });

    it('should reject a duplicate round number', () =>
    {
        // Arrange
        const id = store.createCampaign(target);
        store.appendCampaignRound(id, { round: 1, findings: 0, turns: 5, costUsd: 0.1, aborted: 'error_max_turns', novelClusters: 0 });

        // Assert
        expect(() => store.appendCampaignRound(id, { round: 1, findings: 0, turns: 5, costUsd: 0.1, aborted: 'error_max_turns', novelClusters: 0 }))
            .toThrow(/UNIQUE|PRIMARY KEY/i);
    });

    it('should reject a consolidated round without its coverage snapshot', () =>
    {
        // Arrange
        const { runIds, consolidationId } = storedConsolidation();
        const id = store.createCampaign(target);
        const withoutCoverage: CampaignRound = { ...fullRound(runIds[1], consolidationId) };
        delete withoutCoverage.coverage;

        // Assert — the SQL CHECK is the last line of defense for the coupling
        // the TS shape cannot express (both fields are independently optional).
        expect(() => store.appendCampaignRound(id, withoutCoverage)).toThrow(/CHECK/i);
    });

    it('should finish a campaign with its stop reason', () =>
    {
        // Arrange
        const id = store.createCampaign(target);

        // Act
        store.finishCampaign(id, 'dry');
        const campaign = store.getCampaign(id)!;

        // Assert
        expect(campaign.status).toBe('finished');
        if (campaign.status === 'finished')
        {
            expect(campaign.stoppedBy).toBe('dry');
            expect(campaign.finishedAt).toBeTruthy();
        }
    });

    it('should fail a campaign with its error', () =>
    {
        // Arrange
        const id = store.createCampaign(target);

        // Act
        store.failCampaign(id, 'ECONNRESET');
        const campaign = store.getCampaign(id)!;

        // Assert
        expect(campaign.status).toBe('failed');
        if (campaign.status === 'failed')
        {
            expect(campaign.error).toBe('ECONNRESET');
        }
    });

    it('should guard every transition on a running campaign', () =>
    {
        // Arrange
        const id = store.createCampaign(target);
        store.finishCampaign(id, 'max-runs');

        // Assert
        expect(() => store.finishCampaign(id, 'dry')).toThrow(/finished, not running/);
        expect(() => store.failCampaign(id, 'late error')).toThrow(/finished, not running or verifying/);
        expect(() => store.appendCampaignRound(id, { round: 1, findings: 0, turns: 0, costUsd: 0, failed: 'x', novelClusters: 0 }))
            .toThrow(/finished, not running/);
        expect(() => store.finishCampaign(campaignId(999), 'dry')).toThrow(/No campaign #999/);
    });

    it('should record the baseline consolidation only while running', () =>
    {
        // Arrange
        const { consolidationId } = storedConsolidation();
        const running = store.createCampaign(target);
        const done = store.createCampaign(target);
        store.finishCampaign(done, 'dry');

        // Act
        store.recordCampaignBaseline(running, consolidationId);

        // Assert
        expect(store.getCampaign(running)?.baselineConsolidationId).toBe(consolidationId);
        expect(() => store.recordCampaignBaseline(done, consolidationId)).toThrow(/finished, not running/);
    });

    it('should list campaigns newest first with round counts and cost', () =>
    {
        // Arrange
        const { runIds, consolidationId } = storedConsolidation();
        const first = store.createCampaign(target);
        store.appendCampaignRound(first, fullRound(runIds[1], consolidationId));
        store.appendCampaignRound(first, { round: 2, findings: 0, turns: 12, costUsd: 1.5, aborted: 'error_max_turns', novelClusters: 0 });
        store.finishCampaign(first, 'dry');
        const second = store.createCampaign({ ...target, head: 'feature-y' });

        // Act
        const all = store.listCampaigns();
        const filtered = store.listCampaigns(target);

        // Assert
        expect(all.map(c => c.id)).toEqual([second, first]);
        expect(filtered).toEqual([{
            id: first,
            createdAt: expect.any(String) as string,
            ...target,
            target: 'acme/widgets feature-x → main',
            status: 'finished',
            stoppedBy: 'dry',
            roundCount: 2,
            reviewCostUsd: 4,
        }]);
    });

    it('should enter verification with the stop reason already durable', () =>
    {
        // Arrange
        const id = store.createCampaign(target);

        // Act
        store.beginCampaignVerification(id, 'dry');
        const campaign = store.getCampaign(id)!;

        // Assert: a live phase, not a terminal one — no finishedAt yet.
        expect(campaign.status).toBe('verifying');
        if (campaign.status === 'verifying')
        {
            expect(campaign.stoppedBy).toBe('dry');
        }
    });

    it('should finish a verified campaign keeping the stop reason it recorded at the loop end', () =>
    {
        // Arrange
        const id = store.createCampaign(target);
        store.beginCampaignVerification(id, 'max-runs');

        // Act
        store.finishVerifiedCampaign(id);

        // Assert
        expect(store.getCampaign(id)).toMatchObject({ status: 'finished', stoppedBy: 'max-runs' });
    });

    it('should keep the stop reason when verification fails: the loop outcome is never lost', () =>
    {
        // Arrange
        const id = store.createCampaign(target);
        store.beginCampaignVerification(id, 'dry');

        // Act
        store.failCampaign(id, 'verifier exploded');
        const campaign = store.getCampaign(id)!;

        // Assert
        expect(campaign.status).toBe('failed');
        if (campaign.status === 'failed')
        {
            expect(campaign.error).toBe('verifier exploded');
            expect(campaign.stoppedBy).toBe('dry');
        }
    });

    it('should guard the verification transitions like every other', () =>
    {
        // Arrange
        const id = store.createCampaign(target);

        // Assert: verification cannot finish before it begins, cannot begin
        // twice, and rounds never append once the loop is over.
        expect(() => store.finishVerifiedCampaign(id)).toThrow(/running, not verifying/);
        store.beginCampaignVerification(id, 'dry');
        expect(() => store.beginCampaignVerification(id, 'dry')).toThrow(/verifying, not running/);
        expect(() => store.appendCampaignRound(id, { round: 1, findings: 0, turns: 0, costUsd: 0, failed: 'x', novelClusters: 0 }))
            .toThrow(/verifying, not running/);
    });

    it('should rebuild a pre-verifying campaigns table in place, rows intact', () =>
    {
        // Arrange: a database whose campaigns table carries the old CHECKs
        // (no 'verifying' in the status list), holding one finished row AND
        // a round referencing it — the referencing row is the point, because
        // node:sqlite enforces foreign keys by default and dropping a
        // referenced parent is exactly what the rebuild must survive. The
        // raw builder opens with FKs off only to write the fixture without
        // recreating every parent table.
        const dir = mkdtempSync(join(tmpdir(), 'campaign-migrate-'));
        const path = join(dir, 'reviews.db');
        const raw = new DatabaseSync(path, { enableForeignKeyConstraints: false });
        raw.exec(`
            CREATE TABLE campaigns (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL,
                owner TEXT NOT NULL,
                repo TEXT NOT NULL,
                head TEXT NOT NULL,
                base TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'finished', 'failed')),
                stopped_by TEXT,
                error TEXT,
                finished_at TEXT,
                baseline_consolidation_id INTEGER REFERENCES consolidations(id),
                CHECK ((status = 'finished') = (stopped_by IS NOT NULL)),
                CHECK ((status = 'failed') = (error IS NOT NULL)),
                CHECK ((status = 'running') = (finished_at IS NULL))
            );
            INSERT INTO campaigns (created_at, owner, repo, head, base, status, stopped_by, finished_at)
                VALUES ('2026-08-19T00:00:00Z', 'acme', 'widgets', 'feature-x', 'main', 'finished', 'dry', '2026-08-19T01:00:00Z');
            CREATE TABLE campaign_rounds (
                campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
                round INTEGER NOT NULL,
                run_id INTEGER,
                findings INTEGER NOT NULL,
                turns INTEGER NOT NULL,
                cost_usd REAL NOT NULL,
                aborted TEXT,
                failed TEXT,
                consolidation_failed TEXT,
                consolidation_id INTEGER,
                novel_clusters INTEGER NOT NULL,
                observed INTEGER,
                f1 INTEGER,
                f2 INTEGER,
                undiscovered INTEGER,
                estimated_total INTEGER,
                PRIMARY KEY (campaign_id, round)
            );
            INSERT INTO campaign_rounds (campaign_id, round, findings, turns, cost_usd, novel_clusters)
                VALUES (1, 1, 3, 20, 1.5, 3);
        `);
        raw.close();

        // Act: opening the store migrates; the new CHECKs accept 'verifying'.
        const migrated = new ReviewStore(path);
        const survivor = migrated.getCampaign(migrated.listCampaigns()[0]!.id)!;
        const fresh = migrated.createCampaign(target);
        migrated.beginCampaignVerification(fresh, 'dry');

        // Assert: the row and its round both survived the rebuild.
        expect(survivor).toMatchObject({ status: 'finished', stoppedBy: 'dry' });
        expect(survivor.rounds).toHaveLength(1);
        expect(migrated.getCampaign(fresh)?.status).toBe('verifying');
        migrated.close();
        rmSync(dir, { recursive: true, force: true });
    });

    it('should brand campaign ids at the type level', () =>
    {
        // Assert
        expectTypeOf(store.createCampaign(target)).toEqualTypeOf<CampaignId>();
    });
});
