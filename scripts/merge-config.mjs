import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const [existingFile, codexHome, outputFile, routerEnvFile] = process.argv.slice(2);
if (!codexHome || !outputFile || !routerEnvFile) {
  console.error('Usage: merge-config.mjs <existing-config-or-empty> <codex-home> <output> <router-env>');
  process.exit(2);
}
const routerToken = readFileSync(routerEnvFile, 'utf8').match(/^CODEX_ROUTER_TOKEN=([a-f0-9]{64})\r?$/m)?.[1];
if (!routerToken) throw new Error('Prepare router credentials before merging the Codex configuration');

const managedKeysMarker = '# BEGIN codex-unified-router managed keys';
const managedKeysEnd = '# END codex-unified-router managed keys';
const managedProviderMarker = '# BEGIN codex-unified-router provider';
const managedProviderEnd = '# END codex-unified-router provider';
const managedTopLevelKeys = new Set(['model', 'model_provider', 'model_reasoning_effort', 'model_catalog_json']);

const existing = existingFile && existsSync(existingFile) ? readFileSync(existingFile, 'utf8') : '';
const lines = existing.split(/\r?\n/);
const preserved = [];
let insideManagedKeys = false;
let insideManagedProvider = false;
let insideUnmanagedUnifiedProvider = false;
let topLevel = true;

for (const line of lines) {
  if (line.trim() === managedKeysMarker) {
    insideManagedKeys = true;
    continue;
  }
  if (line.trim() === managedKeysEnd) {
    insideManagedKeys = false;
    continue;
  }
  if (line.trim() === managedProviderMarker) {
    insideManagedProvider = true;
    continue;
  }
  if (line.trim() === managedProviderEnd) {
    insideManagedProvider = false;
    continue;
  }
  if (insideManagedKeys || insideManagedProvider) continue;

  const tableName = line.trim().match(/^\[\[?([^\]]+)\]\]?\s*(?:#.*)?$/)?.[1]?.trim();
  if (tableName) topLevel = false;
  if (tableName === 'model_providers.unified' || tableName?.startsWith('model_providers.unified.')) {
    insideUnmanagedUnifiedProvider = true;
    continue;
  }
  if (insideUnmanagedUnifiedProvider) {
    if (tableName) insideUnmanagedUnifiedProvider = false;
    else continue;
  }

  const key = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/)?.[1];
  if (topLevel && key && managedTopLevelKeys.has(key)) continue;
  preserved.push(line);
}

while (preserved.length > 0 && preserved[0].trim() === '') preserved.shift();
while (preserved.length > 0 && preserved.at(-1).trim() === '') preserved.pop();

const keys = [
  managedKeysMarker,
  'model = "gpt-6-astra"',
  'model_provider = "unified"',
  'model_reasoning_effort = "xhigh"',
  `model_catalog_json = ${JSON.stringify(`${codexHome}/models.json`)}`,
  managedKeysEnd,
];

const provider = [
  managedProviderMarker,
  '[model_providers.unified]',
  'name = "Codex Unified Router"',
  'base_url = "http://127.0.0.1:18766/v1"',
  'wire_api = "responses"',
  'requires_openai_auth = true',
  'supports_websockets = false',
  `http_headers = { "X-Codex-Router-Token" = "${routerToken}" }`,
  managedProviderEnd,
];

const sections = [keys.join('\n')];
if (preserved.length > 0) sections.push(preserved.join('\n'));
sections.push(provider.join('\n'));

writeFileSync(outputFile, `${sections.join('\n\n')}\n`, { encoding: 'utf8', mode: 0o600 });
