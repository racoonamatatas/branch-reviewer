// Repo access abstraction plus the real GitHub REST implementation.
// The compare endpoint uses three-dot semantics (merge-base), so the diff
// only contains what the branch itself changed.
// RepoClient and its implementation are ported verbatim from
// branch-reviewer-api — deliberately identical, so the two reviewers differ
// only in harness. PullSource is this project's own addition (the trigger
// slice needs to see PRs, the review path never does); it is a separate
// interface so the review-tool contract stays the verbatim port.

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

    async compare(base: string, head: string): Promise<ChangedFile[]>
    {
        const files: ChangedFile[] = [];
        for (let page = 1; files.length < MAX_FILES; page++)
        {
            const data = await this.request(
                `/repos/${this.owner}/${this.repo}/compare/${base}...${head}?per_page=${PAGE_SIZE}&page=${page}`,
            ) as { files?: RawChangedFile[] };
            const batch = data.files ?? [];
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
            `/repos/${this.owner}/${this.repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
        ) as { type?: string; content?: string; encoding?: string };
        if (data.type !== 'file' || typeof data.content !== 'string' || data.encoding !== 'base64')
        {
            throw new Error(`Not a readable file: ${path}`);
        }
        return Buffer.from(data.content, 'base64').toString('utf8');
    }

    async listOpenPulls(): Promise<PullRequest[]>
    {
        const pulls: PullRequest[] = [];
        for (let page = 1; ; page++)
        {
            const batch = await this.request(
                `/repos/${this.owner}/${this.repo}/pulls?state=open&per_page=${PAGE_SIZE}&page=${page}`,
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
