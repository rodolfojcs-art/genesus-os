# DECISIONS.md — decisiones técnicas no cubiertas por el master prompt

Cada decisión aplica los principios de la sección 1 (innegociables).

## 1. Taxonomía 25 dominios × 4 enfoques = 100 especialidades por división
El master prompt pide 100 especialidades por división sin escribir 1,000 prompts a mano. Se definieron **25 dominios** por división (los ejemplos del prompt + extensión natural del sector) multiplicados por **4 enfoques** (I+D · Diseño e Ingeniería · Operación y Optimización · Normativa/Riesgo/Certificación). Resultado: 100 especialidades únicas, descriptivas y útiles para routing, generadas en build-time por `packages/agents/src/generator.ts`. Verificado por test (unicidad por división).

## 2. Modelos y precios (junio 2026)
Routing por defecto: `claude-opus-4-8` ($5/$25 MTok), `claude-sonnet-4-6` ($3/$15), `claude-haiku-4-5` ($1/$5), tomados de la referencia oficial de la API. Overridables por env (`GENESUS_MODEL_*`). Modelos desconocidos se tarifan al precio más caro para nunca subestimar gasto (`costs.ts`).

## 3. Registro en memoria como fuente de prompts + Supabase como persistencia
El generador es determinista, así que el server materializa la red en memoria al arrancar (lookup O(1), cero round-trips para planning) y el seed persiste el mismo registro en Supabase para la UI, RLS y auditoría. Editar un prompt desde Admin actualiza ambos.

## 4. Modo demo explícito (sin Supabase) y modo simulado (sin API key)
Para que `pnpm dev` funcione recién clonado: sin `SUPABASE_*` el server usa almacenes en memoria sembrados con los datos demo; sin `ANTHROPIC_API_KEY` **falla con error claro**, salvo `SIMULATE_LLM=1` que produce respuestas marcadas `[SIMULADO]` con costo $0. Ambos estados se reportan en `/api/health` y en Configuración — nunca se simula en silencio (principio de honestidad de conectores aplicado a toda la infraestructura).

## 5. Presupuesto: pre-chequeo pesimista + consumo atómico post-llamada
Antes de cada llamada se estima costo (prompt/4 chars por token + salida máxima) contra el restante; después se consume el costo real vía RPC `consume_budget` (atómica con `FOR UPDATE`). Si una carrera agota el límite, el gasto ya incurrido se registra y la misión pasa a `pausada_por_presupuesto`. Es imposible iniciar gasto nuevo sobre presupuesto agotado.

## 6. pg-boss opcional con fallback in-process
`DATABASE_URL` presente ⇒ cola durable pg-boss (`mission-run`). Ausente ⇒ cola in-process. La interfaz `MissionQueue` aísla la decisión; el tipo de cola se reporta en `/api/health`.

## 7. Artefactos en disco del server (v1)
Los entregables se escriben en `apps/server/artifacts/{missionId}/` y se descargan vía endpoint autenticado. La fila `artifacts` de Supabase queda definida en el esquema; migrar a Supabase Storage es un cambio local a `missions.ts` (documentado para v1.1). Motivo: cero dependencia de buckets para el flujo end-to-end local.

## 8. Parser de cuerpo tolerante en Fastify
Los POST sin cuerpo (ej. `/approve`) y content-types no estándar rompían con 415/400 del parser por defecto. Se reemplazó por un parser único que tolera cuerpo vacío y delega la validación real a los esquemas Zod de cada ruta (encontrado y corregido durante la verificación end-to-end).

## 9. Tema claro obligatorio
El skill del design system describe el suite en dark; el master prompt ordena explícitamente fondos claros (§3) y prevalece por ser la instrucción del proyecto. Tokens claros en `packages/ui/src/tokens.css`.

## 10. Directorio de agentes para planning
Pasar 1,000 agentes al prompt de GENESUS es inviable. `buildDirectory()` puntúa especialidades contra el brief (solapamiento de términos, stopwords ES) y entrega los ~36 más relevantes + cobertura mínima de las 10 divisiones. Zod valida que cada `department_id` del plan exista.

## 11. Realtime v1 = polling
El progreso de misión se consulta cada 2.5 s desde la UI (suficiente y simple). El esquema ya persiste misiones/tareas en Supabase, por lo que activar Realtime es suscribirse a esas tablas (v1.1); el evento de dominio `MissionEvent` ya existe en el core.

## 12. WhatsApp (Evolution API) diferido a v1.1
El webhook saliente n8n (misión completada/fallida/pausada) está implementado y probado (`/api/config/webhook-test`). La notificación WhatsApp se hace en n8n a partir de ese webhook — mantener la integración en n8n evita acoplar el server a Evolution API.
