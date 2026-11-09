# COSTOS.md — Unit economics por misión

Precios vigentes (USD por millón de tokens, junio 2026):

| Modelo | Rol en la red | Input | Output |
|---|---|---:|---:|
| claude-opus-4-8 | GENESUS (planning + síntesis) | $5.00 | $25.00 |
| claude-sonnet-4-6 | Agentes departamentales | $3.00 | $15.00 |
| claude-haiku-4-5 | Subagentes / QA | $1.00 | $5.00 |

Toda llamada queda en la tabla `runs` (modelo, tokens in/out, costo, latencia). El dashboard Finanzas agrega por modelo y día; `consume_budget` corta en seco al llegar al límite diario.

## Modelo de costo por misión

Una misión de N tareas ejecuta:

| Componente | Modelo | Llamadas | Tokens típicos (in/out) | Costo |
|---|---|---|---|---:|
| Planning | Opus | 1 | 2,500 / 900 | $0.035 |
| Ejecución por tarea | Sonnet | N | 1,800 / 1,400 c/u | $0.0264 × N |
| QA por tarea | Haiku | N (+reintentos) | 1,600 / 250 c/u | $0.0029 × N |
| Reintento QA (≈20% de tareas) | Sonnet+Haiku | 0.2 × N | — | $0.0059 × N |
| Síntesis | Opus | 1 | 4,500 / 1,800 | $0.0675 |

**Fórmula:** `costo ≈ 0.103 + 0.035 × N` (USD)

| Misión | Tareas | Costo estimado |
|---|---:|---:|
| Análisis simple (1 división) | 3 | **$0.21** |
| Informe de viabilidad multi-departamento (demo) | 6 | **$0.31** |
| Producto completo: specs + BOM + proveedores + GTM + finanzas | 12 | **$0.52** |

Con el presupuesto default de $25/día caben ~80 misiones medianas diarias.

## Medición real registrada

| Corrida | Modo | Tareas | Costo medido |
|---|---|---:|---:|
| “Informe de viabilidad microturbina 5 kW” (2026-06-11) | `SIMULATE_LLM=1` | 1 | $0.0000 (simulado, marcado) |
| Pendiente: misma misión con API real | producción | ~6 | por medir — quedará en `runs` |

> Acción al primer deploy con API key real: ejecutar la misión demo, anotar aquí el costo real desde Finanzas (o `select sum(cost_usd) from runs where created_at::date = current_date`) y recalibrar la fórmula si la desviación supera ±25%.

## Palancas de optimización (en orden de impacto)

1. **Routing estricto** (ya implementado y testeado): QA/validación jamás en Sonnet; producción jamás en Opus.
2. **`MAX_CONCURRENT_AGENTS`** controla el burst, no el costo total — el costo lo gobierna el tamaño del plan (3–12 tareas validado por Zod).
3. **Reintentos acotados** (máx 2 por tarea) con feedback específico: el segundo intento converge más barato que regenerar desde cero.
4. **Prompt caching** (v1.1): el system prompt de cada agente es estable por diseño → cachear el prefijo reduciría el input de ejecución ~40%.
5. **Auto-aprobación** (`AUTO_APPROVE_UNDER_USD`) solo para misiones de bajo costo; el plan siempre muestra el estimado antes de ejecutar.
