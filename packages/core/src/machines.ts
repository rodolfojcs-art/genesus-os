/**
 * Capa de conectores de fábrica (principio 1.7). El "control de fábrica" v1 es
 * una interfaz común con un adaptador `simulator` funcional y stubs documentados
 * para MQTT y OPC-UA. La UI nunca promete control físico inexistente: cada
 * conector expone su estado real.
 */
export type MachineAdapterKind = 'simulator' | 'mqtt' | 'opcua';

export type ConnectorState = 'simulado' | 'conectado' | 'sin configurar';

export interface MachineStatus {
  machineId: string;
  state: 'inactiva' | 'operando' | 'detenida' | 'error';
  orderId: string | null;
  progressPct: number;
  unitsDone: number;
  unitsTarget: number;
  updatedAt: string;
}

export interface MachineAdapter {
  readonly kind: MachineAdapterKind;
  connectorState(): ConnectorState;
  startOrder(orderId: string, units: number): Promise<void>;
  status(): Promise<MachineStatus>;
  stop(): Promise<void>;
}

/** Adaptador simulador: avanza la producción en función del tiempo transcurrido. */
export class SimulatorAdapter implements MachineAdapter {
  readonly kind = 'simulator' as const;
  private readonly machineId: string;
  private readonly unitsPerMinute: number;
  private orderId: string | null = null;
  private unitsTarget = 0;
  private startedAt: number | null = null;
  private stopped = false;

  constructor(machineId: string, unitsPerMinute = 12) {
    this.machineId = machineId;
    this.unitsPerMinute = unitsPerMinute;
  }

  connectorState(): ConnectorState {
    return 'simulado';
  }

  async startOrder(orderId: string, units: number): Promise<void> {
    this.orderId = orderId;
    this.unitsTarget = units;
    this.startedAt = Date.now();
    this.stopped = false;
  }

  async status(): Promise<MachineStatus> {
    const now = new Date().toISOString();
    if (this.orderId === null || this.startedAt === null) {
      return {
        machineId: this.machineId,
        state: 'inactiva',
        orderId: null,
        progressPct: 0,
        unitsDone: 0,
        unitsTarget: 0,
        updatedAt: now,
      };
    }
    const elapsedMin = (Date.now() - this.startedAt) / 60_000;
    const unitsDone = Math.min(this.unitsTarget, Math.floor(elapsedMin * this.unitsPerMinute));
    const done = unitsDone >= this.unitsTarget;
    return {
      machineId: this.machineId,
      state: this.stopped ? 'detenida' : done ? 'inactiva' : 'operando',
      orderId: done ? null : this.orderId,
      progressPct: this.unitsTarget === 0 ? 0 : Math.round((unitsDone / this.unitsTarget) * 100),
      unitsDone,
      unitsTarget: this.unitsTarget,
      updatedAt: now,
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }
}

export class ConnectorNotConfiguredError extends Error {
  constructor(kind: MachineAdapterKind) {
    super(
      `El conector "${kind}" no está configurado. ` +
        `Configura la conexión en machines.config antes de operar la máquina.`,
    );
    this.name = 'ConnectorNotConfiguredError';
  }
}

/**
 * Stub MQTT — v1 documentado, sin conexión real.
 * Implementación futura: cliente MQTT (ej. mqtt.js) suscrito a
 * `genesus/machines/{id}/status` y publicando órdenes en
 * `genesus/machines/{id}/orders`. Config esperada: { brokerUrl, username,
 * password, topicPrefix }.
 */
export class MqttAdapterStub implements MachineAdapter {
  readonly kind = 'mqtt' as const;
  constructor(private readonly machineId: string) {}
  connectorState(): ConnectorState {
    return 'sin configurar';
  }
  async startOrder(): Promise<void> {
    throw new ConnectorNotConfiguredError('mqtt');
  }
  async status(): Promise<MachineStatus> {
    return {
      machineId: this.machineId,
      state: 'inactiva',
      orderId: null,
      progressPct: 0,
      unitsDone: 0,
      unitsTarget: 0,
      updatedAt: new Date().toISOString(),
    };
  }
  async stop(): Promise<void> {
    throw new ConnectorNotConfiguredError('mqtt');
  }
}

/**
 * Stub OPC-UA — v1 documentado, sin conexión real.
 * Implementación futura: cliente OPC-UA (ej. node-opcua) leyendo nodos de
 * estado y escribiendo nodos de comando. Config esperada: { endpointUrl,
 * securityPolicy, credentials, nodeIds }.
 */
export class OpcUaAdapterStub implements MachineAdapter {
  readonly kind = 'opcua' as const;
  constructor(private readonly machineId: string) {}
  connectorState(): ConnectorState {
    return 'sin configurar';
  }
  async startOrder(): Promise<void> {
    throw new ConnectorNotConfiguredError('opcua');
  }
  async status(): Promise<MachineStatus> {
    return {
      machineId: this.machineId,
      state: 'inactiva',
      orderId: null,
      progressPct: 0,
      unitsDone: 0,
      unitsTarget: 0,
      updatedAt: new Date().toISOString(),
    };
  }
  async stop(): Promise<void> {
    throw new ConnectorNotConfiguredError('opcua');
  }
}

export function createAdapter(kind: MachineAdapterKind, machineId: string): MachineAdapter {
  switch (kind) {
    case 'simulator':
      return new SimulatorAdapter(machineId);
    case 'mqtt':
      return new MqttAdapterStub(machineId);
    case 'opcua':
      return new OpcUaAdapterStub(machineId);
  }
}
