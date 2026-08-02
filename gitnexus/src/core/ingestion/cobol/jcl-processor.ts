/**
 * JCL Processor — converts parsed JCL into persistent graph topology.
 *
 * Nodes:
 * - Job / step / dataset / SYSIN -> CodeElement
 * - PROC -> Module
 *
 * Edges preserve the executable hierarchy:
 * - File CONTAINS Job / PROC
 * - Job CONTAINS invocation step
 * - invocation step CALLS PROC
 * - PROC CONTAINS its internal steps
 * - step CALLS program and referenced datasets
 * - step CONTAINS SYSIN; dataset-backed SYSIN ACCESSES its dataset
 */

import { parseJcl, type JclParseResults } from './jcl-parser.js';
import { interpretJclSysin } from './jcl-sysin-interpreter.js';
import type { KnowledgeGraph } from '../../graph/types.js';
import { generateId } from '../../../lib/utils.js';
import { toZeroBasedLine } from '../utils/line-base.js';

export interface JclProcessResult {
  jobCount: number;
  stepCount: number;
  procCount: number;
  datasetCount: number;
  sysinCount: number;
  sysinCommandCount: number;
  programLinks: number;
}

type ParsedJclFile = {
  filePath: string;
  parsed: JclParseResults;
};

type JclStep = JclParseResults['steps'][number];
type JclDdStatement = JclParseResults['ddStatements'][number];

function jobNodeId(filePath: string, jobName: string): string {
  return generateId('CodeElement', `${filePath}:job:${jobName}`);
}

function procDefinitionKey(filePath: string, procName: string): string {
  return `${filePath}:${procName.toUpperCase()}`;
}

function procStepKey(procId: string, stepName: string): string {
  return `${procId}:${stepName.toUpperCase()}`;
}

function jobStepKey(filePath: string, jobName: string, stepName: string): string {
  return `${filePath}:${jobName.toUpperCase()}:${stepName.toUpperCase()}`;
}

function stepNodeId(filePath: string, step: JclStep): string {
  return step.ownerProc
    ? generateId('CodeElement', `${filePath}:proc-step:${step.ownerProc}:${step.name}`)
    : generateId('CodeElement', `${filePath}:step:${step.jobName}:${step.name}`);
}

function addContains(
  graph: KnowledgeGraph,
  sourceId: string,
  targetId: string,
  reason: string,
): void {
  graph.addRelationship({
    id: generateId('CONTAINS', `${sourceId}->${targetId}:${reason}`),
    type: 'CONTAINS',
    sourceId,
    targetId,
    confidence: 1.0,
    reason,
  });
}

function resolveProcId(
  filePath: string,
  procName: string,
  procIdsByDefinition: Map<string, string>,
  procIdsByName: Map<string, string>,
): string | undefined {
  return (
    procIdsByDefinition.get(procDefinitionKey(filePath, procName)) ??
    procIdsByName.get(procName.toUpperCase())
  );
}

function resolveDdStepId(
  filePath: string,
  parsed: JclParseResults,
  dd: JclDdStatement,
  jobStepIds: Map<string, string>,
  procStepIds: Map<string, string>,
  procIdsByDefinition: Map<string, string>,
  procIdsByName: Map<string, string>,
): string | undefined {
  if (dd.ownerProc) {
    const ownerProcId = resolveProcId(filePath, dd.ownerProc, procIdsByDefinition, procIdsByName);
    if (ownerProcId) return procStepIds.get(procStepKey(ownerProcId, dd.stepName));
  }

  if (dd.overridePath.length > 0) {
    const invocationNames = [dd.invocationStepName, dd.overridePath[0]].filter(Boolean);
    const invocation = parsed.steps.find(
      (step) =>
        !step.ownerProc &&
        step.jobName === dd.jobName &&
        invocationNames.includes(step.name) &&
        Boolean(step.proc),
    );
    if (invocation?.proc) {
      const calledProcId = resolveProcId(
        filePath,
        invocation.proc,
        procIdsByDefinition,
        procIdsByName,
      );
      if (calledProcId) {
        const overriddenStep = dd.overridePath[dd.overridePath.length - 1];
        const overriddenStepId = procStepIds.get(procStepKey(calledProcId, overriddenStep));
        if (overriddenStepId) return overriddenStepId;
      }
    }
  }

  return jobStepIds.get(jobStepKey(filePath, dd.jobName, dd.invocationStepName || dd.stepName));
}

