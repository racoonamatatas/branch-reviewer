import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { assertSubscriptionCredit, requireResult, rethrowUnlessResultExplains, throwIfErrorResult } from '../../src/sdk/sdk.js';

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

describe('rethrowUnlessResultExplains', () =>
{
    const streamError = new Error('stream errored after the result');

    it('should rethrow the stream error when no result was ever seen', () =>
    {
        // Act + Assert
        expect(() => rethrowUnlessResultExplains(undefined, streamError)).toThrow('stream errored after the result');
    });

    it('should swallow the stream error when an error-subtype result explains it', () =>
    {
        // Arrange: the max-turns shape — the result carries the abort reason
        // and stats, which the caller must keep.
        const aborted = { type: 'result', subtype: 'error_max_turns', is_error: true } as SDKResultMessage;

        // Act + Assert
        expect(() => rethrowUnlessResultExplains(aborted, streamError)).not.toThrow();
    });

    it('should prefer the unauthenticated translation over the raw stream error', () =>
    {
        // Arrange
        const unauthenticated = successResult({ is_error: true, result: 'Not logged in · Please run /login' });

        // Act + Assert
        expect(() => rethrowUnlessResultExplains(unauthenticated, streamError)).toThrow('Not logged in');
    });

    it('should rethrow when the result was a genuine success: the error is unexplained', () =>
    {
        // Act + Assert
        expect(() => rethrowUnlessResultExplains(successResult({ is_error: false, result: 'done' }), streamError))
            .toThrow('stream errored after the result');
    });
});

describe('requireResult', () =>
{
    it('should throw when the stream ended with no result message', () =>
    {
        // Act + Assert
        expect(() => requireResult(undefined)).toThrow('ended without a result message');
    });

    it('should return the result it was given', () =>
    {
        // Arrange
        const result = successResult({ is_error: false, result: 'done' });

        // Act + Assert
        expect(requireResult(result)).toBe(result);
    });
});
