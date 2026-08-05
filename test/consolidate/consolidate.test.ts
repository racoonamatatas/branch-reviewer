import { describe, expect, it } from 'vitest';
import { buildJudgePrompt, distinctRuns, maxSeverity, validatePartition } from '../../src/consolidate/consolidate.js';
import type { Cluster, ConsolidatableFinding } from '../../src/consolidate/consolidate.js';

function finding(id: number, runId: number, overrides: Partial<ConsolidatableFinding> = {}): ConsolidatableFinding
{
    return {
        id,
        runId,
        file: 'src/a.ts',
        line: 10,
        severity: 'warning',
        title: `Finding ${id}`,
        detail: `Detail ${id}`,
        ...overrides,
    };
}

const findings = [finding(1, 100), finding(2, 100), finding(3, 200)];

describe('buildJudgePrompt', () =>
{
    it('should include id, run, severity, location, title and detail for each finding', () =>
    {
        const prompt = buildJudgePrompt(findings);

        expect(prompt).toContain('Cluster these 3 findings.');
        expect(prompt).toContain('id 1 (run 100) [warning] src/a.ts:10 — Finding 1');
        expect(prompt).toContain('Detail 3');
    });

    it('should omit the line anchor when a finding has none', () =>
    {
        const prompt = buildJudgePrompt([finding(7, 100, { line: undefined })]);

        expect(prompt).toContain('src/a.ts — Finding 7');
    });
});

describe('validatePartition', () =>
{
    it('should accept a complete one-to-one partition', () =>
    {
        const clusters: Cluster[] = [
            { memberIds: [1, 3], representativeId: 3 },
            { memberIds: [2], representativeId: 2 },
        ];

        expect(validatePartition(findings, clusters)).toBeUndefined();
    });

    it('should reject an unknown finding id', () =>
    {
        const clusters: Cluster[] = [{ memberIds: [1, 2, 3, 4], representativeId: 1 }];

        expect(validatePartition(findings, clusters)).toContain('not an input finding id');
    });

    it('should reject a finding placed in two clusters', () =>
    {
        const clusters: Cluster[] = [
            { memberIds: [1, 2], representativeId: 1 },
            { memberIds: [2, 3], representativeId: 3 },
        ];

        expect(validatePartition(findings, clusters)).toContain('more than one cluster');
    });

    it('should reject a missing finding', () =>
    {
        const clusters: Cluster[] = [{ memberIds: [1, 2], representativeId: 1 }];

        expect(validatePartition(findings, clusters)).toContain('missing from every cluster: 3');
    });

    it('should reject a representative that is not a member', () =>
    {
        const clusters: Cluster[] = [
            { memberIds: [1, 2], representativeId: 3 },
            { memberIds: [3], representativeId: 3 },
        ];

        expect(validatePartition(findings, clusters)).toContain('representative 3 is not a member');
    });
});

describe('maxSeverity', () =>
{
    it('should rank critical over warning over nit', () =>
    {
        expect(maxSeverity(['nit', 'critical', 'warning'])).toBe('critical');
        expect(maxSeverity(['nit', 'warning'])).toBe('warning');
        expect(maxSeverity(['nit', 'nit'])).toBe('nit');
    });
});

describe('distinctRuns', () =>
{
    it('should count distinct source runs, not members', () =>
    {
        expect(distinctRuns([finding(1, 100), finding(2, 100), finding(3, 200)])).toBe(2);
    });
});
