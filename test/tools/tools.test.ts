import { describe, expect, it } from 'vitest';
import { createReviewTools } from '../../src/tools/tools.js';
import type { ReviewTools } from '../../src/tools/tools.js';
import type { ChangedFile, RepoClient } from '../../src/github/github.js';

const changedFiles: ChangedFile[] = [
    { filename: 'src/auth.ts', status: 'modified', additions: 10, deletions: 2, patch: '@@ -40,3 +40,3 @@\n-const timeout = 3600;\n+const timeout = 60;' },
    { filename: 'assets/logo.png', status: 'added', additions: 0, deletions: 0 },
];

class FakeRepoClient implements RepoClient
{
    compareCalls = 0;
    files: ChangedFile[] = changedFiles;
    fileContents: Record<string, string> = { 'src/session.ts': 'export const refresh = () => {};' };

    async compare(): Promise<ChangedFile[]>
    {
        this.compareCalls++;
        return this.files;
    }

    async readFile(path: string): Promise<string>
    {
        const content = this.fileContents[path];
        if (content === undefined)
        {
            throw new Error(`404: ${path}`);
        }
        return content;
    }
}

// In the predecessor this went through the hand-rolled dispatch switch; here
// the harness owns dispatch, so tests call the registered handlers directly.
async function execute(tools: ReviewTools, name: string, args: Record<string, unknown> = {}): Promise<string>
{
    const def = tools.defs.find(d => d.name === name);
    if (def === undefined)
    {
        throw new Error(`No such tool registered: ${name}`);
    }
    const result = await def.handler(args, {});
    const block = result.content[0];
    if (block?.type !== 'text')
    {
        throw new Error('Expected a text result');
    }
    return block.text;
}

function setup()
{
    const client = new FakeRepoClient();
    const tools = createReviewTools(client, { base: 'main', head: 'feature-x' });
    return { client, tools };
}

describe('createReviewTools', () =>
{
    it('should register exactly the three read tools', () =>
    {
        const { tools } = setup();

        expect(tools.defs.map(d => d.name).sort())
            .toEqual(['get_diff', 'list_changed_files', 'read_file']);
    });

    it('should mark every tool read-only', () =>
    {
        const { tools } = setup();

        for (const def of tools.defs)
        {
            expect(def.annotations?.readOnlyHint).toBe(true);
        }
    });

    it('should list changed files with status and line counts', async () =>
    {
        const { tools } = setup();

        const result = await execute(tools, 'list_changed_files');

        expect(result).toContain('modified');
        expect(result).toContain('+10 -2');
        expect(result).toContain('src/auth.ts');
        expect(result).toContain('assets/logo.png');
    });

    it('should return a single file diff when file is passed', async () =>
    {
        const { tools } = setup();

        const result = await execute(tools, 'get_diff', { file: 'src/auth.ts' });

        expect(result).toContain('const timeout = 60;');
        expect(result).not.toContain('logo.png');
    });

    it('should mark files that have no textual diff', async () =>
    {
        const { tools } = setup();

        const result = await execute(tools, 'get_diff', { file: 'assets/logo.png' });

        expect(result).toContain('no textual diff');
    });

    it('should reject a diff request for a file the branch did not change', async () =>
    {
        const { tools } = setup();

        await expect(execute(tools, 'get_diff', { file: 'src/other.ts' }))
            .rejects.toThrow('not in the changed-file list');
    });

    it('should read a file at the branch head', async () =>
    {
        const { tools } = setup();

        const result = await execute(tools, 'read_file', { path: 'src/session.ts' });

        expect(result).toBe('export const refresh = () => {};');
    });

    it('should fetch the comparison only once across tool calls', async () =>
    {
        const { client, tools } = setup();

        await execute(tools, 'list_changed_files');
        await execute(tools, 'get_diff');
        await execute(tools, 'get_diff', { file: 'src/auth.ts' });

        expect(client.compareCalls).toBe(1);
    });

    it('should truncate oversized results with an explicit marker', async () =>
    {
        const { client, tools } = setup();
        client.fileContents['src/huge.ts'] = 'x'.repeat(100_000);

        const result = await execute(tools, 'read_file', { path: 'src/huge.ts' });

        expect(result.length).toBeLessThan(100_000);
        expect(result).toContain('[truncated');
    });
});
