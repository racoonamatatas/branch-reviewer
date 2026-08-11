<script lang="ts">
// What the callout details: a consolidated cluster, or a bare finding from a
// run no consolidation has absorbed yet. A discriminated union rather than
// two optional props — a finding is not a degenerate cluster (it has no
// occurrence, no verdict, no members), and pretending otherwise would
// launder an unverified claim into the shapes the verified path renders.
import type { ClusterDetail } from '@server/server/server';
import type { Finding } from '@server/store/store';

export type CalloutSubject =
    | { kind: 'cluster'; cluster: ClusterDetail }
    | { kind: 'finding'; finding: Finding };
</script>

<script setup lang="ts">
// The detail callout under the sheet: one cluster's full content — finding
// prose, members, and the verification panel. Human stamps are live (the
// review store's first and only HTTP write); "verify now" stays drawn but
// disabled until a verify job kind exists.
import { computed, ref } from 'vue';
import type { RunId } from '@server/types/ids';
import { usd } from '../../format';

// revRunIds is the displayed rev's runs in round order — it turns raw run
// ids into R-numbers so the callout speaks the same language as the sheet.
const props = defineProps<{ subject: CalloutSubject; runCount: number; revRunIds?: RunId[] }>();

const emit = defineEmits<{ stamp: [verdict: 'confirmed' | 'refuted', rationale: string] }>();

// The rationale is required by the endpoint: verdicts inherit across
// consolidations by member set, so a bare stamp would propagate with no
// trace of why. The buttons stay dead until there is one.
const rationale = ref('');

function stamp(verdict: 'confirmed' | 'refuted'): void
{
    emit('stamp', verdict, rationale.value.trim());
    rationale.value = '';
}

const cluster = computed(() => props.subject.kind === 'cluster' ? props.subject.cluster : undefined);
const finding = computed(() => props.subject.kind === 'cluster' ? props.subject.cluster.representative : props.subject.finding);

// Append-only history: the last row is the verdict the cluster shows.
const latest = computed(() => cluster.value?.verifications[cluster.value.verifications.length - 1]);

const VERDICT_CLASS = { confirmed: 'ok', refuted: 'no', undetermined: 'und' } as const;

function location(file: string, line?: number): string
{
    return line === undefined ? file : `${file}:${line}`;
}

function runLabel(id: RunId): string
{
    const round = props.revRunIds?.indexOf(id) ?? -1;
    return round >= 0 ? `R${round + 1} · run ${id}` : `run ${id}`;
}
</script>

<template>
    <div class="callout">
        <!-- No cluster number in the header: cluster ids are one judge call's
             bookkeeping and change on every re-consolidation. The title IS the
             identity a human tracks; the db id survives in the tooltip. -->
        <div class="callout-head">
            <span class="k" :title="cluster ? `cluster id ${cluster.id}` : `finding id ${finding.id}`">DETAIL</span>
            <span class="t">{{ finding.title }}</span>
            <span class="meta caps">
                {{ finding.severity }} ·
                {{ cluster ? `seen in ${cluster.occurrence} of ${runCount} runs` : 'single run · unverified' }} ·
                {{ location(finding.file, finding.line) }}
            </span>
        </div>
        <div class="callout-body">
            <div class="left">
                <h3>Finding</h3>
                <div class="prose"><p>{{ finding.detail }}</p></div>
                <div v-if="finding.suggestion" class="sugg">
                    SUGGESTION — {{ finding.suggestion }}
                </div>
                <template v-if="cluster">
                    <h3 class="members-head">Members</h3>
                    <div v-for="member in cluster.members" :key="member.id" class="member">
                        <span class="rid">{{ runLabel(member.runId) }}</span>
                        <span class="mono">{{ location(member.file, member.line) }}</span>
                    </div>
                </template>
                <template v-else>
                    <h3 class="members-head">Provenance</h3>
                    <div class="member">
                        <span class="rid">{{ runLabel(finding.runId) }}</span>
                        <span class="mono">{{ location(finding.file, finding.line) }}</span>
                    </div>
                </template>
            </div>
            <div class="right">
                <template v-if="latest">
                    <h3>{{ latest.source === 'human' ? 'Human verdict' : `Adversarial verification · ${usd(latest.costUsd)}` }}</h3>
                    <span class="bigstamp" :class="VERDICT_CLASS[latest.verdict]">{{ latest.verdict.toUpperCase() }}{{ latest.source === 'human' ? ' · HUMAN' : '' }}</span>
                    <div class="rationale">{{ latest.rationale }}</div>
                    <div v-if="latest.source === 'agent'" class="confidence">{{ latest.confidence }}</div>
                    <div v-if="cluster && cluster.verifications.length > 1" class="confidence">
                        {{ cluster.verifications.length - 1 }} earlier verdict(s) in the append-only history.
                    </div>
                </template>
                <template v-else-if="cluster === undefined">
                    <h3>Verification</h3>
                    <span class="bigstamp und">UNVERIFIED</span>
                    <div class="rationale">
                        A claim, not a fact: this finding has never faced the adversarial pass, because
                        verification hangs off clusters and no consolidation includes this run yet.
                    </div>
                    <div class="confidence">Consolidate the run (or start a campaign) to make it verifiable.</div>
                </template>
                <template v-else-if="cluster.occurrence === 1">
                    <h3>Adversarial verification</h3>
                    <div class="rationale">Queued — seen by one run only, awaiting the adversarial pass. Running it bills subscription credit.</div>
                    <div class="vactions">
                        <button class="bp-btn chalk" disabled title="No verify endpoint yet — run npm run verify against this consolidation.">verify now</button>
                        <span class="note">no verify endpoint yet — use the CLI</span>
                    </div>
                </template>
                <template v-else>
                    <h3>Verification</h3>
                    <div class="rationale">
                        Reported independently by {{ cluster.occurrence }} of {{ runCount }} runs —
                        recurrence corroborates; not queued for adversarial verification.
                    </div>
                    <div class="confidence">Occurrence is confidence, never a filter.</div>
                </template>

                <!-- Every cluster is stampable, verified or not: recurrence only
                     certifies against independent error, and a correlated model
                     bias recurs in every run — human overrule is the sole
                     correction for that case, so it cannot be gated on a
                     verification history existing. -->
                <div v-if="cluster" class="vactions">
                    <input
                        v-model="rationale"
                        class="rationale-input mono"
                        placeholder="your rationale — required, it inherits with the verdict"
                    >
                    <button
                        class="bp-btn ok"
                        :disabled="rationale.trim() === ''"
                        :title="rationale.trim() === '' ? 'A verdict needs a rationale.' : 'Append a human CONFIRMED verdict.'"
                        @click="stamp('confirmed')"
                    >stamp: confirm</button>
                    <button
                        class="bp-btn no"
                        :disabled="rationale.trim() === ''"
                        :title="rationale.trim() === '' ? 'A verdict needs a rationale.' : 'Append a human REFUTED verdict.'"
                        @click="stamp('refuted')"
                    >stamp: refute</button>
                    <span class="note">human verdicts append — overrule, never overwrite</span>
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped>
.callout
{
    margin-top: 1.1rem;
    border: 1px solid var(--rule);
    background: rgba(14, 41, 73, 0.7);
}

