import { describe, expect, it } from 'vitest';
import type { Cluster, Finding, VerificationStatus } from '../../src/store/store.js';
import { clusterId, findingId, runId } from '../../src/types/ids.js';
import { buildVerificationPrompt, verificationQueue, verificationResponseSchema } from '../../src/verify/verify.js';

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
