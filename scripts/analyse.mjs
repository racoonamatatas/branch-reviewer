// Read-only analysis of a review database: verdict vs reviewer confidence and
// severity, and what each lens/model contributes. Plain SQL, no model calls.
//
//   node scripts/analyse.mjs data/reviews.db

import console from 'node:console';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(process.argv[2], { readOnly: true });
const q = (title, sql) =>
{
    console.log(`\n## ${title}`);
    console.table(db.prepare(sql).all());
};

// ---- Analysis 1: confidence vs verdict ----
// One row per actual verification event (inherited statuses would double-count).
q('1a. Verdict by representative finding confidence (verification events)', `
    select coalesce(f.confidence, '(none)') confidence,
           sum(v.verdict = 'confirmed') confirmed,
           sum(v.verdict = 'refuted') refuted,
           sum(v.verdict = 'undetermined') undetermined,
           count(*) n,
           round(100.0 * sum(v.verdict = 'refuted') / count(*), 1) refuted_pct
    from verifications v
    join clusters c on c.id = v.cluster_id
    join findings f on f.id = c.representative_finding_id
    group by 1 order by 1`);

q('1b. Verdict by highest member confidence (cluster-level)', `
    with mc as (
        select cm.cluster_id,
               max(case f.confidence when 'high' then 3 when 'medium' then 2 when 'low' then 1 end) lvl
        from cluster_members cm join findings f on f.id = cm.finding_id
        group by 1)
    select case mc.lvl when 3 then 'high' when 2 then 'medium' when 1 then 'low' else '(none)' end max_conf,
           sum(v.verdict = 'confirmed') confirmed,
           sum(v.verdict = 'refuted') refuted,
           sum(v.verdict = 'undetermined') undetermined,
           count(*) n,
           round(100.0 * sum(v.verdict = 'refuted') / count(*), 1) refuted_pct
    from verifications v join mc on mc.cluster_id = v.cluster_id
    group by 1 order by 1`);

q('1c. Verdict by severity (verification events)', `
    select c.severity,
           sum(v.verdict = 'confirmed') confirmed,
           sum(v.verdict = 'refuted') refuted,
           sum(v.verdict = 'undetermined') undetermined,
           count(*) n,
           round(100.0 * sum(v.verdict = 'refuted') / count(*), 1) refuted_pct
    from verifications v join clusters c on c.id = v.cluster_id
    group by 1 order by n desc`);

q('1d. Verification cost by confidence', `
    select coalesce(f.confidence, '(none)') confidence,
           round(sum(v.cost_usd), 2) cost_usd,
           round(avg(v.cost_usd), 2) avg_cost,
           round(sum(v.cost_usd) / nullif(sum(v.verdict = 'refuted'), 0), 2) usd_per_refutation
    from verifications v
    join clusters c on c.id = v.cluster_id
    join findings f on f.id = c.representative_finding_id
    group by 1 order by 1`);

// ---- Analysis 2: what each lens / model contributes ----
// Latest consolidation per target is the union; verdict statuses there are inherited, which is
// what we want at cluster level (one row per distinct issue).
const latest = `
    latest as (
        select max(id) id from consolidations group by owner, repo, head, base),
    lc as (
        select c.* from clusters c join latest l on l.id = c.consolidation_id),
    mem as (
        select lc.id cluster_id, lc.verification_status st, lc.severity,
               coalesce(r.lens, '(none)') lens, r.model
        from lc
        join cluster_members cm on cm.cluster_id = lc.id
        join findings f on f.id = cm.finding_id
        join runs r on r.id = f.run_id)`;

q('2a. Per-run yield and cost by model', `
    select model, count(*) runs,
           sum(status = 'aborted') aborted,
           round(avg(turns), 1) avg_turns,
           round(avg(cost_usd), 2) avg_cost,
           round(1.0 * (select count(*) from findings f join runs r2 on r2.id = f.run_id where r2.model = runs.model) / count(*), 1) findings_per_run
    from runs where status in ('submitted', 'aborted')
    group by 1 order by runs desc`);

for (const dim of ['lens', 'model'])
{
    q(`2b. Distinct clusters per ${dim} (latest consolidation per target)`, `
        with ${latest},
        per as (
            select cluster_id, st, ${dim} d,
                   (select count(distinct m2.${dim}) from mem m2 where m2.cluster_id = mem.cluster_id) ndims
            from mem group by cluster_id, ${dim})
        select d ${dim},
               (select count(*) from runs where ${dim === 'lens' ? "coalesce(lens, '(none)')" : 'model'} = d and status = 'submitted') runs,
               count(*) clusters,
               sum(st = 'confirmed') confirmed,
               sum(st = 'refuted') refuted,
               sum(ndims = 1) exclusive,
               sum(ndims = 1 and st = 'confirmed') exclusive_confirmed,
               sum(ndims = 1 and st = 'refuted') exclusive_refuted
        from per group by d order by clusters desc`);
}

q('2c. Lens x model confound: submitted runs', `
    select coalesce(lens, '(none)') lens,
           sum(model = 'claude-opus-5') opus5,
           sum(model = 'claude-opus-5-5') opus55,
           sum(model = 'claude-sonnet-5') sonnet5,
           sum(model = 'claude-sonnet-5-5') sonnet55
    from runs where status = 'submitted' group by 1`);

q('2d. Round-level novelty by lens (campaign rounds)', `
    select coalesce(lens, '(none)') lens, count(*) rounds,
           round(avg(novel_clusters), 2) avg_novel,
           round(avg(cost_usd), 2) avg_cost,
           round(sum(cost_usd) / nullif(sum(novel_clusters), 0), 2) usd_per_novel
    from campaign_rounds where run_id is not null and round > 0
    group by 1 order by avg_novel desc`);

q('Targets', `
    select repo, head, count(*) runs from runs group by owner, repo, head, base order by runs desc`);
