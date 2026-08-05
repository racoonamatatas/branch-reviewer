// Cache-aware token accounting. The predecessor summed two fields the loop
// already owned; here usage arrives on a stream the harness owns, in two
// shapes (nullable per-message BetaUsage, non-nullable result totals), and
// parallel tool calls share one message id — summing naively double-counts.
// The accumulator is observational only: it never gates a review.

// Structural subset satisfied by both BetaUsage (number | null) and the
// result message's NonNullableUsage.
export interface WireUsage
{
    input_tokens: number | null;
    output_tokens: number | null;
    cache_read_input_tokens: number | null;
    cache_creation_input_tokens: number | null;
}

export interface TokenUsage
{
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
}

export interface TurnUsage
{
    messageId: string;
    usage: TokenUsage;
}

export const ZERO_USAGE: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
};

export function fromWireUsage(usage: WireUsage): TokenUsage
{
    return {
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
        cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
    };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage
{
    return {
        inputTokens: a.inputTokens + b.inputTokens,
        outputTokens: a.outputTokens + b.outputTokens,
        cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
        cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    };
}

export function diffUsage(a: TokenUsage, b: TokenUsage): TokenUsage
{
    return {
        inputTokens: a.inputTokens - b.inputTokens,
        outputTokens: a.outputTokens - b.outputTokens,
        cacheReadInputTokens: a.cacheReadInputTokens - b.cacheReadInputTokens,
        cacheCreationInputTokens: a.cacheCreationInputTokens - b.cacheCreationInputTokens,
    };
}

export function isZeroUsage(usage: TokenUsage): boolean
{
    return usage.inputTokens === 0
        && usage.outputTokens === 0
        && usage.cacheReadInputTokens === 0
        && usage.cacheCreationInputTokens === 0;
}

export class UsageAccumulator
{
    // Insertion-ordered by first sight of each id; a repeat id (parallel tool
    // calls in one assistant message) overwrites instead of appending.
    private readonly byMessageId = new Map<string, TokenUsage>();

    record(messageId: string, usage: WireUsage): void
    {
        this.byMessageId.set(messageId, fromWireUsage(usage));
    }

    total(): TokenUsage
    {
        let sum = ZERO_USAGE;
        for (const usage of this.byMessageId.values())
        {
            sum = addUsage(sum, usage);
        }
        return sum;
    }

    turns(): TurnUsage[]
    {
        return [...this.byMessageId].map(([messageId, usage]) => ({ messageId, usage }));
    }
}
