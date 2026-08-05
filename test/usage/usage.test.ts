import { describe, expect, it } from 'vitest';
import { UsageAccumulator, ZERO_USAGE, diffUsage, fromWireUsage, isZeroUsage } from '../../src/usage/usage.js';
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
        expect(usage).toEqual({ ...ZERO_USAGE, inputTokens: 5 });
    });
});

describe('UsageAccumulator', () =>
{
    it('should sum usage across distinct message ids', () =>
    {
        // Arrange
        const acc = new UsageAccumulator();
        acc.record('msg-1', wire(100, 10, 1000, 0));
        acc.record('msg-2', wire(200, 20, 2000, 500));

        // Act
        const total = acc.total();

        // Assert
        expect(total).toEqual({
            inputTokens: 300,
            outputTokens: 30,
            cacheReadInputTokens: 3000,
            cacheCreationInputTokens: 500,
        });
    });

    it('should count a repeated message id once, keeping the last value', () =>
    {
        // Arrange
        // Parallel tool calls arrive as multiple assistant messages sharing
        // one id; naive summation would double-count the turn.
        const acc = new UsageAccumulator();
        acc.record('msg-1', wire(100, 10));
        acc.record('msg-1', wire(100, 25));

        // Act
        const total = acc.total();

        // Assert
        expect(total).toEqual({ ...ZERO_USAGE, inputTokens: 100, outputTokens: 25 });
    });

    it('should report zero totals before anything is recorded', () =>
    {
        // Arrange
        const acc = new UsageAccumulator();

        // Act
        const total = acc.total();

        // Assert
        expect(total).toEqual(ZERO_USAGE);
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

describe('diffUsage', () =>
{
    it('should be zero for identical usage', () =>
    {
        // Arrange
        const usage = fromWireUsage(wire(10, 20, 30, 40));

        // Act
        const delta = diffUsage(usage, usage);

        // Assert
        expect(isZeroUsage(delta)).toBe(true);
    });

    it('should expose signed per-field deltas', () =>
    {
        // Act
        const delta = diffUsage(fromWireUsage(wire(10, 20)), fromWireUsage(wire(4, 25)));

        // Assert
        expect(delta.inputTokens).toBe(6);
        expect(delta.outputTokens).toBe(-5);
        expect(isZeroUsage(delta)).toBe(false);
    });
});
