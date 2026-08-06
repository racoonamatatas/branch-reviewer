// The review output contract. Same shape as branch-reviewer-api's Finding/Review
// (types.ts there), but defined once in Zod: the TS types are inferred and the
// JSON Schema for the SDK's outputFormat is generated, instead of hand-duplicated.

import { z } from 'zod';

export const severitySchema = z.enum(['critical', 'warning', 'nit']);

export const findingSchema = z.object({
    file: z.string().describe('Path of the file the finding is in, as it appears in the diff'),
    line: z.number().int().positive().optional()
        .describe('Line number at branch head, if the finding anchors to one'),
    severity: severitySchema,
    title: z.string().describe('One-line statement of the problem'),
    detail: z.string().describe('Explanation: what is wrong and why it matters'),
    suggestion: z.string().optional().describe('Concrete fix, if one is clear'),
});

export const reviewSchema = z.object({
    summary: z.string().describe('Overall assessment of the branch in a few sentences'),
    findings: z.array(findingSchema),
});

export type Severity = z.infer<typeof severitySchema>;

// The wire finding: what the reviewer emits and what saveRun is handed — the
// Finding entity minus everything assigned at save (id, runId). Zod is its
// runtime source of truth; the store's type test proves it stays exactly
// that subtraction.
export type NewFinding = z.infer<typeof findingSchema>;

export type Review = z.infer<typeof reviewSchema>;

export const reviewJsonSchema = z.toJSONSchema(reviewSchema, { target: 'draft-7' });
