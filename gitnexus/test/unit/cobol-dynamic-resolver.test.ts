import { describe, expect, it } from 'vitest';
import {
  extractCobolSymbolsWithRegex,
  preprocessCobolSource,
} from '../../src/core/ingestion/cobol/cobol-preprocessor.js';
import { createCobolDynamicValueResolver } from '../../src/core/ingestion/cobol/cobol-dynamic-resolver.js';

function extract(source: string) {
  return extractCobolSymbolsWithRegex(preprocessCobolSource(source), 'dynamic.cbl');
}

describe('COBOL dynamic target value resolution', () => {
  it('propagates VALUE, literal MOVE, and identifier MOVE before the use line', () => {
    const source = `>>SOURCE FREE
IDENTIFICATION DIVISION.
PROGRAM-ID. DYNAMIC.
DATA DIVISION.
WORKING-STORAGE SECTION.
01 WS-CALL PIC X(8) VALUE 'PGMONE'.
01 WS-SOURCE PIC X(8).
01 WS-TARGET PIC X(8).
PROCEDURE DIVISION.
MAIN.
MOVE 'PGMTWO' TO WS-SOURCE.
MOVE WS-SOURCE TO WS-TARGET.
CALL WS-TARGET.
MOVE 'TOO-LATE' TO WS-TARGET.
STOP RUN.`;

    const extracted = extract(source);
    const resolve = createCobolDynamicValueResolver(extracted);
    const callLine = extracted.calls[0]?.line ?? -1;

    expect(callLine).toBeGreaterThan(0);
    expect(resolve('WS-CALL', callLine)).toEqual(['PGMONE']);
    expect(resolve('WS-TARGET', callLine)).toEqual(['PGMTWO']);
    expect(resolve('WS-TARGET', source.split('\n').length + 1)).toEqual(['PGMTWO', 'TOO-LATE']);
    expect(extracted.literalMoves).toEqual([
      expect.objectContaining({ value: 'PGMTWO', targets: ['WS-SOURCE'] }),
      expect.objectContaining({ value: 'TOO-LATE', targets: ['WS-TARGET'] }),
    ]);
  });

  it('retains all path-insensitive candidates and ignores figurative constants', () => {
    const source = `>>SOURCE FREE
IDENTIFICATION DIVISION.
PROGRAM-ID. DYNAMIC.
DATA DIVISION.
WORKING-STORAGE SECTION.
01 WS-TARGET PIC X(8) VALUE SPACES.
PROCEDURE DIVISION.
MAIN.
IF WS-FLAG = 'A'
  MOVE 'PGMONE' TO WS-TARGET
ELSE
  MOVE 'PGMTWO' TO WS-TARGET
END-IF
CALL WS-TARGET.`;

    const extracted = extract(source);
    const resolve = createCobolDynamicValueResolver(extracted);
    const callLine = extracted.calls[0]?.line ?? -1;

    expect(callLine).toBeGreaterThan(0);
    expect(resolve('WS-TARGET', callLine)).toEqual(['PGMONE', 'PGMTWO']);
  });

  it('marks CICS PROGRAM, TRANSID, MAP, FILE, and QUEUE operands as literal or dynamic', () => {
    const source = `>>SOURCE FREE
IDENTIFICATION DIVISION.
PROGRAM-ID. DYNAMIC.
PROCEDURE DIVISION.
MAIN.
EXEC CICS LINK PROGRAM(WS-PROGRAM) END-EXEC.
EXEC CICS START TRANSID(WS-TRANS) END-EXEC.
EXEC CICS SEND MAP('MAPA') END-EXEC.
EXEC CICS READ FILE(WS-FILE) END-EXEC.
EXEC CICS WRITEQ TS QUEUE('QUEUEA') END-EXEC.`;

    const blocks = extract(source).execCicsBlocks;

    expect(blocks[0]).toMatchObject({ programName: 'WS-PROGRAM', programIsLiteral: false });
    expect(blocks[1]).toMatchObject({ transId: 'WS-TRANS', transIdIsLiteral: false });
    expect(blocks[2]).toMatchObject({ mapName: 'MAPA', mapIsLiteral: true });
    expect(blocks[3]).toMatchObject({ fileName: 'WS-FILE', fileIsLiteral: false });
    expect(blocks[4]).toMatchObject({ queueName: 'QUEUEA', queueIsLiteral: true });
  });
});
