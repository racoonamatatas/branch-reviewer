import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubClient } from '../../src/github/github.js';

// compare and readFile are the verbatim port from branch-reviewer-api and
// deliberately stay untouched (and untested here); listOpenPulls and
// listFiles are this project's own additions.

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

describe('listFiles', () =>
{
    it('should return blob paths only, carrying the truncation flag through', async () =>
    {
        // Arrange: trees mix blobs and tree (directory) entries.
        let requested = '';
        vi.stubGlobal('fetch', vi.fn(async (url: string | URL) =>
        {
            requested = String(url);
            return new Response(JSON.stringify({
                tree: [
                    { path: 'src', type: 'tree' },
                    { path: 'src/auth.ts', type: 'blob' },
                    { path: '.github/workflows/ci.yml', type: 'blob' },
                ],
                truncated: false,
            }), { status: 200 });
        }));

        // Act
        const result = await new GitHubClient('acme', 'widgets').listFiles('feature/x');

        // Assert: recursive tree at the ref, directories dropped.
        expect(result).toEqual({ paths: ['src/auth.ts', '.github/workflows/ci.yml'], truncated: false });
        expect(requested).toContain('/repos/acme/widgets/git/trees/feature%2Fx?recursive=1');
    });

    it('should encode owner and repo so untrusted job input cannot rewrite the request path', async () =>
    {
        // Arrange: owner/repo reach the client verbatim from an HTTP body or
        // a stored job row — path metacharacters must not survive into the URL.
        let requested = '';
        vi.stubGlobal('fetch', vi.fn(async (url: string | URL) =>
        {
            requested = String(url);
            return new Response(JSON.stringify({ tree: [], truncated: false }), { status: 200 });
        }));

        // Act
        await new GitHubClient('acme/../evil', 'widgets?x=1').listFiles('main');

        // Assert
        expect(requested).toContain('/repos/acme%2F..%2Fevil/widgets%3Fx%3D1/git/trees/main');
    });

    it('should surface GitHub\'s truncation flag', async () =>
    {
        // Arrange
        vi.stubGlobal('fetch', vi.fn(async () => new Response(
            JSON.stringify({ tree: [{ path: 'a.ts', type: 'blob' }], truncated: true }), { status: 200 })));

        // Act
        const result = await new GitHubClient('acme', 'huge').listFiles('main');

        // Assert
        expect(result.truncated).toBe(true);
    });
});