.callout-head
{
    display: flex;
    align-items: baseline;
    gap: 0.8rem;
    flex-wrap: wrap;
    border-bottom: 1px solid var(--rule);
    padding: 0.5rem 0.9rem;
}

.callout-head .k
{
    font-family: ui-monospace, Menlo, Consolas, monospace;
    color: var(--chalk);
    font-size: 0.8rem;
    letter-spacing: 0.12em;
}

.callout-head .t
{
    color: var(--bright);
    font-weight: 600;
}

.callout-head .meta
{
    margin-left: auto;
    color: var(--faint);
    font-size: 0.75rem;
    letter-spacing: 0.08em;
}

.callout-body
{
    display: grid;
    grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
    gap: 0;
    min-height: 8rem;
}

@media (max-width: 900px)
{
    .callout-body
    {
        grid-template-columns: 1fr;
    }
}

.left
{
    padding: 0.8rem 0.9rem 1rem;
    border-right: 1px dashed var(--rule-soft);
}

.right
{
    padding: 0.8rem 0.9rem 1rem;
}

h3
{
    margin: 0 0 0.4rem;
    font-size: 0.68rem;
    color: var(--faint);
    text-transform: uppercase;
    letter-spacing: 0.18em;
    font-weight: 600;
}

.members-head
{
    margin-top: 0.9rem;
}

.prose
{
    font-size: 0.88rem;
    max-width: 70ch;
    color: var(--ink);
}

.prose p
{
    margin: 0 0 0.6em;
}

.sugg
{
    border-left: 2px solid var(--chalk);
    padding: 0.1rem 0 0.1rem 0.7rem;
    color: var(--chalk);
    font-size: 0.85rem;
    margin-top: 0.7rem;
    max-width: 70ch;
}

.member
{
    display: flex;
    gap: 0.7rem;
    font-size: 0.8rem;
    color: var(--muted);
    padding: 0.12rem 0;
}

.member .rid
{
    color: var(--bright);
    font-family: ui-monospace, Menlo, Consolas, monospace;
}

.rationale
{
    font-size: 0.85rem;
    color: var(--ink);
    max-width: 60ch;
}

.confidence
{
    font-size: 0.78rem;
    color: var(--muted);
    margin-top: 0.4rem;
    font-style: italic;
}

.vactions
{
    display: flex;
    gap: 0.5rem;
    margin-top: 0.8rem;
    align-items: center;
    flex-wrap: wrap;
}

.vactions .note
{
    color: var(--faint);
    font-size: 0.72rem;
}

.rationale-input
{
    flex: 1 1 100%;
    background: transparent;
    border: 1px solid var(--rule-soft);
    color: var(--ink);
    font-size: 0.78rem;
    padding: 0.3rem 0.5rem;
}

.rationale-input::placeholder { color: var(--faint); }

.bigstamp
{
    display: inline-block;
    font-family: ui-monospace, Menlo, Consolas, monospace;
    font-size: 0.8rem;
    letter-spacing: 0.16em;
    border: 2px solid currentColor;
    padding: 0.15rem 0.6rem;
    transform: rotate(-3deg);
    margin-bottom: 0.6rem;
}

.bigstamp.ok  { color: var(--stamp-ok); }
.bigstamp.no  { color: var(--stamp-no); }
.bigstamp.und { color: var(--stamp-und); border-style: dashed; }
</style>
