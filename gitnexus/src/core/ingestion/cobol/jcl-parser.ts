/**
 * JCL Parser — Regex single-pass extraction.
 *
 * Extracts JCL constructs from mainframe job streams:
 * - JOB statements (job name, CLASS, MSGCLASS)
 * - EXEC statements (step -> program or proc)
 * - DD statements (dataset references, DISP)
 * - PROC definitions (in-stream and catalogued)
 * - INCLUDE MEMBER= directives
 * - SET symbolic parameters
 * - IF/ELSE/ENDIF conditional execution
 * - JCLLIB ORDER= search paths
 *
 * Pattern follows cobol-preprocessor.ts — regex-only, no tree-sitter.
 */

export interface JclParseResults {
  jobs: Array<{ name: string; line: number; class?: string; msgclass?: string }>;
  steps: Array<{
    name: string;
    jobName: string;
    ownerProc?: string;
    program?: string;
    proc?: string;
    line: number;
  }>;
  ddStatements: Array<{
    ddName: string;
    qualifiedName: string;
    jobName: string;
    stepName: string;
    invocationStepName: string;
    ownerProc?: string;
    overridePath: string[];
    dataset?: string;
    disp?: string;
    inputType: 'dataset' | 'inline' | 'data' | 'other';
    delimiter?: string;
    content?: string;
    line: number;
    endLine: number;
  }>;
  procs: Array<{
    name: string;
    line: number;
    endLine?: number;
    isInStream: boolean;
    jobName?: string;
  }>;
  includes: Array<{ member: string; line: number }>;
  sets: Array<{ variable: string; value: string; line: number }>;
  jcllib: Array<{ order: string[]; line: number }>;
  conditionals: Array<{ type: 'IF' | 'ELSE' | 'ENDIF'; condition?: string; line: number }>;
}

// ── JCL statement patterns ─────────────────────────────────────────────

// JCL continuation: line ends with a non-blank in col 72, next line starts with //
// We handle continuations by joining lines before matching.

