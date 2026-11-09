import { describe, expect, it } from 'vitest';
import { estimateCostUsd, priceFor } from '../costs.js';

describe('estimación de costos', () => {
  it('calcula el costo exacto por modelo', () => {
    // 1M tokens de entrada en Opus = $5
    expect(estimateCostUsd('claude-opus-4-8', 1_000_000, 0)).toBe(5);
    // 1M de salida en Sonnet = $15
    expect(estimateCostUsd('claude-sonnet-4-6', 0, 1_000_000)).toBe(15);
    // Mixto en Haiku: 200k in + 100k out = 0.2*1 + 0.1*5 = $0.7
    expect(estimateCostUsd('claude-haiku-4-5', 200_000, 100_000)).toBeCloseTo(0.7, 6);
  });

  it('usa fallback por familia para snapshots con fecha', () => {
    expect(priceFor('claude-haiku-4-5-20251001').inputPerMtok).toBe(1);
    expect(priceFor('claude-sonnet-4-6-extra').outputPerMtok).toBe(15);
  });

  it('asume el precio más caro para modelos desconocidos (no subestimar)', () => {
    expect(priceFor('modelo-misterioso').inputPerMtok).toBe(5);
  });
});
