// Empaqueta el servidor en un único archivo CJS para la app de escritorio.
// Lo ejecuta el Node integrado de Electron (sin Node del sistema).
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'apps/server/dist-bundle');
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [resolve(root, 'apps/server/src/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: resolve(root, 'apps/server/dist-bundle/server.cjs'),
  // pg-boss opcional (solo con DATABASE_URL). bufferutil/utf-8-validate son
  // aceleradores nativos opcionales de ws (con fallback JS si faltan).
  external: ['pg-boss', 'bufferutil', 'utf-8-validate'],
  logLevel: 'info',
  banner: { js: '/* GENESUS OS — server bundle */' },
});

// Incluir la config (.env) para que la app instalada encuentre las llaves.
const envSrc = resolve(root, 'apps/server/.env');
if (existsSync(envSrc)) {
  copyFileSync(envSrc, resolve(outDir, '.env'));
  console.log('.env incluido en el bundle (uso personal).');
}

console.log('Server bundleado en apps/server/dist-bundle/server.cjs');
