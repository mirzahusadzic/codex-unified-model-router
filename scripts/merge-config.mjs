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
const managedFeaturesMarker = '# BEGIN codex-unified-router features';
const managedFeaturesEnd = '# END codex-unified-router features';

// ChatGPT apps add tens of thousands of connector-tool tokens to every
// request, including OpenRouter requests. Set CODEX_ROUTER_DISABLE_APPS=0 to
// leave Codex's own apps setting untouched.
const disableAppsSetting = process.env.CODEX_ROUTER_DISABLE_APPS ?? '1';
if (!['0', '1'].includes(disableAppsSetting)) throw new Error('CODEX_ROUTER_DISABLE_APPS must be 0 or 1');
const managedFeatures = disableAppsSetting === '1' ? ['apps = false'] : null;
function readExisting(path) {
  return path && existsSync(path) ? readFileSync(path, 'utf8') : '';
}

const profilePath = join(codexHome, 'unified-openrouter.config.toml');
const existingProfile = openrouterProfileFile ? readExisting(profilePath) : '';
if (openrouterProfileFile && existsSync(profilePath) && force !== '--force'
    && !hasManagedKeysMarker(existingProfile)) {
  throw new Error('Existing unmanaged unified-openrouter profile; rerun the installer with --force (Windows: -Force) to merge it');
}

function merge(existing, ownedKeys, keys, provider, features = null) {
  const preserved = [];
  let insideManagedKeys = false;
  let insideManagedProvider = false;
  let insideManagedFeatures = false;
  let insideUnmanagedUnifiedProvider = false;
  let insideFeatures = false;
  let featuresPlaced = false;
  let managedFeaturesHeader = false;
  let orphanedFeatures = false;
  let topLevel = true;
  for (const line of logicalLines(existing)) {
    if (line.trim() === managedFeaturesMarker) {
      insideManagedFeatures = true;
      managedFeaturesHeader = false;
      continue;
    }
    if (line.trim() === managedFeaturesEnd) {
      insideManagedFeatures = false;
      // Keys added below a router-created [features] header still need it.
      orphanedFeatures = managedFeaturesHeader;
      continue;
    }
    if (insideManagedFeatures) {
      if (line.trim() === '[features]') managedFeaturesHeader = true;
      continue;
    }
    if (orphanedFeatures && line.trim() !== '' && !line.trim().startsWith('#')) {
      orphanedFeatures = false;
      if (!line.trim().startsWith('[')) {
        preserved.push('[features]');
        if (features && !featuresPlaced) preserved.push(managedFeaturesMarker, ...features, managedFeaturesEnd);
        featuresPlaced ||= Boolean(features);
        insideFeatures = true;
        topLevel = false;
      }
    }
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
    if (tableName) insideFeatures = tableName === 'features';
    if (features && topLevel && /^\s*features\s*[.=]/.test(line)) {
      throw new Error('Move top-level features settings into a [features] table, or set CODEX_ROUTER_DISABLE_APPS=0');
    }
    if (features && tableName === 'features' && !featuresPlaced) {
      preserved.push(line, managedFeaturesMarker, ...features, managedFeaturesEnd);
      featuresPlaced = true;
      continue;
    }

    const key = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/)?.[1];
    if (topLevel && key && ownedKeys.includes(key)) continue;
    if (features && insideFeatures && key === 'apps') continue;
    preserved.push(line);
  }
  if (insideManagedKeys || insideManagedProvider || insideManagedFeatures) {
    throw new Error('Unterminated managed configuration block; repair it before merging');
  }
  while (preserved.length > 0 && preserved[0].trim() === '') preserved.shift();
  while (preserved.length > 0 && preserved.at(-1).trim() === '') preserved.pop();
  return [
    [managedKeysMarker, ...keys, managedKeysEnd].join('\n'),
    preserved.join('\n'),
    features && !featuresPlaced
      ? [managedFeaturesMarker, '[features]', ...features, managedFeaturesEnd].join('\n')
      : '',
    [managedProviderMarker, ...provider, managedProviderEnd].join('\n'),
  ].filter(Boolean).join('\n\n') + '\n';
}

const keys = [
  'model = "gpt-6-astra"',
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

const main = merge(readExisting(existingFile), ['model', 'model_provider', 'model_reasoning_effort', 'model_catalog_json'], keys, provider, managedFeatures);
const profile = openrouterProfileFile ? merge(existingProfile, ['model_provider', 'model_catalog_json'], [
  'model_provider = "unified"',
  `model_catalog_json = ${JSON.stringify(`${codexHome}/models.json`)}`,
], provider.map(line => line === 'requires_openai_auth = true' ? 'requires_openai_auth = false'
  : line.startsWith('http_headers =')
    ? `http_headers = { "X-Codex-Router-Token" = "${routerToken}", "X-Codex-Routing-Policy" = "preserve-model-v1" }`
    : line)) : null;
writeFileSync(outputFile, main, { encoding: 'utf8', mode: 0o600 });
if (profile !== null) writeFileSync(openrouterProfileFile, profile, { encoding: 'utf8', mode: 0o600 });
