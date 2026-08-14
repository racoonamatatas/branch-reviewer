import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { RepoClient } from '../../src/github/github.js';
import { assertSubscriptionCredit, runReview, throwIfErrorResult } from '../../src/review/review.js';

// Every credential variable the assertions read; saved and restored around
// each test so the suite never depends on (or leaks into) the real shell env.
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

describe('assertSubscriptionCredit', () =>
{
    it('should pass when no credential variables are set', () =>
    {
        // Act + Assert
        expect(() => assertSubscriptionCredit()).not.toThrow();
    });

    it('should refuse ANTHROPIC_API_KEY', () =>
    {
        // Arrange
        process.env.ANTHROPIC_API_KEY = 'sk-ant-something';

        // Act + Assert
        expect(() => assertSubscriptionCredit()).toThrow('ANTHROPIC_API_KEY is set');
    });

    it('should refuse ANTHROPIC_AUTH_TOKEN', () =>
    {
        // Arrange
        process.env.ANTHROPIC_AUTH_TOKEN = 'gateway-token';

        // Act + Assert
        expect(() => assertSubscriptionCredit()).toThrow('ANTHROPIC_AUTH_TOKEN is set');
    });

    it('should treat an empty string as unset', () =>
    {
        // Arrange
        process.env.ANTHROPIC_API_KEY = '';
        process.env.ANTHROPIC_AUTH_TOKEN = '';

        // Act + Assert
        expect(() => assertSubscriptionCredit()).not.toThrow();
    });

    it('should pass when only CLAUDE_CODE_OAUTH_TOKEN is set', () =>
    {
        // Arrange: the headless-auth path — subscription credit by construction.
        process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-token';

        // Act + Assert
        expect(() => assertSubscriptionCredit()).not.toThrow();
    });

    it('should refuse an API key even when the OAuth token is also set', () =>
    {
        // Arrange: precedence between the two is undocumented — still ambiguous.
        process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-token';
        process.env.ANTHROPIC_API_KEY = 'sk-ant-something';

        // Act + Assert
        expect(() => assertSubscriptionCredit()).toThrow('ANTHROPIC_API_KEY is set');
    });
});

// Only the fields throwIfErrorResult reads; the full SDKResultMessage has
// dozens of stat fields irrelevant to the discrimination under test.
function successResult(overrides: { is_error: boolean; result: string }): SDKResultMessage
{
    return { type: 'result', subtype: 'success', ...overrides } as SDKResultMessage;
}

describe('throwIfErrorResult', () =>
{
    it('should pass a genuine success result through', () =>
    {
        // Act + Assert
        expect(() => throwIfErrorResult(successResult({ is_error: false, result: 'done' }))).not.toThrow();
    });

    it('should pass error subtypes through: the abort path owns those', () =>
    {
        // Arrange
        const aborted = { type: 'result', subtype: 'error_max_turns', is_error: true } as SDKResultMessage;

        // Act + Assert
        expect(() => throwIfErrorResult(aborted)).not.toThrow();
    });

    it('should throw on an is_error result carrying the success subtype', () =>
    {
        // Arrange: the unauthenticated shape observed on SDK 0.3.222.
        const unauthenticated = successResult({ is_error: true, result: 'Not logged in · Please run /login' });

        // Act + Assert
        expect(() => throwIfErrorResult(unauthenticated)).toThrow('Not logged in');
    });

    it('should point at CLAUDE_CODE_OAUTH_TOKEN when not logged in and no token is set', () =>
    {
        // Arrange
        const unauthenticated = successResult({ is_error: true, result: 'Not logged in · Please run /login' });

        // Act + Assert: the SDK's own advice (/login) presumes a terminal.
        expect(() => throwIfErrorResult(unauthenticated)).toThrow('claude setup-token');
    });

    it('should omit the headless hint when a token is set: the token itself is the suspect', () =>
    {
        // Arrange
        process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-token';
        const unauthenticated = successResult({ is_error: true, result: 'Not logged in · Please run /login' });

        // Act + Assert
        expect(() => throwIfErrorResult(unauthenticated)).not.toThrow('claude setup-token');
        expect(() => throwIfErrorResult(unauthenticated)).toThrow('Not logged in');
    });

    it('should omit the headless hint for other is_error results', () =>
    {
        // Arrange
        const other = successResult({ is_error: true, result: 'Some other terminal failure' });

        // Act + Assert
        expect(() => throwIfErrorResult(other)).toThrow('Some other terminal failure');
        expect(() => throwIfErrorResult(other)).not.toThrow('claude setup-token');
    });
});
