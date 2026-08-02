import { describe, expect, it } from 'vitest';
import { interpretJclSysin } from '../../src/core/ingestion/cobol/jcl-sysin-interpreter.js';

describe('interpretJclSysin', () => {
  it('identifies DFSORT control statements', () => {
    const commands = interpretJclSysin(
      'SORT',
      'SYSIN',
      [
        '  SORT FIELDS=(1,10,CH,A)',
        "  INCLUDE COND=(11,1,CH,EQ,C'A')",
        '  OUTFIL FNAMES=GNXOUT01',
      ].join('\n'),
    );

    expect(commands.map((command) => command.verb)).toEqual(['SORT', 'INCLUDE', 'OUTFIL']);
    expect(commands.every((command) => command.utility === 'sort')).toBe(true);
  });

  it('collects IDCAMS datasets across positional and parenthesized operands', () => {
    const commands = interpretJclSysin(
      'IDCAMS',
      'SYSIN',
      [
        '  DELETE GNX.OLD.DATA',
        '  DEFINE CLUSTER(NAME(GNX.NEW.DATA) -',
        '          RECORDSIZE(80 80))',
        '  REPRO INDATASET(GNX.INPUT) OUTDATASET(GNX.OUTPUT)',
      ].join('\n'),
    );

    expect(commands.map((command) => command.verb)).toEqual(['DELETE', 'DEFINE', 'REPRO']);
    expect(commands[0].datasets).toEqual(['GNX.OLD.DATA']);
    expect(commands[1].datasets).toEqual(['GNX.NEW.DATA']);
    expect(commands[2].datasets).toEqual(['GNX.INPUT', 'GNX.OUTPUT']);
    expect(commands[1].endLineOffset).toBe(2);
  });

  it('extracts a DB2 program, plan, and load library from IKJEFT control cards', () => {
    const commands = interpretJclSysin(
      'IKJEFT1B',
      'SYSTSIN',
      [
        '  DSN SYSTEM(GXDB)',
        "  RUN PROGRAM(GNXPGM03) PLAN(GNXPLN01) LIB('GNX.LOADLIB')",
        '  END',
      ].join('\n'),
    );

    expect(commands.map((command) => command.verb)).toEqual(['DSN', 'RUN', 'END']);
    expect(commands[1]).toMatchObject({
      utility: 'tso-db2',
      programs: ['GNXPGM03'],
      plans: ['GNXPLN01'],
      datasets: ['GNX.LOADLIB'],
    });
  });

  it('keeps unknown-program SYSIN as a generic command block', () => {
    const commands = interpretJclSysin('GNXUTL01', 'SYSIN', '  CONTROL A=1\n  OPTION B=2');
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ utility: 'generic', verb: 'CONTROL' });
  });
});
