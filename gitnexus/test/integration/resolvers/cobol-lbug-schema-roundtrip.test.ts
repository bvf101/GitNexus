/**
 * Regression test for the COBOL regex processor's relationship-label contract.
 *
 * The ordinary COBOL integration suite stops at the in-memory graph. This test
 * continues through CSV pair routing and a real LadybugDB COPY so an emitted
 * endpoint pair missing from RELATION_SCHEMA fails before release.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { NODE_TABLES, RELATION_SCHEMA } from '../../../src/core/lbug/schema.js';
import { getNodeLabel, parseRelationSchemaPairs } from '../../../src/core/lbug/rel-pair-routing.js';
import { createTempDir, type TestDBHandle } from '../../helpers/test-db.js';
import { FIXTURES, runPipelineFromRepo, type PipelineResult } from './helpers.js';

const COBOL_RELATION_PAIRS = [
  'Module|Property',
  'Module|Constructor',
  'Module|Namespace',
  'Module|Record',
  'Namespace|Function',
  'CodeElement|Record',
  'CodeElement|Property',
  'Record|Record',
] as const;

const COBOL_FIXTURE_ROOT = path.join(FIXTURES, 'cobol-app');
const VALID_NODE_LABELS = new Set<string>(NODE_TABLES);

let result: PipelineResult;
let tempDb: TestDBHandle | undefined;

beforeAll(async () => {
  result = await runPipelineFromRepo(COBOL_FIXTURE_ROOT, () => {}, {
    skipGraphPhases: true,
  });

  // Literal SQL/CICS resources are deliberately represented as external ids:
  // the processor emits an ACCESSES edge without inventing a source-file node.
  // SORT USING/GIVING does the same for both Record endpoints. Materialize
  // those identity-only Records in this persistence test so the affected pairs
  // reach COPY. The production router still has to accept the original edges.
  for (const relationship of [...result.graph.iterRelationships()]) {
    for (const nodeId of [relationship.sourceId, relationship.targetId]) {
      if (getNodeLabel(nodeId) !== 'Record' || result.graph.getNode(nodeId)) continue;

      result.graph.addNode({
        id: nodeId,
        label: 'Record',
        properties: {
          name: nodeId.split(':').at(-1) ?? nodeId,
          filePath: '',
        },
      });
    }
  }

  tempDb = await createTempDir();
  const storagePath = path.join(tempDb.dbPath, '.gitnexus');
  const lbugPath = path.join(storagePath, 'lbug');
  await fs.mkdir(lbugPath, { recursive: true });

  const adapter = await import('../../../src/core/lbug/lbug-adapter.js');
  await adapter.initLbug(lbugPath);
  await adapter.loadGraphToLbug(result.graph, COBOL_FIXTURE_ROOT, storagePath);
}, 60_000);

afterAll(async () => {
  try {
    const adapter = await import('../../../src/core/lbug/lbug-adapter.js');
    await adapter.closeLbug();
  } finally {
    await tempDb?.cleanup();
  }
});

describe('COBOL relationship schema round-trip', () => {
  it('the fixture exercises every COBOL-specific label pair', () => {
    const emittedPairs = new Set<string>();
    for (const relationship of result.graph.iterRelationships()) {
      const sourceLabel = getNodeLabel(relationship.sourceId);
      const targetLabel = getNodeLabel(relationship.targetId);
      if (VALID_NODE_LABELS.has(sourceLabel) && VALID_NODE_LABELS.has(targetLabel)) {
        emittedPairs.add(`${sourceLabel}|${targetLabel}`);
      }
    }

    for (const pair of COBOL_RELATION_PAIRS) {
      expect(emittedPairs.has(pair), `${pair} must remain covered by the fixture`).toBe(true);
    }
  });

  it('every valid endpoint pair emitted by the fixture is declared in the DDL', () => {
    const declaredPairs = parseRelationSchemaPairs(RELATION_SCHEMA);
    const missingPairs = new Set<string>();

    for (const relationship of result.graph.iterRelationships()) {
      const sourceLabel = getNodeLabel(relationship.sourceId);
      const targetLabel = getNodeLabel(relationship.targetId);
      if (!VALID_NODE_LABELS.has(sourceLabel) || !VALID_NODE_LABELS.has(targetLabel)) continue;

      const pair = `${sourceLabel}|${targetLabel}`;
      if (!declaredPairs.has(pair)) missingPairs.add(pair);
    }

    expect([...missingPairs].sort()).toEqual([]);
  });

  it('round-trips every COBOL-specific label pair through LadybugDB COPY', async () => {
    const adapter = await import('../../../src/core/lbug/lbug-adapter.js');

    for (const pair of COBOL_RELATION_PAIRS) {
      const [sourceLabel, targetLabel] = pair.split('|');
      const rows = await adapter.executeQuery(
        `MATCH (source:\`${sourceLabel}\`)-[relationship:CodeRelation]->(target:\`${targetLabel}\`) RETURN count(relationship) AS count`,
      );
      expect(Number(rows[0]?.count), `${pair} relationship should persist`).toBeGreaterThan(0);
    }
  });
});
