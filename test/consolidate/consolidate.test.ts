import { describe, expect, it } from 'vitest';
import { buildJudgePrompt, distinctRuns, maxSeverity, validatePartition } from '../../src/consolidate/consolidate.js';
import type { Cluster, ConsolidatableFinding } from '../../src/consolidate/consolidate.js';
import { findingId, runId } from '../../src/types/ids.js';

function finding(id: number, run: number, overrides: Partial<ConsolidatableFinding> = {}): ConsolidatableFinding
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

function cluster(memberIds: number[], representativeId: number): Cluster
{
    return { memberIds: memberIds.map(findingId), representativeId: findingId(representativeId) };
}

const findings = [finding(1, 100), finding(2, 100), finding(3, 200)];

describe('buildJudgePrompt', () =>
{
    it('should include id, run, severity, location, title and detail for each finding', () =>
    {
        // Act
        const prompt = buildJudgePrompt(findings);

        // Assert
        expect(prompt).toContain('Cluster these 3 findings.');
        expect(prompt).toContain('id 1 (run 100) [warning] src/a.ts:10 — Finding 1');
        expect(prompt).toContain('Detail 3');
    });

    it('should omit the line anchor when a finding has none', () =>
    {
        // Arrange
        const lineless = finding(7, 100, { line: undefined });

        // Act
        const prompt = buildJudgePrompt([lineless]);

        // Assert
        expect(prompt).toContain('src/a.ts — Finding 7');
    });
});

describe('validatePartition', () =>
{
    it('should accept a complete one-to-one partition', () =>
    {
        // Arrange
        const clusters: Cluster[] = [cluster([1, 3], 3), cluster([2], 2)];

        // Act
        const violation = validatePartition(findings, clusters);

        // Assert
        expect(violation).toBeUndefined();
    });

    it('should reject an unknown finding id', () =>
    {
        // Arrange
        const clusters: Cluster[] = [cluster([1, 2, 3, 4], 1)];

        // Act
        const violation = validatePartition(findings, clusters);

        // Assert
        expect(violation).toContain('not an input finding id');
    });

    it('should reject a finding placed in two clusters', () =>
    {
        // Arrange
        const clusters: Cluster[] = [cluster([1, 2], 1), cluster([2, 3], 3)];

        // Act
        const violation = validatePartition(findings, clusters);

        // Assert
        expect(violation).toContain('more than one cluster');
    });

    it('should reject a missing finding', () =>
    {
        // Arrange
        const clusters: Cluster[] = [cluster([1, 2], 1)];

        // Act
        const violation = validatePartition(findings, clusters);

        // Assert
        expect(violation).toContain('missing from every cluster: 3');
    });

    it('should reject a representative that is not a member', () =>
    {
        // Arrange
        const clusters: Cluster[] = [cluster([1, 2], 3), cluster([3], 3)];

        // Act
        const violation = validatePartition(findings, clusters);

        // Assert
        expect(violation).toContain('representative 3 is not a member');
    });
});

describe('maxSeverity', () =>
{
    it('should rank critical over warning over nit', () =>
    {
        // Act
        const highest = maxSeverity(['nit', 'critical', 'warning']);
        const middle = maxSeverity(['nit', 'warning']);
        const lowest = maxSeverity(['nit', 'nit']);

        // Assert
        expect(highest).toBe('critical');
        expect(middle).toBe('warning');
        expect(lowest).toBe('nit');
    });
});

describe('distinctRuns', () =>
{
    it('should count distinct source runs, not members', () =>
    {
        // Arrange
        const sameRunTwice = [finding(1, 100), finding(2, 100), finding(3, 200)];

        // Act
        const runs = distinctRuns(sameRunTwice);

        // Assert
        expect(runs).toBe(2);
    });
});
