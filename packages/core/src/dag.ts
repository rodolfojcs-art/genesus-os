/**
 * Motor de DAG: validación, capas topológicas y ejecución con límite de
 * concurrencia (MAX_CONCURRENT_AGENTS). Sin dependencias externas — portable
 * a Electron (Fase 7).
 */
export interface DagNode {
  id: string;
  dependsOn: string[];
}

export class DagValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DagValidationError';
  }
}

export function validateDag(nodes: DagNode[]): void {
  const ids = new Set<string>();
  for (const n of nodes) {
    if (ids.has(n.id)) throw new DagValidationError(`Tarea duplicada: ${n.id}`);
    ids.add(n.id);
  }
  for (const n of nodes) {
    for (const dep of n.dependsOn) {
      if (!ids.has(dep)) {
        throw new DagValidationError(`La tarea ${n.id} depende de "${dep}", que no existe`);
      }
      if (dep === n.id) throw new DagValidationError(`La tarea ${n.id} depende de sí misma`);
    }
  }
  // Detección de ciclos (Kahn)
  const indegree = new Map<string, number>(nodes.map((n) => [n.id, n.dependsOn.length]));
  const dependents = new Map<string, string[]>();
  for (const n of nodes) {
    for (const dep of n.dependsOn) {
      const list = dependents.get(dep) ?? [];
      list.push(n.id);
      dependents.set(dep, list);
    }
  }
  const queue = nodes.filter((n) => n.dependsOn.length === 0).map((n) => n.id);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    visited++;
    for (const next of dependents.get(id) ?? []) {
      const d = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  if (visited !== nodes.length) {
    throw new DagValidationError('El plan contiene un ciclo de dependencias');
  }
}

/** Capas topológicas — útil para visualizar el plan en la UI. */
export function topologicalLayers(nodes: DagNode[]): string[][] {
  validateDag(nodes);
  const remaining = new Map(nodes.map((n) => [n.id, new Set(n.dependsOn)]));
  const layers: string[][] = [];
  const done = new Set<string>();
  while (remaining.size > 0) {
    const layer: string[] = [];
    for (const [id, deps] of remaining) {
      if ([...deps].every((d) => done.has(d))) layer.push(id);
    }
    for (const id of layer) remaining.delete(id);
    for (const id of layer) done.add(id);
    layers.push(layer);
  }
  return layers;
}

export type DagTaskResult<T> =
  | { status: 'completada'; value: T }
  | { status: 'fallida'; error: Error }
  | { status: 'omitida'; reason: string };

export interface RunDagOptions {
  maxConcurrent: number;
  /** Si una tarea falla, sus dependientes se marcan como omitidas (default true). */
  skipDependentsOnFailure?: boolean;
}

/**
 * Ejecuta el DAG respetando dependencias y el límite de agentes concurrentes.
 * Las tareas cuyas dependencias fallaron se marcan `omitida` sin ejecutarse.
 */
export async function runDag<T>(
  nodes: DagNode[],
  runTask: (node: DagNode) => Promise<T>,
  options: RunDagOptions,
): Promise<Map<string, DagTaskResult<T>>> {
  validateDag(nodes);
  const maxConcurrent = Math.max(1, options.maxConcurrent);
  const skipOnFailure = options.skipDependentsOnFailure ?? true;

  const results = new Map<string, DagTaskResult<T>>();
  const pending = new Map(nodes.map((n) => [n.id, n]));
  const running = new Map<string, Promise<void>>();

  const isReady = (n: DagNode): boolean =>
    n.dependsOn.every((d) => results.get(d)?.status === 'completada');

  const isBlocked = (n: DagNode): boolean =>
    skipOnFailure &&
    n.dependsOn.some((d) => {
      const r = results.get(d);
      return r !== undefined && r.status !== 'completada';
    });

  while (pending.size > 0 || running.size > 0) {
    // Marcar omitidas las tareas bloqueadas por fallos previos
    for (const [id, node] of [...pending]) {
      if (isBlocked(node)) {
        results.set(id, { status: 'omitida', reason: 'dependencia fallida' });
        pending.delete(id);
      }
    }
    // Lanzar tareas listas hasta el límite de concurrencia
    for (const [id, node] of [...pending]) {
      if (running.size >= maxConcurrent) break;
      if (!isReady(node)) continue;
      pending.delete(id);
      const p = runTask(node)
        .then((value) => {
          results.set(id, { status: 'completada', value });
        })
        .catch((error: unknown) => {
          results.set(id, {
            status: 'fallida',
            error: error instanceof Error ? error : new Error(String(error)),
          });
        })
        .finally(() => {
          running.delete(id);
        });
      running.set(id, p);
    }
    if (running.size > 0) {
      await Promise.race(running.values());
    } else if (pending.size > 0) {
      // Nada corriendo y nada listo: dependencias imposibles (no debería pasar tras validateDag)
      for (const [id] of pending) {
        results.set(id, { status: 'omitida', reason: 'dependencias no resolubles' });
      }
      pending.clear();
    }
  }
  return results;
}
