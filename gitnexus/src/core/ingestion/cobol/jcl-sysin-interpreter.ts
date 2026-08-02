export type JclSysinUtility = 'sort' | 'idcams' | 'tso-db2' | 'generic';

export interface JclSysinCommand {
  utility: JclSysinUtility;
  verb: string;
  text: string;
  startLineOffset: number;
  endLineOffset: number;
  datasets: string[];
  programs: string[];
  plans: string[];
}

const SORT_PROGRAMS = new Set(['SORT', 'DFSORT', 'ICEMAN', 'SYNCSORT']);
const TSO_PROGRAMS = new Set(['IKJEFT01', 'IKJEFT1A', 'IKJEFT1B', 'IKJEFT1P', 'IKJEFT02']);

const SORT_VERBS = new Set([
  'ALTSEQ',
  'COPY',
  'DEBUG',
  'INCLUDE',
  'INREC',
  'JOIN',
  'JOINKEYS',
  'MERGE',
  'MODS',
  'OMIT',
  'OPTION',
  'OUTFIL',
  'OUTREC',
  'RECORD',
  'REFORMAT',
  'SORT',
  'SUM',
]);

const IDCAMS_VERBS = new Set([
  'ALTER',
  'BLDINDEX',
  'DEFINE',
  'DELETE',
  'DO',
  'ELSE',
  'END',
  'EXAMINE',
  'EXPORT',
  'IF',
  'IMPORT',
  'LISTCAT',
  'PRINT',
  'REPRO',
  'SET',
  'THEN',
  'VERIFY',
]);

const TSO_VERBS = new Set([
  'ALLOCATE',
  'CALL',
  'DELETE',
  'DSN',
  'END',
  'EXEC',
  'FREE',
  'RENAME',
  'RUN',
  'SUBMIT',
]);

function unique(values: Iterable<string>): string[] {
  return [...new Set(values)];
}

function normalizeResourceName(value: string): string {
  return value
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/[),;]+$/g, '')
    .toUpperCase();
}

function classifyUtility(programName: string | undefined, ddName: string): JclSysinUtility {
  const program = programName?.toUpperCase() ?? '';
  if (SORT_PROGRAMS.has(program) || program.endsWith('SORT')) return 'sort';
  if (program === 'IDCAMS') return 'idcams';
  if (TSO_PROGRAMS.has(program) || ddName.toUpperCase() === 'SYSTSIN') return 'tso-db2';
  return 'generic';
}

function verbSet(utility: JclSysinUtility): ReadonlySet<string> | undefined {
  if (utility === 'sort') return SORT_VERBS;
  if (utility === 'idcams') return IDCAMS_VERBS;
  if (utility === 'tso-db2') return TSO_VERBS;
  return undefined;
}

function firstVerb(text: string): string {
  return text.match(/^\s*([A-Z][A-Z0-9-]*)\b/i)?.[1]?.toUpperCase() ?? 'CONTROL';
}

function extractDatasets(text: string, utility: JclSysinUtility, verb: string): string[] {
  const datasets: string[] = [];
  const operands =
    /\b(?:DA|DATASET|DSNAME|ENT|ENTRY|INDATASET|LIB|LIBRARY|NAME|NEWNAME|OUTDATASET)\s*\(\s*['"]?([A-Z0-9@$#&][A-Z0-9@$#&.-]*)/gi;
  for (const match of text.matchAll(operands)) {
    datasets.push(normalizeResourceName(match[1]));
  }

  if (utility === 'idcams' || utility === 'tso-db2') {
    const positional = text.match(
      /^\s*(?:ALTER|BLDINDEX|DELETE|EXAMINE|EXPORT|IMPORT|LISTCAT|PRINT|VERIFY)\s+(?:ENT(?:RY)?\s*\(\s*)?['"]?([A-Z0-9@$#&][A-Z0-9@$#&.-]*)/i,
    );
    if (positional && !['ALL', 'LEVEL'].includes(positional[1].toUpperCase())) {
      datasets.push(normalizeResourceName(positional[1]));
    }
  }

  // DEFINE CLUSTER(NAME(...)) is handled by NAME(...); avoid treating control
  // operands from unrelated utility families as datasets.
  return unique(datasets.filter((dataset) => dataset.length > 0 && verb !== 'DSN'));
}

function extractPrograms(text: string): string[] {
  const programs: string[] = [];
  for (const match of text.matchAll(/\bPROGRAM\s*\(\s*['"]?([A-Z0-9@$#]{1,8})/gi)) {
    programs.push(normalizeResourceName(match[1]));
  }
  for (const match of text.matchAll(/\bCALL\s+['"][^'"]*\(([A-Z0-9@$#]{1,8})\)['"]/gi)) {
    programs.push(normalizeResourceName(match[1]));
  }
  return unique(programs);
}

function extractPlans(text: string): string[] {
  return unique(
    [...text.matchAll(/\bPLAN\s*\(\s*['"]?([A-Z0-9@$#-]+)/gi)].map((match) =>
      normalizeResourceName(match[1]),
    ),
  );
}

type CommandAccumulator = {
  verb: string;
  lines: string[];
  startLineOffset: number;
  endLineOffset: number;
};

function finishCommand(utility: JclSysinUtility, accumulator: CommandAccumulator): JclSysinCommand {
  const text = accumulator.lines.join('\n');
  return {
    utility,
    verb: accumulator.verb,
    text,
    startLineOffset: accumulator.startLineOffset,
    endLineOffset: accumulator.endLineOffset,
    datasets: extractDatasets(text, utility, accumulator.verb),
    programs: extractPrograms(text),
    plans: extractPlans(text),
  };
}

/**
 * Interpret inline SYSIN/SYSTSIN control cards without requiring a PROC.
 * Unknown programs still receive generic command nodes; known utilities add
 * utility-specific command boundaries and resource extraction.
 */
export function interpretJclSysin(
  programName: string | undefined,
  ddName: string,
  content: string,
): JclSysinCommand[] {
  const utility = classifyUtility(programName, ddName);
  const knownVerbs = verbSet(utility);
  const commands: JclSysinCommand[] = [];
  let current: CommandAccumulator | undefined;

  const flush = (): void => {
    if (!current) return;
    commands.push(finishCommand(utility, current));
    current = undefined;
  };

  const lines = content.split(/\r?\n/);
  for (let lineOffset = 0; lineOffset < lines.length; lineOffset++) {
    const rawLine = lines[lineOffset];
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('*') || trimmed.startsWith('//*')) continue;

    const verb = firstVerb(rawLine);
    const startsCommand = knownVerbs ? knownVerbs.has(verb) : current === undefined;
    if (startsCommand) {
      flush();
      current = {
        verb,
        lines: [rawLine],
        startLineOffset: lineOffset,
        endLineOffset: lineOffset,
      };
      continue;
    }

    if (!current) {
      current = {
        verb,
        lines: [rawLine],
        startLineOffset: lineOffset,
        endLineOffset: lineOffset,
      };
    } else {
      current.lines.push(rawLine);
      current.endLineOffset = lineOffset;
    }
  }

  flush();
  return commands;
}
