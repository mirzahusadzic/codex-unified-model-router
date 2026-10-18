import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const [file] = process.argv.slice(2);
if (!file) throw new Error('Usage: prepare-credentials.mjs <router-env-file>');

// The installers restrict the containing directory and Windows ACLs before this runs.
const values = {};
if (existsSync(file)) {
  if (process.platform !== 'win32') chmodSync(file, 0o600);
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Z_]+)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
}
const key = process.env.OPENROUTER_API_KEY || values.OPENROUTER_API_KEY;
if (!key || /[\r\n]/.test(key)) throw new Error('A nonempty, single-line OPENROUTER_API_KEY is required');
const token = /^[a-f0-9]{64}$/.test(values.CODEX_ROUTER_TOKEN || '')
  ? values.CODEX_ROUTER_TOKEN : randomBytes(32).toString('hex');
writeFileSync(file, `OPENROUTER_API_KEY=${key}\nCODEX_ROUTER_TOKEN=${token}\n`, { mode: 0o600 });
