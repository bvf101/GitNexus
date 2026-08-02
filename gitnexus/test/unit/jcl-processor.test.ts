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
    const filePath = 'jobs/GNXJOB03.jcl';
    addFile(graph, filePath);
    const job = [
      '//GNXJOB03 JOB (GNXACCT)',
      '//GNXSTP02 EXEC PGM=SORT',
      '//SYSIN    DD *',
      '  SORT FIELDS=(1,10,CH,A)',
      '/*',
    ].join('\n');

    const result = processJclFiles(graph, [filePath], new Map([[filePath, job]]));
    expect(result).toMatchObject({ jobCount: 1, stepCount: 1, procCount: 0, sysinCount: 1 });

    const step = graph.nodes.find(
      (node) =>
        node.properties.name === 'GNXSTP02' && node.properties.description === 'jcl-step pgm:SORT',
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
    const jobPath = 'jobs/GNXJOB01.jcl';
    const procPath = 'procs/GNXPRC01.proc';
    addFile(graph, jobPath);
    addFile(graph, procPath);

    const payProgramId = generateId('Module', 'programs/GNXPGM03.cbl:GNXPGM03');
    graph.addNode({
      id: payProgramId,
      label: 'Module',
      properties: {
        name: 'GNXPGM03',
        filePath: 'programs/GNXPGM03.cbl',
        description: 'cobol-program',
      },
    });

    const job = [
      '//GNXJOB01 JOB (GNXACCT)',
      '//GNXRUN01 EXEC PROC=GNXPRC01',
      '//GNXSTP01.SYSIN DD *,DLM=@@',
      '  SORT FIELDS=COPY',
      '@@',
    ].join('\n');
    const proc = [
      '//GNXPRC01 PROC',
      '//GNXSTP01 EXEC PGM=GNXPGM03',
      '//SYSIN    DD DSN=GNX.DEFAULT.CARDS,DISP=SHR',
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
    const jobNode = requireNode('GNXJOB01', 'jcl-job');
    const invocationNode = requireNode('GNXRUN01', 'jcl-step');
    const procNode = requireNode('GNXPRC01', 'jcl-proc-cataloged');
    const procStepNode = requireNode('GNXSTP01', 'jcl-proc-step');
    const defaultSysin = requireNode('SYSIN', 'jcl-sysin');
    const overrideSysin = requireNode('GNXSTP01.SYSIN', 'jcl-sysin');
    const datasetNode = requireNode('GNX.DEFAULT.CARDS', 'jcl-dataset');

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
