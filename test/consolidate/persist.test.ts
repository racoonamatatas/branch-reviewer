import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { consolidateRuns, submittedRunsFor } from '../../src/consolidate/persist.js';
import type { ClusterProposal } from '../../src/consolidate/consolidate.js';
import type { NewFinding } from '../../src/schema/schema.js';
import { ReviewStore } from '../../src/store/store.js';
import type { NewRun } from '../../src/store/store.js';
import type { Target } from '../../src/types/target.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));

const target: Target = { owner: 'acme', repo: 'widgets', head: 'feature-x', base: 'main' };

function newRun(findings: NewFinding[], overrides: Partial<NewRun> = {}): NewRun
{
    return {
        ...target,
        model: 'test',
        status: 'submitted',
        review: { summary: 'test', findings },
        turns: 1,
        costUsd: 0,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        ...overrides,
    } as NewRun;
}

const someFinding: NewFinding = { file: 'src/a.ts', severity: 'nit', title: 'claim', detail: 'evidence' };

let store: ReviewStore;

beforeEach(() =>
{
    store = new ReviewStore(':memory:');
    for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'])
    {
        delete process.env[name];
    }
    vi.mocked(query).mockReset();
});

afterEach(() =>
{
    store.close();
});

describe('submittedRunsFor', () =>
{
    it('should return only the quad\'s submitted runs, oldest first', () =>
    {
        // Arrange: a matching pair (saved newest-capable order), plus every
        // way a run can fail to belong — aborted, other head, other base.
        const first = store.saveRun(newRun([someFinding]));
        store.saveRun(newRun([], { status: 'aborted', reason: 'error_max_turns' }));
        store.saveRun(newRun([someFinding], { head: 'other-branch' }));
        store.saveRun(newRun([someFinding], { base: 'release/2.0' }));
        const second = store.saveRun(newRun([someFinding]));

        // Act
        const runs = submittedRunsFor(store, target);

        // Assert
        expect(runs.map(r => r.id)).toEqual([first, second]);
    });
});

describe('consolidateRuns', () =>
{
    function judgeStream(clusters: ClusterProposal[], costUsd = 0.2): ReturnType<typeof query>
    {
        async function* stream(): AsyncGenerator<unknown>
        {
            yield { type: 'result', subtype: 'success', is_error: false, total_cost_usd: costUsd, structured_output: { clusters } };
        }
        return stream() as unknown as ReturnType<typeof query>;
    }

    it('should return undefined without calling the judge when the runs have no findings', async () =>
    {
        // Arrange
        const bare = store.saveRun(newRun([]));

        // Act
        const consolidation = await consolidateRuns(store, target, [store.getRun(bare)!]);

        // Assert: a judge call over nothing is not a consolidation — and
        // costs nothing.
        expect(consolidation).toBeUndefined();
        expect(vi.mocked(query)).not.toHaveBeenCalled();
        expect(store.listConsolidations()).toEqual([]);
    });

    it('should persist the validated partition with occurrence, max severity, and the judge cost', async () =>
    {
        // Arrange: two runs; the judge groups one finding from each and
        // leaves the third alone.
        const runA = store.saveRun(newRun([
            { ...someFinding, severity: 'warning', title: 'shared defect' },
            { ...someFinding, file: 'src/b.ts', title: 'only A saw this' },
        ]));
        const runB = store.saveRun(newRun([{ ...someFinding, severity: 'critical', title: 'shared defect, other angle' }]));
        const [a1, a2] = store.getFindings(runA);
        const [b1] = store.getFindings(runB);
        vi.mocked(query).mockReturnValueOnce(judgeStream([
            { memberIds: [a1!.id, b1!.id], representativeId: b1!.id },
            { memberIds: [a2!.id], representativeId: a2!.id },
        ], 0.35));

        // Act
        const consolidation = await consolidateRuns(store, target, [store.getRun(runA)!, store.getRun(runB)!]);

        // Assert: read back from rows, not the in-memory proposal.
        expect(consolidation?.costUsd).toBe(0.35);
        expect(consolidation?.runIds).toEqual([runA, runB]);
        expect(consolidation?.clusters[0]).toMatchObject({ severity: 'critical', occurrence: 2 });
        expect(consolidation?.clusters[0]?.representative.id).toBe(b1!.id);
        expect(consolidation?.clusters[1]).toMatchObject({ severity: 'nit', occurrence: 1 });
    });
});
