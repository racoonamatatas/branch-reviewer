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
    listFilesCalls = 0;
    files: ChangedFile[] = changedFiles;
    fileContents: Record<string, string> = { 'src/session.ts': 'export const refresh = () => {};' };
    treePaths: string[] = ['src/auth.ts', 'src/session.ts', '.github/workflows/deploy.yml', 'README.md'];
    treeTruncated = false;

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

    async listFiles(): Promise<{ paths: string[]; truncated: boolean }>
    {
        this.listFilesCalls++;
        return { paths: this.treePaths, truncated: this.treeTruncated };
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
    it('should register exactly the four read tools', () =>
    {
        // Arrange
        const { tools } = setup();

        // Act
        const names = tools.defs.map(d => d.name).sort();

        // Assert
        expect(names).toEqual(['get_diff', 'list_changed_files', 'list_files', 'read_file']);
    });

    it('should mark every tool read-only', () =>
    {
        // Arrange
        const { tools } = setup();

        // Act
        const hints = tools.defs.map(d => d.annotations?.readOnlyHint);

        // Assert
        expect(hints).toEqual([true, true, true, true]);
    });

    it('should list changed files with status and line counts', async () =>
    {
        // Arrange
        const { tools } = setup();

        // Act
        const result = await execute(tools, 'list_changed_files');

        // Assert
        expect(result).toContain('modified');
        expect(result).toContain('+10 -2');
        expect(result).toContain('src/auth.ts');
        expect(result).toContain('assets/logo.png');
    });

    it('should return a single file diff when file is passed', async () =>
    {
        // Arrange
        const { tools } = setup();

        // Act
        const result = await execute(tools, 'get_diff', { file: 'src/auth.ts' });

        // Assert
        expect(result).toContain('const timeout = 60;');
        expect(result).not.toContain('logo.png');
    });

    it('should mark files that have no textual diff', async () =>
    {
        // Arrange
        const { tools } = setup();

        // Act
        const result = await execute(tools, 'get_diff', { file: 'assets/logo.png' });

        // Assert
        expect(result).toContain('no textual diff');
    });

    it('should reject a diff request for a file the branch did not change', async () =>
    {
        // Arrange
        const { tools } = setup();

        // Act
        const result = execute(tools, 'get_diff', { file: 'src/other.ts' });

        // Assert
        await expect(result).rejects.toThrow('not in the changed-file list');
    });

    it('should read a file at the branch head', async () =>
    {
        // Arrange
        const { tools } = setup();

        // Act
        const result = await execute(tools, 'read_file', { path: 'src/session.ts' });

        // Assert
        expect(result).toBe('export const refresh = () => {};');
    });

    it('should fetch the comparison only once across tool calls', async () =>
    {
        // Arrange
        const { client, tools } = setup();

        // Act
        await execute(tools, 'list_changed_files');
        await execute(tools, 'get_diff');
        await execute(tools, 'get_diff', { file: 'src/auth.ts' });

        // Assert
        expect(client.compareCalls).toBe(1);
    });

    it('should list the whole repository tree, not just changed files', async () =>
    {
        // Arrange
        const { tools } = setup();

        // Act
        const result = await execute(tools, 'list_files');

        // Assert: deploy.yml is nowhere in the diff — that is the point.
        expect(result).toContain('.github/workflows/deploy.yml');
        expect(result).toContain('README.md');
    });

    it('should filter the tree by prefix and say so when nothing matches', async () =>
    {
        // Arrange
        const { tools } = setup();

        // Act
        const filtered = await execute(tools, 'list_files', { prefix: '.github/' });
        const empty = await execute(tools, 'list_files', { prefix: 'terraform/' });

        // Assert
        expect(filtered).toBe('.github/workflows/deploy.yml');
        expect(empty).toContain('No files under "terraform/"');
    });

    it('should disclose a truncated tree instead of presenting a partial map as the repo', async () =>
    {
        // Arrange
        const { client, tools } = setup();
        client.treeTruncated = true;

        // Act
        const result = await execute(tools, 'list_files');

        // Assert
        expect(result).toContain('too large for GitHub to list completely');
    });

    it('should fetch the tree only once across list_files calls', async () =>
    {
        // Arrange
        const { client, tools } = setup();

        // Act
        await execute(tools, 'list_files');
        await execute(tools, 'list_files', { prefix: 'src/' });

        // Assert
        expect(client.listFilesCalls).toBe(1);
    });

    it('should truncate oversized results with an explicit marker', async () =>
    {
        // Arrange
        const { client, tools } = setup();
        client.fileContents['src/huge.ts'] = 'x'.repeat(100_000);

        // Act
        const result = await execute(tools, 'read_file', { path: 'src/huge.ts' });

        // Assert
        expect(result.length).toBeLessThan(100_000);
        expect(result).toContain('[truncated');
    });
});
