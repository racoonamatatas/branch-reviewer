// Cache-aware token accounting. Usage arrives on a stream the harness owns,
// in two shapes (nullable per-message BetaUsage, non-nullable result totals),
// and parallel tool calls share one message id — summing naively
// double-counts, which is the one subtlety this module exists to hold. The
// SDK result's totals are authoritative; the accumulator's per-turn view is
// observational (the --verbose per-turn table) and never gates a review. An
// earlier revision also reconciled the two sums and warned on a delta — a
// warning its own comment said never to act on, so it went.

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

export function fromWireUsage(usage: WireUsage): TokenUsage
{
    return {
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
        cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
    };
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

    turns(): TurnUsage[]
    {
        return [...this.byMessageId].map(([messageId, usage]) => ({ messageId, usage }));
    }
}
