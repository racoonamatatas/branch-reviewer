// The three read tools, same names and behavior as branch-reviewer-api, but
// registered through the SDK: tool() + Zod replaces hand-written JSON Schema,
// manual typeof checks, and the switch dispatch. The harness validates args
// and routes calls; only the tool bodies are ours.

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { AnyZodRawShape, McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { ChangedFile, RepoClient } from '../github/github.js';

// Cap on any single tool result, so one huge diff can't flood the context window.
const MAX_RESULT_CHARS = 30_000;

export const SERVER_NAME = 'github';

export interface ReviewTarget
{
    base: string;
    head: string;
}

// Erased view of SdkMcpToolDefinition: a heterogeneous list of tool() results
// won't type as SdkMcpToolDefinition<any> (handler args are contravariant),
// but every tool() result and the SDK's tools option both accept this shape.
export interface RegisteredTool
{
    name: string;
    description: string;
    inputSchema: AnyZodRawShape;
    annotations?: ToolAnnotations;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (args: any, extra: unknown) => Promise<CallToolResult>;
}

export interface ReviewTools
{
    server: McpSdkServerConfigWithInstance;
    // Exposed for tests: handlers are directly callable without a harness.
    defs: RegisteredTool[];
    // The memoized comparison the tools share — exposed so a runner can
    // measure the diff without buying a second paginated compare.
    changedFiles: () => Promise<ChangedFile[]>;
}

export function createReviewTools(client: RepoClient, target: ReviewTarget): ReviewTools
{
    // One comparison per review run: every tool shares the same snapshot.
    let comparePromise: Promise<ChangedFile[]> | undefined;
    const changedFiles = (): Promise<ChangedFile[]> =>
    {
        comparePromise ??= client.compare(target.base, target.head);
        return comparePromise;
    };

    const readOnly = { annotations: { readOnlyHint: true } };

    const defs: RegisteredTool[] = [
        tool(
            'list_changed_files',
            'List every file the branch changed, with status and added/removed line counts. Start here.',
            {},
            async () => text(formatFileList(await changedFiles())),
            readOnly,
        ),
        tool(
            'get_diff',
            'Get the unified diff of the branch against its merge base. Pass "file" for a single file\'s diff; omit it for the full diff.',
            { file: z.string().optional().describe('Path of one changed file. Omit for the whole diff.') },
            async ({ file }) => text(getDiff(await changedFiles(), file)),
            readOnly,
        ),
        tool(
            'read_file',
            'Read a file\'s full contents at the branch head. Use it to inspect context the diff alone does not show (callers, definitions, tests).',
            { path: z.string().describe('Repo-relative file path.') },
            async ({ path }) => text(await client.readFile(path, target.head)),
            readOnly,
        ),
    ];

    return { server: createSdkMcpServer({ name: SERVER_NAME, tools: defs }), defs, changedFiles };
}

function text(content: string): CallToolResult
{
    return { content: [{ type: 'text', text: truncate(content) }] };
}

function formatFileList(files: ChangedFile[]): string
{
    if (files.length === 0)
    {
        return 'No files changed.';
    }
    return files
        .map(f => `${f.status.padEnd(9)} +${f.additions} -${f.deletions}  ${f.filename}`)
        .join('\n');
}

function getDiff(files: ChangedFile[], file?: string): string
{
    if (file !== undefined)
    {
        const match = files.find(f => f.filename === file);
        if (match === undefined)
        {
            throw new Error(`${file} is not in the changed-file list`);
        }
        return match.patch ?? `(no textual diff for ${match.filename} — binary or too large)`;
    }
    return files
        .map(f => `--- ${f.filename} (${f.status})\n${f.patch ?? '(no textual diff — binary or too large)'}`)
        .join('\n\n');
}

function truncate(text: string): string
{
    if (text.length <= MAX_RESULT_CHARS)
    {
        return text;
    }
    return text.slice(0, MAX_RESULT_CHARS) + '\n[truncated: result exceeded size limit]';
}
