import { describe, expect, it } from 'vitest';
import type { Cluster, Finding, VerificationStatus } from '../../src/store/store.js';
import { clusterId, findingId, runId } from '../../src/types/ids.js';
import { buildVerificationPrompt, pendingOccurrenceOne, verificationResponseSchema } from '../../src/verify/verify.js';

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

describe('pendingOccurrenceOne', () =>
{
    it('should keep only pending occurrence-1 clusters', () =>
    {
        // Arrange
        const clusters = [cluster(1, 1), cluster(2, 3), cluster(3, 1)];

        // Act
        const selected = pendingOccurrenceOne(clusters);

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
        const selected = pendingOccurrenceOne(clusters);

        // Assert
        expect(selected).toEqual([]);
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
