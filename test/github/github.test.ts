import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubClient } from '../../src/github/github.js';

// listOpenPulls is this project's own addition; readFile stays the untested
// verbatim port. compare() is tested only where it deliberately diverges
// from the port: the omitted-`files` guard (an empty diff is now a terminal
// success downstream, so a truncated compare payload must throw, never read
// as one).

function rawPull(number: number, overrides: Record<string, unknown> = {}): Record<string, unknown>
{
    return {
        number,
        title: `PR ${number}`,
        draft: false,
        head: { sha: `sha-${number}`, ref: `feature/${number}` },
        base: { ref: 'main' },
        labels: [],
        ...overrides,
    };
}

function stubFetch(pages: unknown[][]): ReturnType<typeof vi.fn>
{
    const mock = vi.fn(async (url: string | URL) =>
    {
        const page = Number(new URL(String(url)).searchParams.get('page'));
        return new Response(JSON.stringify(pages[page - 1] ?? []), { status: 200 });
    });
    vi.stubGlobal('fetch', mock);
    return mock;
}

afterEach(() =>
{
    vi.unstubAllGlobals();
});

describe('listOpenPulls', () =>
{
    it('should map the wire shape to PullRequest, defaulting absent fields', async () =>
    {
        // Arrange
        stubFetch([[
            rawPull(7, { labels: [{ name: 'agent-review' }, { name: 'bug' }] }),
            rawPull(8, { draft: undefined, labels: undefined }),
        ]]);

        // Act
        const pulls = await new GitHubClient('acme', 'widgets').listOpenPulls();

        // Assert
        expect(pulls).toEqual([
            {
                number: 7,
                title: 'PR 7',
                headSha: 'sha-7',
                headRef: 'feature/7',
                baseRef: 'main',
                draft: false,
                labels: ['agent-review', 'bug'],
            },
            {
                number: 8,
                title: 'PR 8',
                headSha: 'sha-8',
                headRef: 'feature/8',
                baseRef: 'main',
                draft: false,
                labels: [],
            },
        ]);
    });

    it('should paginate until a short page', async () =>
    {
        // Arrange: a full page of 100, then a short one.
        const first = Array.from({ length: 100 }, (_, i) => rawPull(i + 1));
        const mock = stubFetch([first, [rawPull(101)]]);

        // Act
        const pulls = await new GitHubClient('acme', 'widgets').listOpenPulls();

        // Assert
        expect(pulls).toHaveLength(101);
        expect(mock).toHaveBeenCalledTimes(2);
        expect(String(mock.mock.calls[0]?.[0])).toContain('/repos/acme/widgets/pulls?state=open');
    });

    it('should propagate an API error with the status named', async () =>
    {
        // Arrange
        vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));

        // Act + Assert
        await expect(new GitHubClient('acme', 'gone').listOpenPulls())
            .rejects.toThrow('GitHub API 404');
    });
});

describe('compare', () =>
{
    function stubCompare(body: unknown): void
    {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
    }

    it('should return an empty list for a compare that enumerates zero files', async () =>
    {
        // Arrange: `files: []` present — GitHub verified the diff is empty.
        stubCompare({ files: [] });

        // Act + Assert
        await expect(new GitHubClient('acme', 'widgets').compare('main', 'feature-x')).resolves.toEqual([]);
    });

    it('should throw when GitHub omits the files list instead of reporting an empty diff', async () =>
    {
        // Arrange: no `files` key at all — the oversized-comparison shape.
        stubCompare({ total_commits: 3 });

        // Act + Assert: downstream treats an empty diff as terminal success
        // (status 'empty', job succeeded, SHA never re-enqueued), so this
        // must fail loudly and stay retryable.
        await expect(new GitHubClient('acme', 'widgets').compare('main', 'feature-x'))
            .rejects.toThrow('omitted the files list');
    });
});
