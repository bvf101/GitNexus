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
      'jobs/GNXJOB01.jcl': [
        '//GNXJOB01 JOB (GNXACCT)',
        '//GNXRUN01 EXEC PROC=GNXPRC01',
        '//GNXSTP01.SYSIN DD *,DLM=@@',
        '  SORT FIELDS=COPY',
        '@@',
      ].join('\n'),
      'procs/GNXPRC01.proc': [
        '//GNXPRC01 PROC',
        '//GNXSTP01 EXEC PGM=GNXPGM03',
        '//SYSIN    DD DSN=GNX.DEFAULT.CARDS,DISP=SHR',
        '// PEND',
      ].join('\n'),
      'programs/GNXPGM03.cbl': `>>SOURCE FREE
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

  it('links a job invocation to a catalogued PROC independent of file order', () => {
    expect(
      edgeSet(
        getRelationships(result, 'CALLS').filter((edge) => edge.rel.reason === 'jcl-exec-proc'),
      ),
    ).toEqual(['GNXRUN01 → GNXPRC01']);
  });

  it('links the PROC to its internal step and program', () => {
    expect(
      edgeSet(
        getRelationships(result, 'CONTAINS').filter((edge) => edge.rel.reason === 'jcl-proc-step'),
      ),
    ).toEqual(['GNXPRC01 → GNXSTP01']);
    expect(
      edgeSet(
        getRelationships(result, 'CALLS').filter((edge) => edge.rel.reason === 'jcl-exec-pgm'),
      ),
    ).toEqual(['GNXSTP01 → GNXPGM03']);
  });

  it('attaches default and overridden SYSIN inputs to the PROC step', () => {
    expect(
      edgeSet(
        getRelationships(result, 'CONTAINS').filter((edge) => edge.rel.reason === 'jcl-sysin'),
      ),
    ).toEqual(['GNXSTP01 → GNXSTP01.SYSIN', 'GNXSTP01 → SYSIN']);

    const codeElements = getNodesByLabelFull(result, 'CodeElement');
    const override = codeElements.find((node) => node.name === 'GNXSTP01.SYSIN');
    expect(override?.properties.description).toContain('mode:inline');
    expect(override?.properties.description).toContain('override:true');
  });

  it('retains dataset-backed SYSIN as both a DD and control input dependency', () => {
    expect(
      edgeSet(
        getRelationships(result, 'CALLS').filter((edge) => edge.rel.reason === 'jcl-dd:SYSIN'),
      ),
    ).toEqual(['GNXSTP01 → GNX.DEFAULT.CARDS']);
    expect(
      edgeSet(
        getRelationships(result, 'ACCESSES').filter(
          (edge) => edge.rel.reason === 'jcl-sysin-dataset',
        ),
      ),
    ).toEqual(['SYSIN → GNX.DEFAULT.CARDS']);
  });
});
