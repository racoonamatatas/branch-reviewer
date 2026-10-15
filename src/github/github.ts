// Repo access abstraction plus the real GitHub REST implementation.
// The compare endpoint uses three-dot semantics (merge-base), so the diff
// only contains what the branch itself changed.
// RepoClient began as a verbatim port from branch-reviewer-api, so the two
// reviewers differed only in harness. listFiles is this project's first
// deliberate departure: the verifier is asked for evidence in files the diff
// never touched (CI, deploy manifests, env templates), and a read tool that
// can only fetch exact paths forces it to guess — a capability gap the port
// inherited and the predecessor never fixed. The second departure is a
// wire-shape fix: compare() throws when GitHub omits the `files` key instead
// of reading it as an empty diff (see below) — no behavior change for any
// compare GitHub can fully enumerate. PullSource is likewise this project's
// own addition (the trigger slice needs to see PRs, the review path never
// does); a separate interface so the review-tool contract stays the port.

export interface ChangedFile
{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    patch?: string;  // unified diff hunk; absent for binary or oversized files
}

export interface RepoClient
{
    compare(base: string, head: string): Promise<ChangedFile[]>;
    readFile(path: string, ref: string): Promise<string>;
    // Every file path in the repository at a ref — the map that makes
    // read_file navigable. `truncated` is GitHub's own flag for a tree too
    // large to list in one response; the caller must say so rather than
    // present a partial map as the whole repo.
    listFiles(ref: string): Promise<{ paths: string[]; truncated: boolean }>;
}

// What the trigger needs to know about an open PR to decide "review this?".
// Labels are the gate, head SHA is the dedupe key, draft is the skip.
export interface PullRequest
{
    number: number;
    title: string;
    headSha: string;
    headRef: string;
    baseRef: string;
    draft: boolean;
    labels: string[];
}

export interface PullSource
{
    listOpenPulls(): Promise<PullRequest[]>;
}

const API_VERSION = '2022-11-28';
const PAGE_SIZE = 100;
const MAX_FILES = 300;  // the compare endpoint stops listing files past this

interface RawChangedFile
{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    patch?: string;
}

interface RawPull
{
    number: number;
    title: string;
    draft?: boolean;
    head: { sha: string; ref: string };
    base: { ref: string };
    labels?: Array<{ name: string }>;
}

export class GitHubClient implements RepoClient, PullSource
{
    private readonly owner: string;
    private readonly repo: string;
    private readonly token: string | undefined;

    constructor(owner: string, repo: string, token?: string)
    {
        this.owner = owner;
        this.repo = repo;
        this.token = token;
    }

    // owner/repo arrive from untrusted job input (an HTTP body, a stored
    // params column) — interpolated raw, a crafted value rewrites the
    // request path. Encoded, the worst a bad value can do is 404.
    private repoPath(): string
    {
        return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}`;
    }

    async compare(base: string, head: string): Promise<ChangedFile[]>
    {
        const files: ChangedFile[] = [];
        for (let page = 1; files.length < MAX_FILES; page++)
        {
            const data = await this.request(
                `${this.repoPath()}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=${PAGE_SIZE}&page=${page}`,
            ) as { files?: RawChangedFile[] };
            // GitHub omits `files` entirely when the comparison is too large
            // to enumerate. Collapsing that into [] would read as an empty
            // diff — which downstream is now a terminal success (status
            // 'empty', job succeeded, head SHA never re-enqueued), so an
            // unreviewed branch would vanish without a failure signal.
            // Throwing fails the run/job loudly and leaves it retryable.
            // Only page 1 can mean that: `per_page` pages commits, not files,
            // so a 120-file compare lists all 120 on page 1 and page 2 drops
            // the key — a missing list past page 1 is the end of it (found
            // live: the first campaign on a 114-commit history failed two
            // rounds in two seconds, no credit spent).
            if (data.files === undefined && page > 1)
            {
                break;
            }
            if (data.files === undefined)
            {
                throw new Error(`GitHub omitted the files list for ${base}...${head} (comparison too large to enumerate?) — cannot distinguish this from an empty diff, refusing to report one.`);
            }
            const batch = data.files;
            for (const f of batch)
            {
                files.push({
                    filename: f.filename,
                    status: f.status,
                    additions: f.additions,
                    deletions: f.deletions,
                    patch: f.patch,
                });
            }
            if (batch.length < PAGE_SIZE)
            {
                break;
            }
        }
        return files;
    }

    async readFile(path: string, ref: string): Promise<string>
    {
        const encodedPath = path.split('/').map(encodeURIComponent).join('/');
        const data = await this.request(
            `${this.repoPath()}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
        ) as { type?: string; content?: string; encoding?: string };
        if (data.type !== 'file' || typeof data.content !== 'string' || data.encoding !== 'base64')
        {
            throw new Error(`Not a readable file: ${path}`);
        }
        return Buffer.from(data.content, 'base64').toString('utf8');
    }

    async listFiles(ref: string): Promise<{ paths: string[]; truncated: boolean }>
    {
        const data = await this.request(
            `${this.repoPath()}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
        ) as { tree?: Array<{ path: string; type: string }>; truncated?: boolean };
        return {
            paths: (data.tree ?? []).filter(entry => entry.type === 'blob').map(entry => entry.path),
            truncated: data.truncated ?? false,
        };
    }

    async listOpenPulls(): Promise<PullRequest[]>
    {
        const pulls: PullRequest[] = [];
        for (let page = 1; ; page++)
        {
            const batch = await this.request(
                `${this.repoPath()}/pulls?state=open&per_page=${PAGE_SIZE}&page=${page}`,
            ) as RawPull[];
            for (const p of batch)
            {
                pulls.push({
                    number: p.number,
                    title: p.title,
                    headSha: p.head.sha,
                    headRef: p.head.ref,
                    baseRef: p.base.ref,
                    draft: p.draft ?? false,
                    labels: (p.labels ?? []).map(label => label.name),
                });
            }
            if (batch.length < PAGE_SIZE)
            {
                return pulls;
            }
        }
    }

    private async request(path: string): Promise<unknown>
    {
        const headers: Record<string, string> = {
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': API_VERSION,
            'User-Agent': 'branch-reviewer',
        };
        if (this.token !== undefined && this.token !== '')
        {
            headers['Authorization'] = `Bearer ${this.token}`;
        }

        const response = await fetch(`https://api.github.com${path}`, { headers });
        if (!response.ok)
        {
            const rateLimited = response.status === 403
                && response.headers.get('x-ratelimit-remaining') === '0';
            const hint = rateLimited
                ? ' (rate limit exhausted — set GITHUB_TOKEN for higher limits)'
                : '';
            throw new Error(`GitHub API ${response.status} for ${path}${hint}`);
        }
        return response.json();
    }
}
