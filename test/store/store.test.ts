import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReviewStore } from '../../src/store/store.js';
import type { RunRecord } from '../../src/store/store.js';

const submittedRun: RunRecord = {
    createdAt: '2026-08-05T15:00:00.000Z',
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

const abortedRun: RunRecord = {
    createdAt: '2026-08-05T16:00:00.000Z',
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
        const id = store.saveRun(submittedRun);

        const stored = store.getRun(id);

        expect(stored).toEqual({ id, ...submittedRun });
    });

    it('should round-trip an aborted run without a review', () =>
    {
        const id = store.saveRun(abortedRun);

        const stored = store.getRun(id);

        expect(stored).toEqual({ id, ...abortedRun });
        expect(stored?.review).toBeUndefined();
    });

    it('should keep optional finding fields absent, not null', () =>
    {
        const id = store.saveRun(submittedRun);

        const finding = store.getRun(id)?.review?.findings[1];

        expect(finding).not.toHaveProperty('line');
        expect(finding).not.toHaveProperty('suggestion');
    });

    it('should list runs newest-first with findings counts', () =>
    {
        const first = store.saveRun(submittedRun);
        const second = store.saveRun(abortedRun);

        const summaries = store.listRuns();

        expect(summaries.map(s => s.id)).toEqual([second, first]);
        expect(summaries[1]).toEqual({
            id: first,
            createdAt: submittedRun.createdAt,
            target: 'acme/widgets feature-x → main',
            status: 'submitted',
            findingsCount: 2,
            costUsd: 2.5,
        });
        expect(summaries[0]!.findingsCount).toBe(0);
    });

    it('should return undefined for an unknown run id', () =>
    {
        expect(store.getRun(999)).toBeUndefined();
    });
});
