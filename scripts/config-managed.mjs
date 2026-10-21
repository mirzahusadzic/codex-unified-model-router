import { existsSync, readFileSync } from 'node:fs';
import { hasManagedKeysMarker } from './toml-lines.mjs';

// Exit 0 when the file has a real managed-keys marker line, 1 otherwise.
const [file] = process.argv.slice(2);
if (!file) {
  console.error('Usage: config-managed.mjs <config-file>');
  process.exit(2);
}
process.exit(existsSync(file) && hasManagedKeysMarker(readFileSync(file, 'utf8')) ? 0 : 1);
