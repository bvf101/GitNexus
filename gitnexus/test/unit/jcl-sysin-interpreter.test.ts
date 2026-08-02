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
        '  OUTFIL FNAMES=SORTOUT',
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
        '  DELETE APP.OLD.DATA',
        '  DEFINE CLUSTER(NAME(APP.NEW.DATA) -',
        '          RECORDSIZE(80 80))',
        '  REPRO INDATASET(APP.INPUT) OUTDATASET(APP.OUTPUT)',
      ].join('\n'),
    );

    expect(commands.map((command) => command.verb)).toEqual(['DELETE', 'DEFINE', 'REPRO']);
    expect(commands[0].datasets).toEqual(['APP.OLD.DATA']);
    expect(commands[1].datasets).toEqual(['APP.NEW.DATA']);
    expect(commands[2].datasets).toEqual(['APP.INPUT', 'APP.OUTPUT']);
    expect(commands[1].endLineOffset).toBe(2);
  });

  it('extracts a DB2 program, plan, and load library from IKJEFT control cards', () => {
    const commands = interpretJclSysin(
      'IKJEFT1B',
      'SYSTSIN',
      [
        '  DSN SYSTEM(DB2P)',
        "  RUN PROGRAM(PAYPGM) PLAN(PAYPLAN) LIB('APP.LOADLIB')",
        '  END',
      ].join('\n'),
    );

    expect(commands.map((command) => command.verb)).toEqual(['DSN', 'RUN', 'END']);
    expect(commands[1]).toMatchObject({
      utility: 'tso-db2',
      programs: ['PAYPGM'],
      plans: ['PAYPLAN'],
      datasets: ['APP.LOADLIB'],
    });
  });

  it('keeps unknown-program SYSIN as a generic command block', () => {
    const commands = interpretJclSysin('MYUTIL', 'SYSIN', '  CONTROL A=1\n  OPTION B=2');
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ utility: 'generic', verb: 'CONTROL' });
  });
});
