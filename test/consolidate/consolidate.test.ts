import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { buildJudgePrompt, distinctRuns, identityPartition, maxSeverity, runClustering, validatePartition } from '../../src/consolidate/consolidate.js';
import type { ClusterProposal } from '../../src/consolidate/consolidate.js';
import type { Finding } from '../../src/store/store.js';
import { findingId, runId } from '../../src/types/ids.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));

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

function cluster(memberIds: number[], representativeId: number): ClusterProposal
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
        const clusters: ClusterProposal[] = [cluster([1, 3], 3), cluster([2], 2)];

        // Act
        const violation = validatePartition(findings, clusters);

        // Assert
        expect(violation).toBeUndefined();
    });

    it('should reject an unknown finding id', () =>
    {
        // Arrange
        const clusters: ClusterProposal[] = [cluster([1, 2, 3, 4], 1)];

        // Act
        const violation = validatePartition(findings, clusters);

        // Assert
        expect(violation).toContain('not an input finding id');
    });

    it('should reject a finding placed in two clusters', () =>
    {
        // Arrange
        const clusters: ClusterProposal[] = [cluster([1, 2], 1), cluster([2, 3], 3)];

        // Act
        const violation = validatePartition(findings, clusters);

        // Assert
        expect(violation).toContain('more than one cluster');
    });

    it('should reject a missing finding', () =>
    {
        // Arrange
        const clusters: ClusterProposal[] = [cluster([1, 2], 1)];

        // Act
        const violation = validatePartition(findings, clusters);

        // Assert
        expect(violation).toContain('missing from every cluster: 3');
    });

    it('should reject a representative that is not a member', () =>
    {
        // Arrange
        const clusters: ClusterProposal[] = [cluster([1, 2], 3), cluster([3], 3)];

        // Act
        const violation = validatePartition(findings, clusters);

        // Assert
        expect(violation).toContain('representative 3 is not a member');
    });
});

describe('identityPartition', () =>
{
    it('should put every finding in its own cluster as its own representative', () =>
    {
        // Act
        const partition = identityPartition(findings);

        // Assert
        expect(partition).toEqual([cluster([1], 1), cluster([2], 2), cluster([3], 3)]);
        expect(validatePartition(findings, partition)).toBeUndefined();
    });
});

describe('runClustering', () =>
{
    // What judgeOnce expects to stream: one result message, success, with the
    // structured output the harness would have validated.
    function judgeStream(clusters: ClusterProposal[], costUsd = 0.1): ReturnType<typeof query>
    {
        async function* stream(): AsyncGenerator<unknown>
        {
            yield { type: 'result', subtype: 'success', is_error: false, total_cost_usd: costUsd, structured_output: { clusters } };
        }
        return stream() as unknown as ReturnType<typeof query>;
    }

    // assertSubscriptionCredit reads the real env — isolate it per test.
    let saved: Record<string, string | undefined>;

    beforeEach(() =>
    {
        saved = {};
        for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'])
        {
            saved[name] = process.env[name];
            delete process.env[name];
        }
        vi.mocked(query).mockReset();
    });

    afterEach(() =>
    {
        for (const [name, value] of Object.entries(saved))
        {
            if (value === undefined)
            {
                delete process.env[name];
            }
            else
            {
                process.env[name] = value;
            }
        }
    });

    it('should accept a valid partition on the first attempt, reporting its cost', async () =>
    {
        // Arrange
        const valid = [cluster([1, 3], 3), cluster([2], 2)];
        vi.mocked(query).mockReturnValueOnce(judgeStream(valid, 0.25));

        // Act
        const outcome = await runClustering(findings);

        // Assert
        expect(outcome.clusters).toEqual(valid);
        expect(outcome.costUsd).toBe(0.25);
        expect(vi.mocked(query)).toHaveBeenCalledTimes(1);
    });

    it('should retry once with the violation and accept a valid second partition, cost summed over attempts', async () =>
    {
        // Arrange
        const valid = [cluster([1], 1), cluster([2], 2), cluster([3], 3)];
        vi.mocked(query)
            .mockReturnValueOnce(judgeStream([cluster([1, 2], 1)], 0.2))
            .mockReturnValueOnce(judgeStream(valid, 0.3));
        const degradations: string[] = [];

        // Act
        const outcome = await runClustering(findings, { onDegraded: v => degradations.push(v) });

        // Assert: the retry prompt names the violation, the failed attempt
        // still cost real money, and a recovered judge is not a degradation.
        expect(outcome.clusters).toEqual(valid);
        expect(outcome.costUsd).toBeCloseTo(0.5);
        expect(vi.mocked(query)).toHaveBeenCalledTimes(2);
        const retryPrompt = (vi.mocked(query).mock.calls[1]![0] as { prompt: string }).prompt;
        expect(retryPrompt).toContain('previous partition was invalid');
        expect(retryPrompt).toContain('missing from every cluster: 3');
        expect(degradations).toEqual([]);
    });

    // A result message that ended without a partition — the max-turns cap.
    function cappedStream(costUsd: number): ReturnType<typeof query>
    {
        async function* stream(): AsyncGenerator<unknown>
        {
            yield { type: 'result', subtype: 'error_max_turns', is_error: false, total_cost_usd: costUsd };
        }
        return stream() as unknown as ReturnType<typeof query>;
    }

    it('should degrade instead of throwing when the judge caps out on turns, keeping the metered cost', async () =>
    {
        // Arrange: both attempts die on the turn cap — each still billed.
        vi.mocked(query)
            .mockReturnValueOnce(cappedStream(0.2))
            .mockReturnValueOnce(cappedStream(0.3));
        const degradations: string[] = [];

        // Act
        const outcome = await runClustering(findings, { onDegraded: v => degradations.push(v) });

        // Assert: identity fallback, both attempts' spend accounted for, and
        // the retry got the base prompt — a turn cap is not a partition
        // violation to feed back.
        expect(outcome.clusters).toEqual(identityPartition(findings));
        expect(outcome.costUsd).toBeCloseTo(0.2 + 0.3);
        expect(degradations).toEqual(['judge run failed: error_max_turns']);
        const retryPrompt = (vi.mocked(query).mock.calls[1]![0] as { prompt: string }).prompt;
        expect(retryPrompt).not.toContain('previous partition was invalid');
    });

    it('should recover when a capped first attempt is followed by a valid partition', async () =>
    {
        // Arrange
        const valid = [cluster([1, 3], 3), cluster([2], 2)];
        vi.mocked(query)
            .mockReturnValueOnce(cappedStream(0.2))
            .mockReturnValueOnce(judgeStream(valid, 0.3));
        const degradations: string[] = [];

        // Act
        const outcome = await runClustering(findings, { onDegraded: v => degradations.push(v) });

        // Assert
        expect(outcome.clusters).toEqual(valid);
        expect(outcome.costUsd).toBeCloseTo(0.2 + 0.3);
        expect(degradations).toEqual([]);
    });

    it('should fall back to the identity partition after two invalid attempts and report the degradation', async () =>
    {
        // Arrange
        vi.mocked(query)
            .mockReturnValueOnce(judgeStream([cluster([1, 2], 1)]))
            .mockReturnValueOnce(judgeStream([cluster([1, 2], 1)]));
        const degradations: string[] = [];

        // Act
        const outcome = await runClustering(findings, { onDegraded: v => degradations.push(v) });

        // Assert: the fallback is valid and conservative, and the caller is told.
        expect(outcome.clusters).toEqual(identityPartition(findings));
        expect(degradations).toEqual(['ids missing from every cluster: 3']);
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
