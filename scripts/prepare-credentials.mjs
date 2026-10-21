import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const [file, ...options] = process.argv.slice(2);
const validOptions = options.length === 0
  || (options[0] === '--api-key-file' && options.length === 2 && options[1])
  || (options[0] === '--api-key-stdin' && options.length === 1);
if (!file || !validOptions) {
  throw new Error('Usage: prepare-credentials.mjs <router-env-file> [--api-key-file <path> | --api-key-stdin]');
}

// A key from a file or stdin takes precedence over OPENROUTER_API_KEY, since
// environment variables can leak to other processes; the stored key comes last.
function suppliedKey() {
  if (options[0] === '--api-key-file') return readFileSync(options[1], 'utf8').trim();
  if (options[0] === '--api-key-stdin') return readFileSync(0, 'utf8').trim();
  return '';
}

// The installers restrict the containing directory and Windows ACLs before this runs.
const managedKeys = ['OPENROUTER_API_KEY', 'CODEX_ROUTER_TOKEN'];
const values = {};
// Other settings, such as CODEX_ROUTER_LOG_LEVEL, survive reinstallation.
const preserved = [];
if (existsSync(file)) {
  if (process.platform !== 'win32') chmodSync(file, 0o600);
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    if (!managedKeys.includes(match[1])) {
      preserved.push(line.trim());
      continue;
    }
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
}
const key = suppliedKey() || process.env.OPENROUTER_API_KEY || values.OPENROUTER_API_KEY;
if (!key || /[\r\n]/.test(key)) throw new Error('A nonempty, single-line OpenRouter API key is required');
const token = /^[a-f0-9]{64}$/.test(values.CODEX_ROUTER_TOKEN || '')
  ? values.CODEX_ROUTER_TOKEN : randomBytes(32).toString('hex');
const lines = [`OPENROUTER_API_KEY=${key}`, `CODEX_ROUTER_TOKEN=${token}`, ...preserved];
writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
