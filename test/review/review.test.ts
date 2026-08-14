import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RepoClient } from '../../src/github/github.js';
import { runReview } from '../../src/review/review.js';

// runReview asserts subscription credit before anything else; isolate the
// suite from the real shell env the same way the sdk tests do.
const CREDENTIAL_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'] as const;

let saved: Record<string, string | undefined>;

beforeEach(() =>
{
    saved = {};
    for (const name of CREDENTIAL_VARS)
    {
        saved[name] = process.env[name];
        delete process.env[name];
    }
});

afterEach(() =>
{
    for (const name of CREDENTIAL_VARS)
    {
        if (saved[name] === undefined)
        {
            delete process.env[name];
        }
        else
        {
            process.env[name] = saved[name];
        }
    }
});

describe('runReview', () =>
{
    it('should abort an empty diff as a cost fuse, before any credit moves', async () =>
    {
        // Arrange: a merged or stale head compares empty. No SDK mock is
        // needed — the fuse must fire before query() is ever reached.
        const client: RepoClient = {
            compare: async () => [],
            readFile: async () => '',
            listFiles: async () => ({ paths: [], truncated: false }),
        };

        // Act
        const result = await runReview(client, { base: 'main', head: 'feature/x' });

        // Assert
        expect(result).toMatchObject({ status: 'aborted', reason: 'empty-diff', filesChanged: 0 });
        expect(result.stats.costUsd).toBe(0);
        expect(result.stats.turns).toBe(0);
    });
});
