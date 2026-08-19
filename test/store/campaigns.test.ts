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
        expect(() => store.failCampaign(id, 'late error')).toThrow(/finished, not running/);
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

    it('should brand campaign ids at the type level', () =>
    {
        // Assert
        expectTypeOf(store.createCampaign(target)).toEqualTypeOf<CampaignId>();
    });
});
