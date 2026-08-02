import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PipelineResult } from '../../../src/types/pipeline.js';
import {
  edgeSet,
  getNodesByLabel,
  getNodesByLabelFull,
  getRelationships,
  runPipelineFromRepo,
  writeFixtureRepo,
} from './helpers.js';

describe('direct JCL SYSIN semantics without PROC', () => {
  let root: string;
  let result: PipelineResult;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-jcl-direct-sysin-'));
    writeFixtureRepo(root, {
      'GNXJOB02.jcl': [
        '//GNXJOB02 JOB (GNXACCT)',
        '//GNXSTP02 EXEC PGM=SORT',
        '//SYSIN    DD *',
        '  SORT FIELDS=(1,10,CH,A)',
        "  INCLUDE COND=(11,1,CH,EQ,C'A')",
        '/*',
        '//GNXSTP03 EXEC PGM=IDCAMS',
        '//SYSIN    DD *',
        '  DELETE GNX.OLD.DATA',
        '  DEFINE CLUSTER(NAME(GNX.NEW.DATA))',
        '  REPRO INDATASET(GNX.INPUT) OUTDATASET(GNX.OUTPUT)',
        '/*',
        '//GNXSTP04 EXEC PGM=IKJEFT1B',
        '//SYSTSIN  DD *',
        '  DSN SYSTEM(GXDB)',
        "  RUN PROGRAM(GNXPGM03) PLAN(GNXPLN01) LIB('GNX.LOADLIB')",
        '  END',
        '/*',
      ].join('\n'),
      'GNXPGM03.cbl': `>>SOURCE FREE
IDENTIFICATION DIVISION.
PROGRAM-ID. GNXPGM03.
PROCEDURE DIVISION.
MAIN.
GOBACK.`,
    });

    result = await runPipelineFromRepo(root, () => {}, { skipGraphPhases: true });
  }, 60000);

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('keeps the direct JOB -> EXEC PGM -> SYSIN hierarchy', () => {
    expect(
      edgeSet(
        getRelationships(result, 'CONTAINS').filter((edge) => edge.rel.reason === 'jcl-step'),
      ),
    ).toEqual(['GNXJOB02 → GNXSTP02', 'GNXJOB02 → GNXSTP03', 'GNXJOB02 → GNXSTP04']);

    const sysinParents = getRelationships(result, 'CONTAINS').filter(
      (edge) => edge.rel.reason === 'jcl-sysin' || edge.rel.reason === 'jcl-control-input',
    );
    expect(edgeSet(sysinParents)).toEqual([
      'GNXSTP02 → SYSIN',
      'GNXSTP03 → SYSIN',
      'GNXSTP04 → SYSTSIN',
    ]);
  });

  it('creates DFSORT and IDCAMS command nodes', () => {
    const commands = getNodesByLabelFull(result, 'CodeElement').filter((node) =>
      node.properties.description?.startsWith('jcl-sysin-command'),
    );
    expect(commands.map((node) => node.name).sort()).toEqual([
      'DFSORT INCLUDE',
      'DFSORT SORT',
      'IDCAMS DEFINE',
      'IDCAMS DELETE',
      'IDCAMS REPRO',
      'TSO-DB2 DSN',
      'TSO-DB2 END',
      'TSO-DB2 RUN',
    ]);
  });

  it('extracts datasets referenced by IDCAMS and DB2 control cards', () => {
    const codeElements = getNodesByLabel(result, 'CodeElement');
    for (const dataset of [
      'GNX.OLD.DATA',
      'GNX.NEW.DATA',
      'GNX.INPUT',
      'GNX.OUTPUT',
      'GNX.LOADLIB',
    ]) {
      expect(codeElements).toContain(dataset);
    }
  });

  it('links DB2 RUN to its program and plan', () => {
    expect(
      edgeSet(
        getRelationships(result, 'CALLS').filter(
          (edge) => edge.rel.reason === 'jcl-sysin-run-program',
        ),
      ),
    ).toEqual(['TSO-DB2 RUN → GNXPGM03']);
    expect(
      edgeSet(
        getRelationships(result, 'ACCESSES').filter(
          (edge) => edge.rel.reason === 'jcl-sysin-db2-plan',
        ),
      ),
    ).toEqual(['TSO-DB2 RUN → GNXPLN01']);
  });
});
