// The entity id vocabulary, as one leaf module rather than beside each
// entity: the judge schema needs findingId as a value for its .transform,
// and importing the store into the inference layer for that would invert
// the dependency. Every layer (store, judge, CLI, eval) imports from here.

import { z } from 'zod';
import { idConstructor } from './common.js';
import type { Id } from './common.js';

// The wire-side Zod schema of an entity id: accepts a plain positive integer,
// outputs the branded id — numbers gain their type during parse. The only
// place the project says .transform; use sites say what, not how.
// .int().positive() stays despite the constructor's re-check: Zod reports a
// structured error with a field path, the constructor guards direct calls.
export function toTypedId<T extends string>(constructor: (n: number) => Id<T>)
{
    return z.number().int().positive().transform(constructor);
}

export type RunId = Id<'Run'>;
export const runId = idConstructor<'Run'>('RunId');

export type FindingId = Id<'Finding'>;
export const findingId = idConstructor<'Finding'>('FindingId');

export type ConsolidationId = Id<'Consolidation'>;
export const consolidationId = idConstructor<'Consolidation'>('ConsolidationId');

export type ClusterId = Id<'Cluster'>;
export const clusterId = idConstructor<'Cluster'>('ClusterId');

export type VerificationId = Id<'Verification'>;
export const verificationId = idConstructor<'Verification'>('VerificationId');

export type JobId = Id<'Job'>;
export const jobId = idConstructor<'Job'>('JobId');

export type WatchId = Id<'Watch'>;
export const watchId = idConstructor<'Watch'>('WatchId');
