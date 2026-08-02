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

describe('COBOL dynamic CALL and CICS target resolution', () => {
  let root: string;
  let result: PipelineResult;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-cobol-dynamic-'));
    writeFixtureRepo(root, {
      'CALLER.cbl': `>>SOURCE FREE
IDENTIFICATION DIVISION.
PROGRAM-ID. CALLER.
DATA DIVISION.
WORKING-STORAGE SECTION.
01 WS-CALL PIC X(8) VALUE 'TARGETA'.
01 WS-LINK-SOURCE PIC X(8).
01 WS-LINK PIC X(8).
01 WS-TRANS PIC X(4).
01 WS-MAP PIC X(8) VALUE 'MAPA'.
01 WS-FILE PIC X(8).
01 WS-QUEUE-SOURCE PIC X(8) VALUE 'QUEUEA'.
01 WS-QUEUE PIC X(8).
PROCEDURE DIVISION.
MAIN.
MOVE 'TARGETB' TO WS-LINK-SOURCE.
MOVE WS-LINK-SOURCE TO WS-LINK.
MOVE 'TRN1' TO WS-TRANS.
MOVE 'FILEA' TO WS-FILE.
MOVE WS-QUEUE-SOURCE TO WS-QUEUE.
CALL WS-CALL.
EXEC CICS LINK PROGRAM(WS-LINK) END-EXEC.
EXEC CICS START TRANSID(WS-TRANS) END-EXEC.
EXEC CICS SEND MAP(WS-MAP) END-EXEC.
EXEC CICS READ FILE(WS-FILE) END-EXEC.
EXEC CICS WRITEQ TS QUEUE(WS-QUEUE) END-EXEC.
STOP RUN.`,
      'TARGETA.cbl': `>>SOURCE FREE
IDENTIFICATION DIVISION.
PROGRAM-ID. TARGETA.
PROCEDURE DIVISION.
MAIN.
GOBACK.`,
      'TARGETB.cbl': `>>SOURCE FREE
IDENTIFICATION DIVISION.
PROGRAM-ID. TARGETB.
PROCEDURE DIVISION.
MAIN.
GOBACK.`,
    });

    result = await runPipelineFromRepo(root, () => {}, { skipGraphPhases: true });
  }, 60000);

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('resolves a dynamic CALL from a VALUE clause', () => {
    const edges = getRelationships(result, 'CALLS').filter(
      (edge) => edge.rel.reason === 'cobol-call-dynamic',
    );
    expect(edgeSet(edges)).toEqual(['CALLER → TARGETA']);
    expect(edges[0]?.rel.confidence).toBe(0.8);
  });

  it('resolves CICS LINK through literal and identifier MOVE propagation', () => {
    const edges = getRelationships(result, 'CALLS').filter(
      (edge) => edge.rel.reason === 'cics-link-dynamic',
    );
    expect(edgeSet(edges)).toEqual(['CALLER → TARGETB']);
    expect(edges[0]?.rel.confidence).toBe(0.8);
  });

  it('identifies the transaction reached by dynamic START TRANSID', () => {
    const edges = getRelationships(result, 'CALLS').filter(
      (edge) => edge.rel.reason === 'cics-start-transid-dynamic',
    );
    expect(edgeSet(edges)).toEqual(['CALLER → TRN1']);
    expect(edges[0]?.targetLabel).toBe('CodeElement');
  });

  it('resolves dynamic MAP, FILE, and QUEUE resources', () => {
    const dynamicAccesses = getRelationships(result, 'ACCESSES').filter((edge) =>
      edge.rel.reason.endsWith('-dynamic'),
    );
    expect(edgeSet(dynamicAccesses)).toEqual([
      'EXEC CICS READ → FILEA',
      'EXEC CICS SEND MAP → MAPA',
      'EXEC CICS WRITEQ TS → QUEUEA',
    ]);
  });

  it('records resolved candidates on the indirect callsite descriptions', () => {
    const codeElements = getNodesByLabelFull(result, 'CodeElement');
    expect(
      codeElements.find((node) => node.name === 'CALL WS-CALL')?.properties.description,
    ).toContain('resolved-targets:[TARGETA]');
    expect(
      codeElements.find((node) => node.name === 'CICS LINK WS-LINK')?.properties.description,
    ).toContain('resolved-targets:[TARGETB]');
  });
});
