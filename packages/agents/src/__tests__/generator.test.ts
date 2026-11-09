import { describe, expect, it } from 'vitest';
import { generateNetwork } from '../generator.js';
import { TAXONOMY } from '../taxonomy.js';

const net = generateNetwork();

describe('generador de la red (criterio Fase 1)', () => {
  it('produce exactamente 10 divisiones, 1.000 agentes y 10.000 subagentes', () => {
    expect(net.divisions).toHaveLength(10);
    expect(net.agents).toHaveLength(1000);
    expect(net.subagents).toHaveLength(10_000);
  });

  it('cada división aporta exactamente 100 agentes con 25 dominios', () => {
    for (const div of TAXONOMY) {
      expect(div.domains).toHaveLength(25);
      expect(net.agents.filter((a) => a.divisionCode === div.code)).toHaveLength(100);
    }
  });

  it('usa IDs canónicos ENRG-001…CORP-100 y .1….10', () => {
    expect(net.agents[0]?.code).toBe('ENRG-001');
    expect(net.agents.at(-1)?.code).toBe('CORP-100');
    for (const a of net.agents) {
      expect(a.code).toMatch(/^(ENRG|ELEC|SCI|COMP|DSGN|MFG|SUPL|COMM|FIN|CORP)-\d{3}$/);
    }
    expect(net.subagents[0]?.code).toBe('ENRG-001.1');
    for (const s of net.subagents.slice(0, 100)) {
      expect(s.code).toMatch(/^ENRG-\d{3}\.(10|[1-9])$/);
    }
  });

  it('los códigos son únicos', () => {
    expect(new Set(net.agents.map((a) => a.code)).size).toBe(1000);
    expect(new Set(net.subagents.map((s) => s.code)).size).toBe(10_000);
  });

  it('las 100 especialidades por división son únicas (25 dominios × 4 enfoques)', () => {
    for (const div of TAXONOMY) {
      const specs = net.agents.filter((a) => a.divisionCode === div.code).map((a) => a.specialty);
      expect(new Set(specs).size).toBe(100);
    }
  });

  it('los prompts se generan parametrizados con identidad y especialidad', () => {
    const agent = net.agents.find((a) => a.code === 'ENRG-009')!;
    expect(agent.systemPrompt).toContain('ENRG-009');
    expect(agent.systemPrompt).toContain('Energía');
    expect(agent.systemPrompt).toContain(agent.specialty.split(' · ')[0]!);
    expect(agent.systemPrompt).toContain('español latinoamericano');
  });

  it('routing de subagentes: slots 2 y 4 en sonnet, resto en haiku', () => {
    const subs = net.subagents.filter((s) => s.agentCode === 'COMP-001');
    expect(subs).toHaveLength(10);
    for (const s of subs) {
      const slot = Number(s.code.split('.')[1]);
      expect(s.modelTier).toBe(slot === 2 || slot === 4 ? 'sonnet' : 'haiku');
    }
  });

  it('el subagente 5 (QA) exige formato APROBADO/RECHAZADO', () => {
    const qa = net.subagents.find((s) => s.code === 'MFG-050.5')!;
    expect(qa.systemPrompt).toContain('APROBADO');
    expect(qa.systemPrompt).toContain('RECHAZADO');
  });

  it('cero referencias a TerraMercado (separación absoluta)', () => {
    const all = JSON.stringify(net).toLowerCase();
    expect(all).not.toContain('terramercado');
  });
});
