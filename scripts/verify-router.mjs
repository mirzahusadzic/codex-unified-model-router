// Checks that the installed router is this repository's: every module is in
// place beside the entry, and the entry and modules hash the same as here.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { routerRevision } from '../router/common.mjs';

const [codexHome] = process.argv.slice(2);
if (!codexHome) throw new Error('Usage: verify-router.mjs <codex-home>');
const sourceDir = fileURLToPath(new URL('../router/', import.meta.url));
const installedDir = join(codexHome, 'unified-router');
for (const name of readdirSync(sourceDir).filter(file => file.endsWith('.mjs') && file !== 'unified-router.mjs').sort()) {
  if (!existsSync(join(installedDir, name))) throw new Error(`Missing router module: ${join(installedDir, name)}; rerun the installer`);
}
if (routerRevision(join(installedDir, 'router.mjs')) !== routerRevision(join(sourceDir, 'unified-router.mjs'))) {
  throw new Error('The installed router differs from this repository; rerun the installer');
}
