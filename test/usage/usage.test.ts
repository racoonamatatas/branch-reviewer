import { describe, expect, it } from 'vitest';
import { UsageAccumulator, fromWireUsage } from '../../src/usage/usage.js';
import type { WireUsage } from '../../src/usage/usage.js';

function wire(input: number, output: number, cacheRead = 0, cacheCreation = 0): WireUsage
{
    return {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreation,
    };
}

describe('fromWireUsage', () =>
{
    it('should map snake_case fields', () =>
    {
        // Act
        const usage = fromWireUsage(wire(10, 20, 30, 40));

        // Assert
        expect(usage).toEqual({
            inputTokens: 10,
            outputTokens: 20,
            cacheReadInputTokens: 30,
            cacheCreationInputTokens: 40,
        });
    });

    it('should normalize null fields to zero', () =>
    {
        // Arrange
        const nullHeavy = {
            input_tokens: 5,
            output_tokens: null,
            cache_read_input_tokens: null,
            cache_creation_input_tokens: null,
        };

        // Act
        const usage = fromWireUsage(nullHeavy);

        // Assert
        expect(usage).toEqual({ inputTokens: 5, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
    });
});

describe('UsageAccumulator', () =>
{
    it('should keep one turn per message id, last value winning', () =>
    {
        // Arrange
        // Parallel tool calls arrive as multiple assistant messages sharing
        // one id; appending naively would double-count the turn — the one
        // subtlety this class exists to hold.
        const acc = new UsageAccumulator();
        acc.record('msg-1', wire(100, 10));
        acc.record('msg-1', wire(100, 25));

        // Act
        const turns = acc.turns();

        // Assert
        expect(turns).toHaveLength(1);
        expect(turns[0]!.usage.outputTokens).toBe(25);
    });

    it('should list turns in arrival order with a repeat keeping first position', () =>
    {
        // Arrange
        const acc = new UsageAccumulator();
        acc.record('msg-1', wire(1, 1));
        acc.record('msg-2', wire(2, 2));
        acc.record('msg-1', wire(1, 9));

        // Act
        const turns = acc.turns();

        // Assert
        expect(turns.map(t => t.messageId)).toEqual(['msg-1', 'msg-2']);
        expect(turns[0]!.usage.outputTokens).toBe(9);
    });
});
