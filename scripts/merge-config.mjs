import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hasManagedKeysMarker, logicalLines, managedKeysMarker } from './toml-lines.mjs';

const [existingFile, codexHome, outputFile, routerEnvFile, openrouterProfileFile, force] = process.argv.slice(2);
if (!codexHome || !outputFile || !routerEnvFile || (force !== undefined && force !== '--force')) {
  console.error('Usage: merge-config.mjs <existing-config-or-empty> <codex-home> <output> <router-env> [openrouter-profile-output] [--force]');
  process.exit(2);
}
const routerToken = readFileSync(routerEnvFile, 'utf8').match(/^CODEX_ROUTER_TOKEN=([a-f0-9]{64})\r?$/m)?.[1];
if (!routerToken) throw new Error('Prepare router credentials before merging the Codex configuration');

const managedKeysEnd = '# END codex-unified-router managed keys';
const managedProviderMarker = '# BEGIN codex-unified-router provider';
const managedProviderEnd = '# END codex-unified-router provider';
const tableMarker = (table, edge) => `# ${edge} codex-unified-router ${table.name}`;

// Entries the router manages inside user tables. `lines: null` removes an
// earlier managed block and leaves the setting to the user.
//
// ChatGPT apps add tens of thousands of connector-tool tokens to every
// request, including OpenRouter requests. Set CODEX_ROUTER_DISABLE_APPS=0 to
// leave Codex's own apps setting untouched.
const disableAppsSetting = process.env.CODEX_ROUTER_DISABLE_APPS ?? '1';
if (!['0', '1'].includes(disableAppsSetting)) throw new Error('CODEX_ROUTER_DISABLE_APPS must be 0 or 1');
// Ultra Spark fans work out to parallel workers; raise Codex's spawned-agent
// limit. Set CODEX_ROUTER_AGENT_THREADS=0 to leave the limit to Codex.
// Codex sends usage analytics and metrics to OpenAI by default. Set
// CODEX_ROUTER_DISABLE_ANALYTICS=0 to leave Codex's analytics setting alone.
const disableAnalyticsSetting = process.env.CODEX_ROUTER_DISABLE_ANALYTICS ?? '1';
if (!['0', '1'].includes(disableAnalyticsSetting)) throw new Error('CODEX_ROUTER_DISABLE_ANALYTICS must be 0 or 1');
const agentThreadsSetting = process.env.CODEX_ROUTER_AGENT_THREADS ?? '10';
if (!/^(0|[1-9][0-9]{0,2})$/.test(agentThreadsSetting)) {
  throw new Error('CODEX_ROUTER_AGENT_THREADS must be 0 or a whole number from 1 to 999');
}
const managedTables = [
  {
    name: 'features',
    lines: disableAppsSetting === '1' ? ['apps = false'] : null,
    ownedKeys: ['apps'],
    optOut: 'CODEX_ROUTER_DISABLE_APPS=0',
  },
  {
    name: 'analytics',
    lines: disableAnalyticsSetting === '1' ? ['enabled = false'] : null,
    ownedKeys: ['enabled'],
    optOut: 'CODEX_ROUTER_DISABLE_ANALYTICS=0',
  },
  {
    name: 'agents',
    lines: agentThreadsSetting === '0' ? null : [`max_concurrent_threads_per_session = ${agentThreadsSetting}`],
    // max_threads is Codex's legacy alias for the same limit.
    ownedKeys: ['max_concurrent_threads_per_session', 'max_threads'],
    optOut: 'CODEX_ROUTER_AGENT_THREADS=0',
  },
];
function readExisting(path) {
  return path && existsSync(path) ? readFileSync(path, 'utf8') : '';
}

const profilePath = join(codexHome, 'unified-openrouter.config.toml');
const existingProfile = openrouterProfileFile ? readExisting(profilePath) : '';
if (openrouterProfileFile && existsSync(profilePath) && force !== '--force'
    && !hasManagedKeysMarker(existingProfile)) {
  throw new Error('Existing unmanaged unified-openrouter profile; rerun the installer with --force (Windows: -Force) to merge it');
}