/** Match //jobname JOB ... */
const JOB_RE = /^\/\/([A-Z0-9@$#]{1,8})\s+JOB\s+(.*)/i;

/** Match //stepname EXEC PGM=program or //stepname EXEC procname */
const EXEC_RE = /^\/\/([A-Z0-9@$#]{1,8})\s+EXEC\s+(.*)/i;

/** Match //ddname DD ... */
const DD_RE = /^\/\/([A-Z0-9@$#]{1,8}(?:\.[A-Z0-9@$#]{1,8})*)\s+DD(?:\s+(.*))?$/i;

/** Match // JCLLIB ORDER=(lib1,lib2,...) */
const JCLLIB_RE = /^\/\/\s+JCLLIB\s+ORDER=\(([^)]+)\)/i;

/** Match // IF condition THEN */
const IF_RE = /^\/\/\s+IF\s+(.+)\s+THEN/i;

/** Match // ELSE */
const ELSE_RE = /^\/\/\s+ELSE\b/i;

/** Match // ENDIF */
const ENDIF_RE = /^\/\/\s+ENDIF\b/i;

/** Match // INCLUDE MEMBER=name */
const INCLUDE_RE = /^\/\/\s+INCLUDE\s+MEMBER=(\w+)/i;

/** Match // SET var=value */
const SET_RE = /^\/\/\s+SET\s+(\w+)=(.+)/i;

/** Match // PROC or //name PROC */
const PROC_RE = /^\/\/([A-Z0-9@$#]{0,8})\s+PROC\b/i;

/** Match // PEND */
const PEND_RE = /^\/\/\s+PEND\b/i;

// ── Parameter extractors ───────────────────────────────────────────────

function extractParam(params: string, key: string): string | undefined {
  // Match KEY=VALUE or KEY='VALUE' in JCL parameter string
  const re = new RegExp(`${key}=(?:'([^']*)'|(\\S+?))(?:[,\\s]|$)`, 'i');
  const m = params.match(re);
  return m ? (m[1] ?? m[2]) : undefined;
}

function extractPgm(params: string): string | undefined {
  return extractParam(params, 'PGM');
}

function extractProc(params: string): string | undefined {
  // Both EXEC PROC=name and the positional EXEC name form are valid JCL.
  if (/PGM=/i.test(params)) return undefined;
  const explicitProc = extractParam(params, 'PROC');
  if (explicitProc) return explicitProc.toUpperCase();
  const cleaned = params.replace(/,.*/, '').trim();
  // Proc name is the first token (no = sign)
  if (cleaned && !cleaned.includes('=')) {
    return cleaned.replace(/[,\s].*/s, '').toUpperCase();
  }
  return undefined;
}

function extractDsn(params: string): string | undefined {
  return extractParam(params, 'DSN') ?? extractParam(params, 'DSNAME');
}

function extractDisp(params: string): string | undefined {
  const m = params.match(/DISP=\(?\s*([^),\s]+)/i);
  return m ? m[1] : undefined;
}

function extractDlm(params: string): string | undefined {
  const match = params.match(/\bDLM=(?:'([^']{1,2})'|"([^"]{1,2})"|([^,\s]{1,2}))/i);
  return match ? (match[1] ?? match[2] ?? match[3]) : undefined;
}

function procNameFromFile(filePath: string): string {
  const fileName = filePath.split(/[\\/]/).pop() ?? '';
  const baseName = fileName.replace(/\.[^.]+$/, '').toUpperCase();
  return /^[A-Z0-9@$#]{1,8}$/.test(baseName) ? baseName : '';
}

function isDelimiterLine(text: string, delimiter: string): boolean {
  return text.startsWith(delimiter) && text.slice(delimiter.length).trim().length === 0;
}

/**
 * Parse a JCL file and extract all constructs.
 *
 * @param content - Raw JCL file content
 * @param filePath - Path for diagnostics (not used in extraction)
 * @returns Parsed JCL results
 */
export function parseJcl(content: string, filePath: string): JclParseResults {
  const results: JclParseResults = {
    jobs: [],
    steps: [],
    ddStatements: [],
    procs: [],
    includes: [],
    sets: [],
    jcllib: [],
    conditionals: [],
  };

  const rawLines = content.split(/\r?\n/);
  // Join continuation lines: a line ending with non-blank in col 71 (0-indexed)
  // followed by a line starting with // is a continuation.
  const lines: Array<{ text: string; lineNum: number }> = [];
  let i = 0;
  while (i < rawLines.length) {
    let line = rawLines[i];
    const lineNum = i + 1;

    // JCL continuation: if line is exactly 72+ chars and col 72 is non-blank
    // and the next line starts with //, join them.
    while (
      i + 1 < rawLines.length &&
      line.length >= 72 &&
      line[71] !== ' ' &&
      rawLines[i + 1].startsWith('//')
    ) {
      i++;
      // Continuation text starts after // and leading spaces
      const contText = rawLines[i].substring(2).replace(/^\s+/, ' ');
      // Remove the continuation marker (col 72+) from current line
      line = line.substring(0, 71).trimEnd() + contText;
    }

    lines.push({ text: line, lineNum });
    i++;
  }

  let currentJobName = '';
  let currentStepName = '';
  let inStreamProcName = '';

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const { text, lineNum } = lines[lineIndex];
    // Skip JCL comments (starting with //* )
    if (text.startsWith('//*')) continue;
    // Skip non-JCL lines (don't start with //)
    if (!text.startsWith('//')) continue;

    // PROC definition (in-stream)
    const procMatch = text.match(PROC_RE);
    if (procMatch) {
      const procName = procMatch[1] || procNameFromFile(filePath);
      if (procName) {
        results.procs.push({
          name: procName.toUpperCase(),
          line: lineNum,
          isInStream: currentJobName.length > 0,
          jobName: currentJobName || undefined,
        });
      }
      inStreamProcName = procName?.toUpperCase() || '';
      currentStepName = '';
      continue;
    }

    // PEND (end of in-stream proc)
    if (PEND_RE.test(text)) {
      for (let procIndex = results.procs.length - 1; procIndex >= 0; procIndex--) {
        if (results.procs[procIndex].name === inStreamProcName) {
          results.procs[procIndex].endLine = lineNum;
          break;
        }
      }
      inStreamProcName = '';
      currentStepName = '';
      continue;
    }

    // JCLLIB ORDER=
    const jcllibMatch = text.match(JCLLIB_RE);
    if (jcllibMatch) {
      const libs = jcllibMatch[1].split(',').map((s) => s.trim().replace(/'/g, ''));
      results.jcllib.push({ order: libs, line: lineNum });
      continue;
    }

    // IF/ELSE/ENDIF
    const ifMatch = text.match(IF_RE);
    if (ifMatch) {
      results.conditionals.push({ type: 'IF', condition: ifMatch[1].trim(), line: lineNum });
      continue;
    }
    if (ELSE_RE.test(text)) {
      results.conditionals.push({ type: 'ELSE', line: lineNum });
      continue;
    }
    if (ENDIF_RE.test(text)) {
      results.conditionals.push({ type: 'ENDIF', line: lineNum });
      continue;
    }

    // INCLUDE MEMBER=
    const includeMatch = text.match(INCLUDE_RE);
    if (includeMatch) {
      results.includes.push({ member: includeMatch[1].toUpperCase(), line: lineNum });
      continue;
    }

    // SET var=value
    const setMatch = text.match(SET_RE);
    if (setMatch) {
      results.sets.push({
        variable: setMatch[1].toUpperCase(),
        value: setMatch[2].trim().replace(/,\s*$/, ''),
        line: lineNum,
      });
      continue;
    }

    // JOB statement
    const jobMatch = text.match(JOB_RE);
    if (jobMatch) {
      currentJobName = jobMatch[1].toUpperCase();
      currentStepName = '';
      const params = jobMatch[2];
      results.jobs.push({
        name: currentJobName,
        line: lineNum,
        class: extractParam(params, 'CLASS'),
        msgclass: extractParam(params, 'MSGCLASS'),
      });
      continue;
    }

    // EXEC statement
    const execMatch = text.match(EXEC_RE);
    if (execMatch) {
      currentStepName = execMatch[1].toUpperCase();
      const params = execMatch[2];
      const pgm = extractPgm(params);
      const proc = pgm ? undefined : extractProc(params);

      results.steps.push({
        name: currentStepName,
        jobName: currentJobName,
        ownerProc: inStreamProcName || undefined,
        program: pgm?.toUpperCase(),
        proc: proc?.toUpperCase(),
        line: lineNum,
      });
      continue;
    }

    // DD statement
    const ddMatch = text.match(DD_RE);
    if (ddMatch) {
      const qualifiedName = ddMatch[1].toUpperCase();
      const nameParts = qualifiedName.split('.');
      const ddName = nameParts[nameParts.length - 1];
      const overridePath = nameParts.slice(0, -1);
      const params = ddMatch[2] ?? '';
      const dataset = extractDsn(params)?.toUpperCase();
      const explicitDelimiter = extractDlm(params);
      const inputType = dataset
        ? 'dataset'
        : /^\s*DATA\b/i.test(params)
          ? 'data'
          : /^\s*\*/.test(params)
            ? 'inline'
            : 'other';
      const delimiter =
        inputType === 'inline' || inputType === 'data' ? (explicitDelimiter ?? '/*') : undefined;
      const contentLines: string[] = [];
      let endLine = lineNum;

      if (delimiter) {
        let dataIndex = lineIndex + 1;
        while (dataIndex < lines.length) {
          const dataLine = lines[dataIndex];
          if (isDelimiterLine(dataLine.text, delimiter)) {
            endLine = dataLine.lineNum;
            dataIndex++;
            break;
          }

          // DD * without an explicit delimiter also ends when the next JCL
          // statement begins. DD DATA and DLM= allow // in the payload.
          if (inputType === 'inline' && !explicitDelimiter && dataLine.text.startsWith('//')) {
            break;
          }

          contentLines.push(dataLine.text);
          endLine = dataLine.lineNum;
          dataIndex++;
        }
        lineIndex = dataIndex - 1;
      }

      results.ddStatements.push({
        ddName,
        qualifiedName,
        jobName: currentJobName,
        stepName: overridePath[overridePath.length - 1] ?? currentStepName,
        invocationStepName: currentStepName,
        ownerProc: inStreamProcName || undefined,
        overridePath,
        dataset,
        disp: extractDisp(params)?.toUpperCase(),
        inputType,
        delimiter,
        content: delimiter ? contentLines.join('\n') : undefined,
        line: lineNum,
        endLine,
      });
      continue;
    }
  }

  return results;
}
