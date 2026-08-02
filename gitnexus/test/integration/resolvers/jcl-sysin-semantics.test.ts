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
      'DIRECT.jcl': [
        '//DIRECT   JOB (ACCT)',
        '//SORTSTEP EXEC PGM=SORT',
        '//SYSIN    DD *',
        '  SORT FIELDS=(1,10,CH,A)',
        "  INCLUDE COND=(11,1,CH,EQ,C'A')",
        '/*',
        '//AMSSTEP  EXEC PGM=IDCAMS',
        '//SYSIN    DD *',
        '  DELETE APP.OLD.DATA',
        '  DEFINE CLUSTER(NAME(APP.NEW.DATA))',
        '  REPRO INDATASET(APP.INPUT) OUTDATASET(APP.OUTPUT)',
        '/*',
        '//DB2STEP  EXEC PGM=IKJEFT1B',
        '//SYSTSIN  DD *',
        '  DSN SYSTEM(DB2P)',
        "  RUN PROGRAM(PAYPGM) PLAN(PAYPLAN) LIB('APP.LOADLIB')",
        '  END',
        '/*',
      ].join('\n'),
      'PAYPGM.cbl': `>>SOURCE FREE
IDENTIFICATION DIVISION.
PROGRAM-ID. PAYPGM.
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
    ).toEqual(['DIRECT → AMSSTEP', 'DIRECT → DB2STEP', 'DIRECT → SORTSTEP']);

    const sysinParents = getRelationships(result, 'CONTAINS').filter(
      (edge) => edge.rel.reason === 'jcl-sysin' || edge.rel.reason === 'jcl-control-input',
    );
    expect(edgeSet(sysinParents)).toEqual([
      'AMSSTEP → SYSIN',
      'DB2STEP → SYSTSIN',
      'SORTSTEP → SYSIN',
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
      'APP.OLD.DATA',
      'APP.NEW.DATA',
      'APP.INPUT',
      'APP.OUTPUT',
      'APP.LOADLIB',
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
    ).toEqual(['TSO-DB2 RUN → PAYPGM']);
    expect(
      edgeSet(
        getRelationships(result, 'ACCESSES').filter(
          (edge) => edge.rel.reason === 'jcl-sysin-db2-plan',
        ),
      ),
    ).toEqual(['TSO-DB2 RUN → PAYPLAN']);
  });
});
