import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PipelineResult } from '../../../src/types/pipeline.js';
import {
  edgeSet,
  getNodesByLabelFull,
  getRelationships,
  runPipelineFromRepo,
  writeFixtureRepo,
} from './helpers.js';

describe('JCL JOB -> PROC -> SYSIN resolution', () => {
  let root: string;
  let result: PipelineResult;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-jcl-proc-sysin-'));
    writeFixtureRepo(root, {
      'jobs/PAYJOB.jcl': [
        '//PAYJOB   JOB (ACCT)',
        '//RUNPAY   EXEC PROC=PAYPROC',
        '//PSTEP.SYSIN DD *,DLM=@@',
        '  SORT FIELDS=COPY',
        '@@',
      ].join('\n'),
      'procs/PAYPROC.proc': [
        '//PAYPROC  PROC',
        '//PSTEP    EXEC PGM=PAYPGM',
        '//SYSIN    DD DSN=APP.DEFAULT.CARDS,DISP=SHR',
        '// PEND',
      ].join('\n'),
      'programs/PAYPGM.cbl': `>>SOURCE FREE
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

  it('links a job invocation to a catalogued PROC independent of file order', () => {
    expect(
      edgeSet(
        getRelationships(result, 'CALLS').filter((edge) => edge.rel.reason === 'jcl-exec-proc'),
      ),
    ).toEqual(['RUNPAY → PAYPROC']);
  });

  it('links the PROC to its internal step and program', () => {
    expect(
      edgeSet(
        getRelationships(result, 'CONTAINS').filter((edge) => edge.rel.reason === 'jcl-proc-step'),
      ),
    ).toEqual(['PAYPROC → PSTEP']);
    expect(
      edgeSet(
        getRelationships(result, 'CALLS').filter((edge) => edge.rel.reason === 'jcl-exec-pgm'),
      ),
    ).toEqual(['PSTEP → PAYPGM']);
  });

  it('attaches default and overridden SYSIN inputs to the PROC step', () => {
    expect(
      edgeSet(
        getRelationships(result, 'CONTAINS').filter((edge) => edge.rel.reason === 'jcl-sysin'),
      ),
    ).toEqual(['PSTEP → PSTEP.SYSIN', 'PSTEP → SYSIN']);

    const codeElements = getNodesByLabelFull(result, 'CodeElement');
    const override = codeElements.find((node) => node.name === 'PSTEP.SYSIN');
    expect(override?.properties.description).toContain('mode:inline');
    expect(override?.properties.description).toContain('override:true');
  });

  it('retains dataset-backed SYSIN as both a DD and control input dependency', () => {
    expect(
      edgeSet(
        getRelationships(result, 'CALLS').filter((edge) => edge.rel.reason === 'jcl-dd:SYSIN'),
      ),
    ).toEqual(['PSTEP → APP.DEFAULT.CARDS']);
    expect(
      edgeSet(
        getRelationships(result, 'ACCESSES').filter(
          (edge) => edge.rel.reason === 'jcl-sysin-dataset',
        ),
      ),
    ).toEqual(['SYSIN → APP.DEFAULT.CARDS']);
  });
});
