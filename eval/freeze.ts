// Freeze a stored consolidation as the judge's golden eval fixture: the findings
// that went in and the human-verified partition that came out. The fixture
// lives in eval/fixtures/ (gitignored — finding text contains repo
// internals; the DB it derives from is local-only for the same reason).

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_DB_PATH, ReviewStore } from '../src/store/store.js';
import { FIXTURE_PATH } from './fixture.js';

const USAGE = 'Usage: npm run eval:freeze -- <consolidation-id>';

function main(): number
{
    const id = Number(process.argv[2]);
    if (!Number.isInteger(id))
    {
        throw new Error(USAGE);
    }

    const store = new ReviewStore(DEFAULT_DB_PATH);
    try
    {
        const consolidation = store.getConsolidation(id);
        if (consolidation === undefined)
        {
            console.error(`No consolidation #${id}.`);
            return 1;
        }

        const fixture = {
            description: `Golden set frozen from consolidation #${consolidation.id} (${consolidation.createdAt}), `
                + `runs [${consolidation.runIds.join(', ')}] — human-verified partition, `
                + 'including the same-file anti-lumping trap.',
            findings: consolidation.clusters.flatMap(c => c.members),
            expectedClusters: consolidation.clusters.map(c => c.members.map(m => m.id).sort((a, b) => a - b)),
        };

        mkdirSync(dirname(FIXTURE_PATH), { recursive: true });
        writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 2) + '\n');
        console.log(`Froze consolidation #${id}: ${fixture.findings.length} findings, `
            + `${fixture.expectedClusters.length} expected clusters → ${FIXTURE_PATH}`);
        return 0;
    }
    finally
    {
        store.close();
    }
}

process.exitCode = main();
