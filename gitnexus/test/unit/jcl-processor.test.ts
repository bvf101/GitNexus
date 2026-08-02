import { describe, expect, it } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { processJclFiles } from '../../src/core/ingestion/cobol/jcl-processor.js';
import { generateId } from '../../src/lib/utils.js';

function addFile(graph: ReturnType<typeof createKnowledgeGraph>, filePath: string): void {
  graph.addNode({
    id: generateId('File', filePath),
    label: 'File',
    properties: { name: filePath.split('/').pop() ?? filePath, filePath },
  });
}

describe('processJclFiles', () => {
  it('attaches direct SYSIN to an EXEC PGM step when the job has no PROC', () => {
    const graph = createKnowledgeGraph();
    const filePath = 'jobs/SORTJOB.jcl';
    addFile(graph, filePath);
    const job = [
      '//SORTJOB  JOB (ACCT)',
      '//SORTSTEP EXEC PGM=SORT',
      '//SYSIN    DD *',
      '  SORT FIELDS=(1,10,CH,A)',
      '/*',
    ].join('\n');

    const result = processJclFiles(graph, [filePath], new Map([[filePath, job]]));
    expect(result).toMatchObject({ jobCount: 1, stepCount: 1, procCount: 0, sysinCount: 1 });

    const step = graph.nodes.find(
      (node) =>
        node.properties.name === 'SORTSTEP' && node.properties.description === 'jcl-step pgm:SORT',
    );
    const sysin = graph.nodes.find(
      (node) =>
        node.properties.name === 'SYSIN' && node.properties.description?.startsWith('jcl-sysin'),
    );
    const sortCommand = graph.nodes.find(
      (node) =>
        node.properties.name === 'DFSORT SORT' &&
        node.properties.description === 'jcl-sysin-command utility:sort verb:SORT',
    );
    expect(step).toBeDefined();
    expect(sysin).toBeDefined();
    expect(sortCommand).toBeDefined();
    expect(
      graph.relationships.some(
        (relationship) =>
          relationship.sourceId === step?.id &&
          relationship.targetId === sysin?.id &&
          relationship.type === 'CONTAINS' &&
          relationship.reason === 'jcl-sysin',
      ),
    ).toBe(true);
    expect(
      graph.relationships.some(
        (relationship) =>
          relationship.sourceId === sysin?.id &&
          relationship.targetId === sortCommand?.id &&
          relationship.type === 'CONTAINS' &&
          relationship.reason === 'jcl-sysin-command',
      ),
    ).toBe(true);
  });

  it('materializes JOB -> PROC -> internal step -> SYSIN across files', () => {
    const graph = createKnowledgeGraph();
    const jobPath = 'jobs/PAYJOB.jcl';
    const procPath = 'procs/PAYPROC.proc';
    addFile(graph, jobPath);
    addFile(graph, procPath);

    const payProgramId = generateId('Module', 'programs/PAYPGM.cbl:PAYPGM');
    graph.addNode({
      id: payProgramId,
      label: 'Module',
      properties: {
        name: 'PAYPGM',
        filePath: 'programs/PAYPGM.cbl',
        description: 'cobol-program',
      },
    });

    const job = [
      '//PAYJOB   JOB (ACCT)',
      '//RUNPAY   EXEC PROC=PAYPROC',
      '//PSTEP.SYSIN DD *,DLM=@@',
      '  SORT FIELDS=COPY',
      '@@',
    ].join('\n');
    const proc = [
      '//PAYPROC  PROC',
      '//PSTEP    EXEC PGM=PAYPGM',
      '//SYSIN    DD DSN=APP.DEFAULT.CARDS,DISP=SHR',
      '// PEND',
    ].join('\n');

    // Job first deliberately proves PROC resolution is not traversal-order dependent.
    const result = processJclFiles(
      graph,
      [jobPath, procPath],
      new Map([
        [jobPath, job],
        [procPath, proc],
      ]),
    );

    expect(result).toEqual({
      jobCount: 1,
      stepCount: 2,
      procCount: 1,
      datasetCount: 1,
      sysinCount: 2,
      sysinCommandCount: 1,
      programLinks: 1,
    });

    const node = (name: string, descriptionPrefix: string) =>
      graph.nodes.find(
        (candidate) =>
          candidate.properties.name === name &&
          candidate.properties.description?.startsWith(descriptionPrefix),
      );
    const requireNode = (name: string, descriptionPrefix: string) => {
      const found = node(name, descriptionPrefix);
      expect(found, `missing ${descriptionPrefix} node ${name}`).toBeDefined();
      if (!found) throw new Error(`missing ${descriptionPrefix} node ${name}`);
      return found;
    };
    const jobNode = requireNode('PAYJOB', 'jcl-job');
    const invocationNode = requireNode('RUNPAY', 'jcl-step');
    const procNode = requireNode('PAYPROC', 'jcl-proc-cataloged');
    const procStepNode = requireNode('PSTEP', 'jcl-proc-step');
    const defaultSysin = requireNode('SYSIN', 'jcl-sysin');
    const overrideSysin = requireNode('PSTEP.SYSIN', 'jcl-sysin');
    const datasetNode = requireNode('APP.DEFAULT.CARDS', 'jcl-dataset');

    expect(overrideSysin.properties.content).toBe('  SORT FIELDS=COPY');
    expect(overrideSysin.properties.description).toContain('override:true');

    const hasEdge = (sourceId: string, targetId: string, type: string, reason: string) =>
      graph.relationships.some(
        (relationship) =>
          relationship.sourceId === sourceId &&
          relationship.targetId === targetId &&
          relationship.type === type &&
          relationship.reason === reason,
      );

    expect(hasEdge(jobNode.id, invocationNode.id, 'CONTAINS', 'jcl-step')).toBe(true);
    expect(hasEdge(invocationNode.id, procNode.id, 'CALLS', 'jcl-exec-proc')).toBe(true);
    expect(hasEdge(procNode.id, procStepNode.id, 'CONTAINS', 'jcl-proc-step')).toBe(true);
    expect(hasEdge(procStepNode.id, payProgramId, 'CALLS', 'jcl-exec-pgm')).toBe(true);
    expect(hasEdge(procStepNode.id, defaultSysin.id, 'CONTAINS', 'jcl-sysin')).toBe(true);
    expect(hasEdge(procStepNode.id, overrideSysin.id, 'CONTAINS', 'jcl-sysin')).toBe(true);
    expect(hasEdge(defaultSysin.id, datasetNode.id, 'ACCESSES', 'jcl-sysin-dataset')).toBe(true);
    expect(hasEdge(procStepNode.id, datasetNode.id, 'CALLS', 'jcl-dd:SYSIN')).toBe(true);
  });
});
