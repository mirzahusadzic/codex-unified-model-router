// The router's settings: environment file, keys, local token, logging, and
// private state files.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const host = '127.0.0.1';
export const port = Number(process.env.CODEX_ROUTER_PORT || 18766);
export const envFile = process.env.CODEX_ROUTER_ENV_FILE || join(homedir(), '.codex', 'unified-router', 'openrouter.env');
export const modelCatalogFile = process.env.CODEX_MODEL_CATALOG || join(homedir(), '.codex', 'models.json');

function readEnvironmentFile(file) {
  if (!existsSync(file)) return {};
  const values = {};
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export const fileEnvironment = readEnvironmentFile(envFile);
export const logLevels = { error: 0, info: 1, debug: 2 };
export const configuredLogLevel = String(
  process.env.CODEX_ROUTER_LOG_LEVEL || fileEnvironment.CODEX_ROUTER_LOG_LEVEL || 'error',
).trim().toLowerCase();
if (!Object.hasOwn(logLevels, configuredLogLevel)) {
  throw new Error('CODEX_ROUTER_LOG_LEVEL must be error, info, or debug');
}
export const openrouterApiKey = process.env.OPENROUTER_API_KEY || fileEnvironment.OPENROUTER_API_KEY || '';
// Claude runs on Anthropic's API only with an API key. Anthropic does
// not allow subscription sign-in tokens in other tools, so one is ignored.
export const anthropicApiKey = (() => {
  const key = process.env.ANTHROPIC_API_KEY || fileEnvironment.ANTHROPIC_API_KEY || '';
  if (!key.startsWith('sk-ant-oat')) return key;
  logEvent('error', 'anthropic.sign_in_token_ignored');
  return '';
})();
export const routerToken = process.env.CODEX_ROUTER_TOKEN || fileEnvironment.CODEX_ROUTER_TOKEN || '';
export const rejectedRequestDir = String(
  process.env.CODEX_ROUTER_REJECTED_REQUEST_DIR
    || fileEnvironment.CODEX_ROUTER_REJECTED_REQUEST_DIR
    || '',
).trim();
if (!/^[a-f0-9]{64}$/.test(routerToken)) {
  throw new Error('A 64-character hex CODEX_ROUTER_TOKEN is required; rerun the installer');
}

// Optional OpenRouter endpoint preferences, for example
// `deepseek/deepseek-v4.1-flash-1017=deepseek`. Separate models with `;`.
function parseProviderOrders(value) {
  const orders = new Map();
  for (const entry of value.split(';').map(part => part.trim()).filter(Boolean)) {
    const match = entry.match(/^([^=\s]+)\s*=\s*(.+)$/);
    const providers = match?.[2].split(',').map(provider => provider.trim()).filter(Boolean) || [];
    if (!match || providers.length === 0 || providers.some(provider => /\s/.test(provider))) {
      throw new Error('CODEX_ROUTER_PROVIDER_ORDER entries must look like model=provider[,provider]');
    }
    orders.set(match[1], providers);
  }
  return orders;
}
export const providerOrders = parseProviderOrders(String(
  process.env.CODEX_ROUTER_PROVIDER_ORDER || fileEnvironment.CODEX_ROUTER_PROVIDER_ORDER || '',
));

// Private state survives restarts through an atomic rename, so a crash never
// leaves a half-written file. A failed write is logged and the router keeps
// working from memory.
export function persistJson(file, value, failureEvent) {
  try {
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    renameSync(temporary, file);
  } catch (error) {
    logEvent('error', failureEvent, { errorCode: error.code || null });
  }
}

export function logEvent(level, event, fields = {}) {
  if (logLevels[level] > logLevels[configuredLogLevel]) return;
  const record = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...fields,
  };
  const line = JSON.stringify(record);
  if (level === 'error') console.error(line);
  else console.log(line);
}