function merge(existing, ownedKeys, keys, provider, tables = []) {
  const preserved = [];
  let insideManagedKeys = false;
  let insideManagedProvider = false;
  let insideUnmanagedUnifiedProvider = false;
  let currentTable = null;
  let topLevel = true;
  const state = new Map(tables.map(table => [table, { inside: false, header: false, placed: false }]));
  // Keys written below the last router-created table header belong to it.
  let orphanedTable = null;
  const block = (table, ...header) => [tableMarker(table, 'BEGIN'), ...header, ...table.lines, tableMarker(table, 'END')];
  for (const line of logicalLines(existing)) {
    const trimmed = line.trim();
    const beginning = tables.find(table => trimmed === tableMarker(table, 'BEGIN'));
    if (beginning) {
      Object.assign(state.get(beginning), { inside: true, header: false });
      orphanedTable = null;
      continue;
    }
    const ending = tables.find(table => trimmed === tableMarker(table, 'END'));
    if (ending) {
      state.get(ending).inside = false;
      orphanedTable = state.get(ending).header ? ending : null;
      continue;
    }
    const within = tables.find(table => state.get(table).inside);
    if (within) {
      if (trimmed === `[${within.name}]`) state.get(within).header = true;
      continue;
    }
    if (orphanedTable && trimmed !== '' && !trimmed.startsWith('#')) {
      const orphan = orphanedTable;
      const managed = state.get(orphan);
      orphanedTable = null;
      if (!trimmed.startsWith('[')) {
        preserved.push(`[${orphan.name}]`);
        if (orphan.lines && !managed.placed) preserved.push(...block(orphan));
        managed.placed ||= Boolean(orphan.lines);
        currentTable = orphan.name;
        topLevel = false;
      }
    }
    if (trimmed === managedKeysMarker) {
      insideManagedKeys = true;
      continue;
    }
    if (trimmed === managedKeysEnd) {
      insideManagedKeys = false;
      continue;
    }
    if (trimmed === managedProviderMarker) {
      insideManagedProvider = true;
      continue;
    }
    if (trimmed === managedProviderEnd) {
      insideManagedProvider = false;
      continue;
    }
    if (insideManagedKeys || insideManagedProvider) continue;

    const tableName = trimmed.match(/^\[\[?([^\]]+)\]\]?\s*(?:#.*)?$/)?.[1]?.trim();
    if (tableName) topLevel = false;
    if (tableName === 'model_providers.unified' || tableName?.startsWith('model_providers.unified.')) {
      insideUnmanagedUnifiedProvider = true;
      continue;
    }
    if (insideUnmanagedUnifiedProvider) {
      if (tableName) insideUnmanagedUnifiedProvider = false;
      else continue;
    }
    if (tableName) currentTable = tableName;
    const dotted = tables.find(table => table.lines && topLevel && new RegExp(`^\\s*${table.name}\\s*[.=]`).test(line));
    if (dotted) {
      throw new Error(`Move top-level ${dotted.name} settings into a [${dotted.name}] table, or set ${dotted.optOut}`);
    }
    const opened = tables.find(table => table.lines && tableName === table.name && !state.get(table).placed);
    if (opened) {
      preserved.push(line, ...block(opened));
      state.get(opened).placed = true;
      continue;
    }

    const key = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/)?.[1];
    if (topLevel && key && ownedKeys.includes(key)) continue;
    const owner = tables.find(table => table.lines && table.name === currentTable);
    if (owner && key && owner.ownedKeys.includes(key)) continue;
    preserved.push(line);
  }
  if (insideManagedKeys || insideManagedProvider || tables.some(table => state.get(table).inside)) {
    throw new Error('Unterminated managed configuration block; repair it before merging');
  }
  while (preserved.length > 0 && preserved[0].trim() === '') preserved.shift();
  while (preserved.length > 0 && preserved.at(-1).trim() === '') preserved.pop();
  return [
    [managedKeysMarker, ...keys, managedKeysEnd].join('\n'),
    preserved.join('\n'),
    ...tables.filter(table => table.lines && !state.get(table).placed)
      .map(table => block(table, `[${table.name}]`).join('\n')),
    [managedProviderMarker, ...provider, managedProviderEnd].join('\n'),
  ].filter(Boolean).join('\n\n') + '\n';
}

const keys = [
  'model = "deepseek/deepseek-v4.1-flash-1017"',
  'model_provider = "unified"',
  'model_reasoning_effort = "xhigh"',
  `model_catalog_json = ${JSON.stringify(`${codexHome}/models.json`)}`,
];

const provider = [
  '[model_providers.unified]',
  'name = "Codex Unified Router"',
  'base_url = "http://127.0.0.1:18766/v1"',
  'wire_api = "responses"',
  'requires_openai_auth = true',
  'supports_websockets = false',
  `http_headers = { "X-Codex-Router-Token" = "${routerToken}" }`,
];

const main = merge(readExisting(existingFile), ['model', 'model_provider', 'model_reasoning_effort', 'model_catalog_json'], keys, provider, managedTables);
const profile = openrouterProfileFile ? merge(existingProfile, ['model_provider', 'model_catalog_json'], [
  'model_provider = "unified"',
  `model_catalog_json = ${JSON.stringify(`${codexHome}/models.json`)}`,
], provider.map(line => line === 'requires_openai_auth = true' ? 'requires_openai_auth = false'
  : line.startsWith('http_headers =')
    ? `http_headers = { "X-Codex-Router-Token" = "${routerToken}", "X-Codex-Routing-Policy" = "preserve-model-v1" }`
    : line)) : null;
writeFileSync(outputFile, main, { encoding: 'utf8', mode: 0o600 });
if (profile !== null) writeFileSync(openrouterProfileFile, profile, { encoding: 'utf8', mode: 0o600 });
