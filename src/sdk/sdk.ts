// The SDK-facing utilities every query()-calling module shares: credit
// policy, error-result translation, and the stream-error rescue. Extracted
// from review.ts — verify and consolidate importing auth policy from the
// review *feature* made the review module a de-facto utility library.

import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';

// Which credential wins when both an API key and a subscription login are
// present is undocumented; refuse the ambiguous state so a run can never
// silently bill pay-as-you-go. ANTHROPIC_AUTH_TOKEN sits in the same SDK
// credential list (a gateway/proxy billing path — another way to silently
// not run on subscription) and is refused for the same reason.
// CLAUDE_CODE_OAUTH_TOKEN is the one deliberate exception: it is minted by
// `claude setup-token` against the subscription itself, so headless runs
// stay on subscription credit. Shared by every query()-calling module.
export function assertSubscriptionCredit(): void
{
    for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'])
    {
        if (process.env[name] !== undefined && process.env[name] !== '')
        {
            throw new Error(`${name} is set. This reviewer runs on subscription credit only — unset it to continue.`);
        }
    }
}

// An unauthenticated run surfaces as a zero-cost result with subtype
// 'success' but is_error set (observed on SDK 0.3.222: "Not logged in ·
// Please run /login") — the success/error split in `subtype` does not cover
// it, and left alone it dies later as an opaque Zod parse of an absent
// structured_output. Translate it here; the SDK's own advice (/login)
// presumes an interactive terminal, so point headless machines at the token.
export function throwIfErrorResult(result: SDKResultMessage): void
{
    if (result.subtype !== 'success' || !result.is_error)
    {
        return;
    }
    const headless = result.result.includes('Not logged in') && !process.env.CLAUDE_CODE_OAUTH_TOKEN
        ? ' On a headless machine: mint a token with `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN.'
        : '';
    throw new Error(`The run failed without completing: ${result.result}.${headless}`);
}

// The stream-error rescue, for catch blocks around `for await` over query():
// after an error result (e.g. max turns) the SDK errors the stream — but
// only after yielding the result message, which carries the abort reason and
// the run's stats. Keep it; rethrow only if we never saw one. An is_error
// 'success' result (unauthenticated) also errors the stream — prefer our
// translation of the result over the raw stream error.
export function rethrowUnlessResultExplains(result: SDKResultMessage | undefined, error: unknown): void
{
    if (result !== undefined)
    {
        throwIfErrorResult(result);
    }
    if (result === undefined || result.subtype === 'success')
    {
        throw error;
    }
}

// The post-stream gate: a stream may end without any result message at all
// (nothing to translate, nothing to salvage), and an error result that
// survived the rescue above still needs its is_error translation applied on
// the success path.
export function requireResult(result: SDKResultMessage | undefined): SDKResultMessage
{
    if (result === undefined)
    {
        throw new Error('The SDK stream ended without a result message.');
    }
    throwIfErrorResult(result);
    return result;
}

export function previewArgs(input: unknown): string
{
    const json = JSON.stringify(input) ?? '';
    return json.length <= 80 ? json : json.slice(0, 77) + '...';
}
