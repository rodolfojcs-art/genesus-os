import type { AgentDefinition, DivisionDefinition, SubagentDefinition } from '@genesus/core';
import { FOCUS_AREAS, TAXONOMY } from './taxonomy.js';
import { SUBAGENT_ROLES } from './subagentRoles.js';
import { buildAgentSystemPrompt, buildSubagentSystemPrompt } from './promptTemplate.js';

export interface GeneratedNetwork {
  divisions: DivisionDefinition[];
  agents: AgentDefinition[];
  subagents: SubagentDefinition[];
}

/**
 * Genera el registro completo de la red en build-time:
 * 10 divisiones × 100 agentes (25 dominios × 4 enfoques) × 10 subagentes.
 * IDs canónicos: ENRG-001…CORP-100 y ENRG-001.1…ENRG-001.10.
 */
export function generateNetwork(): GeneratedNetwork {
  const divisions: DivisionDefinition[] = [];
  const agents: AgentDefinition[] = [];
  const subagents: SubagentDefinition[] = [];

  for (const division of TAXONOMY) {
    if (division.domains.length !== 25) {
      throw new Error(
        `La división ${division.code} tiene ${division.domains.length} dominios; se requieren exactamente 25`,
      );
    }
    divisions.push({
      code: division.code,
      name: division.name,
      color: division.color,
      director: division.director,
      description: division.description,
    });

    for (let i = 1; i <= 100; i++) {
      const domain = division.domains[Math.floor((i - 1) / 4)]!;
      const focus = FOCUS_AREAS[(i - 1) % 4]!;
      const code = `${division.code}-${String(i).padStart(3, '0')}`;
      const [domainName, domainScope] = domain;
      const specialty = `${domainName} · ${focus.label}`;

      agents.push({
        code,
        divisionCode: division.code,
        name: `Departamento ${code} — ${specialty}`,
        specialty,
        description: domainScope,
        capabilities: [focus.mission, `dominio: ${domainScope}`],
        deliverables: focus.deliverables,
        systemPrompt: buildAgentSystemPrompt({
          code,
          division,
          domainName,
          domainScope,
          focus,
        }),
        modelTier: 'sonnet',
        status: 'activo',
      });

      for (const role of SUBAGENT_ROLES) {
        subagents.push({
          code: `${code}.${role.slot}`,
          agentCode: code,
          role: role.role,
          modelTier: role.modelTier,
          systemPrompt: buildSubagentSystemPrompt({
            code: `${code}.${role.slot}`,
            agentCode: code,
            agentSpecialty: specialty,
            divisionName: division.name,
            role,
          }),
        });
      }
    }
  }

  return { divisions, agents, subagents };
}
