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
        // Act
        const parsed = reviewSchema.parse(validReview);

        // Assert
        expect(parsed).toEqual(validReview);
    });

    it('should accept findings without optional line and suggestion', () =>
    {
        // Arrange
        const review = {
            summary: 'Clean.',
            findings: [{ file: 'a.ts', severity: 'nit', title: 't', detail: 'd' }],
        };

        // Act
        const parsed = reviewSchema.parse(review);

        // Assert
        expect(parsed).toEqual(review);
    });

    it('should reject an unknown severity', () =>
    {
        // Arrange
        const review = structuredClone(validReview);
        review.findings[0]!.severity = 'blocker';

        // Act
        const parse = () => reviewSchema.parse(review);

        // Assert
        expect(parse).toThrow();
    });

    it('should reject a review without a summary', () =>
    {
        // Act
        const parse = () => reviewSchema.parse({ findings: [] });

        // Assert
        expect(parse).toThrow();
    });
});

describe('reviewJsonSchema', () =>
{
    it('should target JSON Schema draft-7 for the SDK outputFormat', () =>
    {
        // Act
        const schemaId = reviewJsonSchema.$schema;

        // Assert
        expect(schemaId).toBe('http://json-schema.org/draft-07/schema#');
    });

    it('should mark only line and suggestion as optional on findings', () =>
    {
        // Act
        const findings = (reviewJsonSchema as unknown as { properties: { findings: { items: { required: string[] } } } })
            .properties.findings.items;

        // Assert
        expect(findings.required.sort()).toEqual(['detail', 'file', 'severity', 'title']);
    });
});
