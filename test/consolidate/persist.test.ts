import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { submittedRunsFor } from '../../src/consolidate/persist.js';
import { ReviewStore } from '../../src/store/store.js';
import type { NewRun } from '../../src/store/store.js';

const TARGET = { owner: 'acme', repo: 'widgets', head: 'feature-x', base: 'main' };

function newRun(overrides: Partial<NewRun> = {}): NewRun
{
    return {
        ...TARGET,
        model: 'test-model',
        status: 'submitted',
        review: { summary: 'reviewed', findings: [] },
        turns: 5,
        costUsd: 1,
        usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        filesChanged: 3,
        ...overrides,
    } as NewRun;
}

describe('submittedRunsFor', () =>
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

    it('should exclude reviewed-nothing runs from the union', () =>
    {
        // Arrange: a real sample, an empty-diff short-circuit, and an abort.
        const sample = store.saveRun(newRun());
        store.saveRun(newRun({ filesChanged: 0 }));
        store.saveRun(newRun({ status: 'aborted', reason: 'error_max_turns', review: undefined }));

        // Act
        const runs = submittedRunsFor(store, TARGET);

        // Assert: the empty-diff run reviewed nothing — it is not a sample,
        // and must not inflate the verifier's 1-of-N denominator or churn
        // verifyTarget's reuse check.
        expect(runs.map(r => r.id)).toEqual([sample]);
    });

    it('should keep legacy rows that predate the filesChanged column', () =>
    {
        // Arrange: no filesChanged at all — absence of the tell is not the tell.
        const legacy = newRun();
        delete legacy.filesChanged;
        const id = store.saveRun(legacy);

        // Act + Assert
        expect(submittedRunsFor(store, TARGET).map(r => r.id)).toEqual([id]);
    });

    it('should match the full quad, base included', () =>
    {
        // Arrange
        const onMain = store.saveRun(newRun());
        store.saveRun(newRun({ base: 'develop' }));

        // Act + Assert
        expect(submittedRunsFor(store, TARGET).map(r => r.id)).toEqual([onMain]);
    });
});
