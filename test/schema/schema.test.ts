import { describe, expect, it } from 'vitest';
import { reviewJsonSchema, reviewSchema } from '../../src/schema/schema.js';

const validReview = {
    summary: 'Small focused change, one concern.',
    findings: [
        {
            file: 'src/app.ts',
            line: 12,
            severity: 'warning',
            title: 'Unbounded query',
            detail: 'The query has no limit clause.',
            suggestion: 'Add pagination.',
        },
    ],
};

describe('reviewSchema', () =>
{
    it('should accept a valid review', () =>
    {
        expect(reviewSchema.parse(validReview)).toEqual(validReview);
    });

    it('should accept findings without optional line and suggestion', () =>
    {
        const review = {
            summary: 'Clean.',
            findings: [{ file: 'a.ts', severity: 'nit', title: 't', detail: 'd' }],
        };
        expect(reviewSchema.parse(review)).toEqual(review);
    });

    it('should reject an unknown severity', () =>
    {
        const review = structuredClone(validReview);
        review.findings[0]!.severity = 'blocker';
        expect(() => reviewSchema.parse(review)).toThrow();
    });

    it('should reject a review without a summary', () =>
    {
        expect(() => reviewSchema.parse({ findings: [] })).toThrow();
    });
});

describe('reviewJsonSchema', () =>
{
    it('should target JSON Schema draft-7 for the SDK outputFormat', () =>
    {
        expect(reviewJsonSchema.$schema).toBe('http://json-schema.org/draft-07/schema#');
    });

    it('should mark only line and suggestion as optional on findings', () =>
    {
        const findings = (reviewJsonSchema as unknown as { properties: { findings: { items: { required: string[] } } } })
            .properties.findings.items;
        expect(findings.required.sort()).toEqual(['detail', 'file', 'severity', 'title']);
    });
});