/**
 * Process all JCL files in three passes so catalogued procedures resolve
 * independently of file traversal order.
 */
export function processJclFiles(
  graph: KnowledgeGraph,
  jclPaths: string[],
  jclContents: Map<string, string>,
): JclProcessResult {
  const result: JclProcessResult = {
    jobCount: 0,
    stepCount: 0,
    procCount: 0,
    datasetCount: 0,
    sysinCount: 0,
    sysinCommandCount: 0,
    programLinks: 0,
  };

  const parsedFiles: ParsedJclFile[] = [];
  for (const filePath of jclPaths) {
    const content = jclContents.get(filePath);
    if (content === undefined) continue;
    parsedFiles.push({ filePath, parsed: parseJcl(content, filePath) });
  }

  // COBOL program modules exist before the JCL phase. Keep them separate from
  // PROC modules so a same-named procedure cannot hijack EXEC PGM resolution.
  const programModuleIds = new Map<string, string>();
  graph.forEachNode((node) => {
    if (node.label !== 'Module') return;
    const nodeName = node.properties.name;
    const description = node.properties.description;
    if (typeof nodeName !== 'string' || description?.startsWith('jcl-proc')) return;
    programModuleIds.set(nodeName.toUpperCase(), node.id);
  });

  const procIdsByDefinition = new Map<string, string>();
  const procIdsByName = new Map<string, string>();
  const jobStepIds = new Map<string, string>();
  const procStepIds = new Map<string, string>();
  const stepsById = new Map<string, JclStep>();

  // Pass 1: materialize every Job and PROC before resolving any EXEC PROC.
  for (const { filePath, parsed } of parsedFiles) {
    const fileId = generateId('File', filePath);

    for (const job of parsed.jobs) {
      const jobId = jobNodeId(filePath, job.name);
      const classPart = job.class ? ` class:${job.class}` : '';
      const msgPart = job.msgclass ? ` msgclass:${job.msgclass}` : '';
      graph.addNode({
        id: jobId,
        label: 'CodeElement',
        properties: {
          name: job.name,
          filePath,
          startLine: toZeroBasedLine(job.line),
          endLine: toZeroBasedLine(job.line),
          description: `jcl-job${classPart}${msgPart}`,
        },
      });
      addContains(graph, fileId, jobId, 'jcl-job');
      result.jobCount++;
    }

    for (const proc of parsed.procs) {
      const procId = generateId('Module', `${filePath}:proc:${proc.name}`);
      procIdsByDefinition.set(procDefinitionKey(filePath, proc.name), procId);
      if (!procIdsByName.has(proc.name.toUpperCase())) {
        procIdsByName.set(proc.name.toUpperCase(), procId);
      }

      graph.addNode({
        id: procId,
        label: 'Module',
        properties: {
          name: proc.name,
          filePath,
          startLine: toZeroBasedLine(proc.line),
          endLine: toZeroBasedLine(proc.endLine ?? proc.line),
          description: proc.isInStream ? 'jcl-proc-instream' : 'jcl-proc-cataloged',
        },
      });
      addContains(graph, fileId, procId, 'jcl-proc');
      if (proc.isInStream && proc.jobName) {
        addContains(graph, jobNodeId(filePath, proc.jobName), procId, 'jcl-proc-instream');
      }
      result.procCount++;
    }
  }

  // Pass 2: create all job/procedure steps and executable links.
  for (const { filePath, parsed } of parsedFiles) {
    for (const step of parsed.steps) {
      const stepId = stepNodeId(filePath, step);
      const pgmPart = step.program ? ` pgm:${step.program}` : '';
      const procPart = step.proc ? ` proc:${step.proc}` : '';
      const descriptionPrefix = step.ownerProc ? 'jcl-proc-step' : 'jcl-step';

      graph.addNode({
        id: stepId,
        label: 'CodeElement',
        properties: {
          name: step.name,
          filePath,
          startLine: toZeroBasedLine(step.line),
          endLine: toZeroBasedLine(step.line),
          description: `${descriptionPrefix}${pgmPart}${procPart}`,
        },
      });
      stepsById.set(stepId, step);

      if (step.ownerProc) {
        const ownerProcId = resolveProcId(
          filePath,
          step.ownerProc,
          procIdsByDefinition,
          procIdsByName,
        );
        if (ownerProcId) {
          procStepIds.set(procStepKey(ownerProcId, step.name), stepId);
          addContains(graph, ownerProcId, stepId, 'jcl-proc-step');
        }
      } else if (step.jobName) {
        jobStepIds.set(jobStepKey(filePath, step.jobName, step.name), stepId);
        addContains(graph, jobNodeId(filePath, step.jobName), stepId, 'jcl-step');
      }

      if (step.program) {
        const moduleId = programModuleIds.get(step.program.toUpperCase());
        if (moduleId) {
          graph.addRelationship({
            id: generateId('CALLS', `${stepId}->program:${moduleId}`),
            type: 'CALLS',
            sourceId: stepId,
            targetId: moduleId,
            confidence: 0.95,
            reason: 'jcl-exec-pgm',
          });
          result.programLinks++;
        }
      }

      if (step.proc) {
        const procId = resolveProcId(filePath, step.proc, procIdsByDefinition, procIdsByName);
        if (procId) {
          graph.addRelationship({
            id: generateId('CALLS', `${stepId}->proc:${procId}`),
            type: 'CALLS',
            sourceId: stepId,
            targetId: procId,
            confidence: 0.9,
            reason: 'jcl-exec-proc',
          });
        }
      }

      result.stepCount++;
    }
  }

  // Pass 3: attach DD datasets and first-class SYSIN/control-card blocks.
  for (const { filePath, parsed } of parsedFiles) {
    const fileId = generateId('File', filePath);
    const seenDatasets = new Set<string>();
    const ensureDatasetNode = (datasetName: string, line: number, disp?: string): string => {
      const datasetId = generateId('CodeElement', `${filePath}:dataset:${datasetName}`);
      if (seenDatasets.has(datasetName)) return datasetId;

      const dispPart = disp ? ` disp:${disp}` : '';
      graph.addNode({
        id: datasetId,
        label: 'CodeElement',
        properties: {
          name: datasetName,
          filePath,
          startLine: toZeroBasedLine(line),
          endLine: toZeroBasedLine(line),
          description: `jcl-dataset${dispPart}`,
        },
      });
      seenDatasets.add(datasetName);
      result.datasetCount++;
      return datasetId;
    };

    for (const dd of parsed.ddStatements) {
      const ownerStepId = resolveDdStepId(
        filePath,
        parsed,
        dd,
        jobStepIds,
        procStepIds,
        procIdsByDefinition,
        procIdsByName,
      );

      let datasetId: string | undefined;
      if (dd.dataset) {
        datasetId = ensureDatasetNode(dd.dataset, dd.line, dd.disp);

        if (ownerStepId) {
          graph.addRelationship({
            id: generateId(
              'CALLS',
              `${ownerStepId}->dd:${dd.qualifiedName}:${datasetId}:L${dd.line}`,
            ),
            type: 'CALLS',
            sourceId: ownerStepId,
            targetId: datasetId,
            confidence: 0.85,
            reason: `jcl-dd:${dd.ddName}`,
          });
        }
      }

      const isControlInput =
        dd.ddName === 'SYSIN' ||
        dd.ddName === 'SYSTSIN' ||
        dd.inputType === 'inline' ||
        dd.inputType === 'data';
      if (!isControlInput) continue;

      const sysinId = generateId(
        'CodeElement',
        `${filePath}:control-input:${dd.qualifiedName}:L${dd.line}`,
      );
      const controlKind = dd.ddName === 'SYSIN' ? 'jcl-sysin' : 'jcl-control-input';
      const modePart = ` mode:${dd.inputType}`;
      const delimiterPart = dd.delimiter ? ` delimiter:${dd.delimiter}` : '';
      const datasetPart = dd.dataset ? ` dsn:${dd.dataset}` : '';
      const overridePart = dd.overridePath.length > 0 ? ' override:true' : '';
      graph.addNode({
        id: sysinId,
        label: 'CodeElement',
        properties: {
          name: dd.qualifiedName,
          filePath,
          startLine: toZeroBasedLine(dd.line),
          endLine: toZeroBasedLine(dd.endLine),
          content: dd.content ?? '',
          description: `${controlKind}${modePart}${delimiterPart}${datasetPart}${overridePart}`,
        },
      });

      if (ownerStepId) addContains(graph, ownerStepId, sysinId, controlKind);
      else addContains(graph, fileId, sysinId, controlKind);

      if (datasetId) {
        graph.addRelationship({
          id: generateId('ACCESSES', `${sysinId}->dataset:${datasetId}`),
          type: 'ACCESSES',
          sourceId: sysinId,
          targetId: datasetId,
          confidence: 0.95,
          reason: `${controlKind}-dataset`,
        });
      }
      result.sysinCount++;

      if (!dd.content?.trim()) continue;
      const ownerProgram = ownerStepId ? stepsById.get(ownerStepId)?.program : undefined;
      const commands = interpretJclSysin(ownerProgram, dd.ddName, dd.content);
      for (const command of commands) {
        const commandLine = dd.line + 1 + command.startLineOffset;
        const commandEndLine = dd.line + 1 + command.endLineOffset;
        const commandId = generateId(
          'CodeElement',
          `${filePath}:sysin-command:${dd.qualifiedName}:${command.verb}:L${commandLine}`,
        );
        const utilityName =
          command.utility === 'sort'
            ? 'DFSORT'
            : command.utility === 'tso-db2'
              ? 'TSO-DB2'
              : command.utility === 'generic'
                ? 'SYSIN'
                : command.utility.toUpperCase();
        graph.addNode({
          id: commandId,
          label: 'CodeElement',
          properties: {
            name: `${utilityName} ${command.verb}`,
            filePath,
            startLine: toZeroBasedLine(commandLine),
            endLine: toZeroBasedLine(commandEndLine),
            content: command.text,
            description: `jcl-sysin-command utility:${command.utility} verb:${command.verb}`,
          },
        });
        addContains(graph, sysinId, commandId, 'jcl-sysin-command');
        result.sysinCommandCount++;

        for (const datasetName of command.datasets) {
          const commandDatasetId = ensureDatasetNode(datasetName, commandLine);
          graph.addRelationship({
            id: generateId('ACCESSES', `${commandId}->dataset:${commandDatasetId}`),
            type: 'ACCESSES',
            sourceId: commandId,
            targetId: commandDatasetId,
            confidence: 0.85,
            reason: `jcl-sysin-${command.utility}-dataset`,
          });
        }

        for (const programName of command.programs) {
          const programId =
            programModuleIds.get(programName) ??
            generateId('CodeElement', `${filePath}:sysin-program-reference:${programName}`);
          if (!programModuleIds.has(programName)) {
            graph.addNode({
              id: programId,
              label: 'CodeElement',
              properties: {
                name: programName,
                filePath,
                startLine: toZeroBasedLine(commandLine),
                endLine: toZeroBasedLine(commandEndLine),
                description: 'jcl-program-reference source:sysin',
              },
            });
          }
          graph.addRelationship({
            id: generateId('CALLS', `${commandId}->program:${programId}`),
            type: 'CALLS',
            sourceId: commandId,
            targetId: programId,
            confidence: programModuleIds.has(programName) ? 0.95 : 0.75,
            reason: 'jcl-sysin-run-program',
          });
        }

        for (const planName of command.plans) {
          const planId = generateId('CodeElement', `${filePath}:db2-plan:${planName}`);
          graph.addNode({
            id: planId,
            label: 'CodeElement',
            properties: {
              name: planName,
              filePath,
              startLine: toZeroBasedLine(commandLine),
              endLine: toZeroBasedLine(commandEndLine),
              description: 'jcl-db2-plan source:sysin',
            },
          });
          graph.addRelationship({
            id: generateId('ACCESSES', `${commandId}->db2-plan:${planId}`),
            type: 'ACCESSES',
            sourceId: commandId,
            targetId: planId,
            confidence: 0.9,
            reason: 'jcl-sysin-db2-plan',
          });
        }
      }
    }

    for (const include of parsed.includes) {
      const procId = resolveProcId(filePath, include.member, procIdsByDefinition, procIdsByName);
      if (!procId) continue;
      graph.addRelationship({
        id: generateId('IMPORTS', `${fileId}->include:${procId}:L${include.line}`),
        type: 'IMPORTS',
        sourceId: fileId,
        targetId: procId,
        confidence: 0.9,
        reason: 'jcl-include',
      });
    }
  }

  return result;
}
