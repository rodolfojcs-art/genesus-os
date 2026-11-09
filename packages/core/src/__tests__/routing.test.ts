import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL_BY_TIER,
  RoutingViolationError,
  assertTierAllowed,
  resolveModel,
  tierForRole,
} from '../routing.js';

describe('routing de tres modelos', () => {
  it('mapea cada tier a su modelo por defecto', () => {
    expect(DEFAULT_MODEL_BY_TIER.opus).toBe('claude-opus-4-8');
    expect(DEFAULT_MODEL_BY_TIER.sonnet).toBe('claude-sonnet-4-6');
    expect(DEFAULT_MODEL_BY_TIER.haiku).toBe('claude-haiku-4-5');
  });

  it('respeta overrides de entorno', () => {
    expect(resolveModel('opus', { opus: 'claude-opus-4-7' })).toBe('claude-opus-4-7');
    expect(resolveModel('haiku', { opus: 'claude-opus-4-7' })).toBe('claude-haiku-4-5');
  });

  it('GENESUS raíz usa opus, departamentos sonnet', () => {
    expect(tierForRole('root')).toBe('opus');
    expect(tierForRole('department')).toBe('sonnet');
  });

  it('subagentes 2 y 4 usan sonnet, el resto haiku', () => {
    const tiers = Array.from({ length: 10 }, (_, i) => tierForRole('subagent', i + 1));
    expect(tiers).toEqual([
      'haiku',
      'sonnet',
      'haiku',
      'sonnet',
      'haiku',
      'haiku',
      'haiku',
      'haiku',
      'haiku',
      'haiku',
    ]);
  });

  it('prohíbe opus para departamentos y subagentes', () => {
    expect(() => assertTierAllowed('department', 'opus')).toThrow(RoutingViolationError);
    expect(() => assertTierAllowed('subagent', 'opus')).toThrow(RoutingViolationError);
    expect(() => assertTierAllowed('root', 'opus')).not.toThrow();
    expect(() => assertTierAllowed('root', 'haiku')).toThrow(RoutingViolationError);
  });
});
