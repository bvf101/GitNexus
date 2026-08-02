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
      'GNXCALLR.cbl': `>>SOURCE FREE
IDENTIFICATION DIVISION.
PROGRAM-ID. GNXCALLR.
DATA DIVISION.
WORKING-STORAGE SECTION.
01 WS-CALL PIC X(8) VALUE 'GNXTGTA1'.
01 WS-LINK-SOURCE PIC X(8).
01 WS-LINK PIC X(8).
01 WS-LINK-VALUE PIC X(8) VALUE
  'GNXTGTC1'.
01 WS-EXTERNAL PIC X(8) VALUE
  'GNXEXT01'.
01 WS-TRANS PIC X(4).
01 WS-MAP PIC X(8) VALUE 'GNXMAP01'.
01 WS-FILE PIC X(8).
01 WS-QUEUE-SOURCE PIC X(8) VALUE 'GNXQUE01'.
01 WS-QUEUE PIC X(8).
PROCEDURE DIVISION.
MAIN.
MOVE 'GNXTGTB1' TO WS-LINK-SOURCE.
MOVE WS-LINK-SOURCE TO WS-LINK.
MOVE 'GNX1' TO WS-TRANS.
MOVE 'GNXFIL01' TO WS-FILE.
MOVE WS-QUEUE-SOURCE TO WS-QUEUE.
CALL WS-CALL.
EXEC CICS LINK PROGRAM(WS-LINK) END-EXEC.
EXEC CICS LINK PROGRAM(WS-LINK-VALUE) END-EXEC.
EXEC CICS LINK PROGRAM(WS-EXTERNAL) END-EXEC.
EXEC CICS START TRANSID(WS-TRANS) END-EXEC.
EXEC CICS SEND MAP(WS-MAP) END-EXEC.
EXEC CICS READ FILE(WS-FILE) END-EXEC.
EXEC CICS WRITEQ TS QUEUE(WS-QUEUE) END-EXEC.
STOP RUN.`,
      'GNXTGTA1.cbl': `>>SOURCE FREE
IDENTIFICATION DIVISION.
PROGRAM-ID. GNXTGTA1.
PROCEDURE DIVISION.
MAIN.
GOBACK.`,
      'GNXTGTB1.cbl': `>>SOURCE FREE
IDENTIFICATION DIVISION.
PROGRAM-ID. GNXTGTB1.
PROCEDURE DIVISION.
MAIN.
GOBACK.`,
      'GNXTGTC1.cbl': `>>SOURCE FREE
IDENTIFICATION DIVISION.
PROGRAM-ID. GNXTGTC1.
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
    expect(edgeSet(edges)).toEqual(['GNXCALLR → GNXTGTA1']);
    expect(edges[0]?.rel.confidence).toBe(0.8);
  });

  it('resolves CICS LINK through multiline VALUE and identifier MOVE propagation', () => {
    const edges = getRelationships(result, 'CALLS').filter(
      (edge) => edge.rel.reason === 'cics-link-dynamic',
    );
    expect(edgeSet(edges)).toEqual(['GNXCALLR → GNXTGTB1', 'GNXCALLR → GNXTGTC1']);
    expect(edges.every((edge) => edge.rel.confidence === 0.8)).toBe(true);
  });

  it('materializes external dynamic targets so their CALLS edges can persist', () => {
    const edges = getRelationships(result, 'CALLS').filter(
      (edge) => edge.rel.reason === 'cics-link-dynamic-external',
    );
    expect(edgeSet(edges)).toEqual(['GNXCALLR → GNXEXT01']);
    expect(edges[0]?.rel.targetId).toBe('Module:<external>:GNXEXT01');
    expect(edges[0]?.targetLabel).toBe('Module');
    expect(edges[0]?.targetFilePath).toBe('<external>');
    expect(edges[0]?.rel.confidence).toBe(0.8);
  });

  it('identifies the transaction reached by dynamic START TRANSID', () => {
    const edges = getRelationships(result, 'CALLS').filter(
      (edge) => edge.rel.reason === 'cics-start-transid-dynamic',
    );
    expect(edgeSet(edges)).toEqual(['GNXCALLR → GNX1']);
    expect(edges[0]?.targetLabel).toBe('CodeElement');
  });

  it('resolves dynamic MAP, FILE, and QUEUE resources', () => {
    const dynamicAccesses = getRelationships(result, 'ACCESSES').filter((edge) =>
      edge.rel.reason.endsWith('-dynamic'),
    );
    expect(edgeSet(dynamicAccesses)).toEqual([
      'EXEC CICS READ → GNXFIL01',
      'EXEC CICS SEND MAP → GNXMAP01',
      'EXEC CICS WRITEQ TS → GNXQUE01',
    ]);
  });

  it('records resolved candidates on the indirect callsite descriptions', () => {
    const codeElements = getNodesByLabelFull(result, 'CodeElement');
    expect(
      codeElements.find((node) => node.name === 'CALL WS-CALL')?.properties.description,
    ).toContain('resolved-targets:[GNXTGTA1]');
    expect(
      codeElements.find((node) => node.name === 'CICS LINK WS-LINK')?.properties.description,
    ).toContain('resolved-targets:[GNXTGTB1]');
    expect(
      codeElements.find((node) => node.name === 'CICS LINK WS-LINK-VALUE')?.properties.description,
    ).toContain('resolved-targets:[GNXTGTC1]');
    expect(
      codeElements.find((node) => node.name === 'CICS LINK WS-EXTERNAL')?.properties.description,
    ).toContain('resolved-targets:[GNXEXT01]');
  });
});
