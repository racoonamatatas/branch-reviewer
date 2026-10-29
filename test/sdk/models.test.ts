import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_MODEL, DEFAULT_REVIEW_MODELS, reviewModels } from '../../src/sdk/models.js';

// The roster functions read the shell env directly; isolate the suite from
// whatever the developer's shell happens to export.
const MODEL_VARS = ['REVIEW_MODEL', 'REVIEW_MODELS'] as const;

let saved: Record<string, string | undefined>;

beforeEach(() =>
{
    saved = {};
    for (const name of MODEL_VARS)
    {
        saved[name] = process.env[name];
        delete process.env[name];
    }
});

afterEach(() =>
{
    for (const name of MODEL_VARS)
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

describe('reviewModels', () =>
{
    it('should fall back to the default rotation roster when no knob is set', () =>
    {
        // Assert
        expect(reviewModels()).toEqual(DEFAULT_REVIEW_MODELS);
    });

    it('should lead the default roster with the default reviewer model', () =>
    {
        // Assert: verification falls back to DEFAULT_MODEL, so the roster
        // must include it for the verifier to be one of the reviewers.
        expect(DEFAULT_REVIEW_MODELS[0]).toBe(DEFAULT_MODEL);
        expect(DEFAULT_REVIEW_MODELS.length).toBeGreaterThan(1);
    });

    it('should follow REVIEW_MODEL when only the single knob is set', () =>
    {
        // Arrange
        process.env.REVIEW_MODEL = 'claude-sonnet-5';

        // Assert
        expect(reviewModels()).toEqual(['claude-sonnet-5']);
    });

    it('should parse REVIEW_MODELS as a comma list, surviving spaces and stray commas', () =>
    {
        // Arrange
        process.env.REVIEW_MODELS = ' claude-opus-5, claude-sonnet-5,,';

        // Assert
        expect(reviewModels()).toEqual(['claude-opus-5', 'claude-sonnet-5']);
    });

    it('should treat an empty REVIEW_MODELS as unset rather than an empty roster', () =>
    {
        // Arrange: an empty roster would make the campaign's cycle index
        // undefined — the fallback must catch this shape too.
        process.env.REVIEW_MODELS = ' , ';

        // Assert
        expect(reviewModels()).toEqual(DEFAULT_REVIEW_MODELS);
    });
});
