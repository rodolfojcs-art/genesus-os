import { describe, expect, it } from 'vitest';
import { DagValidationError, runDag, topologicalLayers, validateDag } from '../dag.js';

const diamond = [
  { id: 'a', dependsOn: [] },
  { id: 'b', dependsOn: ['a'] },
  { id: 'c', dependsOn: ['a'] },
  { id: 'd', dependsOn: ['b', 'c'] },
];

describe('validación de DAG', () => {
  it('acepta un DAG válido', () => {
    expect(() => validateDag(diamond)).not.toThrow();
  });

  it('rechaza ciclos', () => {
    expect(() =>
      validateDag([
        { id: 'a', dependsOn: ['b'] },
        { id: 'b', dependsOn: ['a'] },
      ]),
    ).toThrow(DagValidationError);
  });

  it('rechaza dependencias inexistentes', () => {
    expect(() => validateDag([{ id: 'a', dependsOn: ['zz'] }])).toThrow(DagValidationError);
  });

  it('calcula capas topológicas', () => {
    expect(topologicalLayers(diamond)).toEqual([['a'], ['b', 'c'], ['d']]);
  });
});

describe('ejecución de DAG', () => {
  it('ejecuta respetando dependencias', async () => {
    const order: string[] = [];
    const results = await runDag(
      diamond,
      async (n) => {
        order.push(n.id);
        return n.id.toUpperCase();
      },
      { maxConcurrent: 8 },
    );
    expect(order[0]).toBe('a');
    expect(order[3]).toBe('d');
    expect(results.get('d')).toEqual({ status: 'completada', value: 'D' });
  });

  it('respeta MAX_CONCURRENT_AGENTS', async () => {
    let running = 0;
    let peak = 0;
    const nodes = Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, dependsOn: [] }));
    await runDag(
      nodes,
      async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 10));
        running--;
      },
      { maxConcurrent: 3 },
    );
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('omite dependientes de tareas fallidas sin ejecutarlos', async () => {
    const executed: string[] = [];
    const results = await runDag(
      diamond,
      async (n) => {
        executed.push(n.id);
        if (n.id === 'b') throw new Error('boom');
        return n.id;
      },
      { maxConcurrent: 8 },
    );
    expect(results.get('b')?.status).toBe('fallida');
    expect(results.get('d')?.status).toBe('omitida');
    expect(executed).not.toContain('d');
    expect(results.get('c')?.status).toBe('completada');
  });
});
