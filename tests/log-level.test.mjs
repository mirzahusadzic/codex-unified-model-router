import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const routerSource = fileURLToPath(new URL('../router/unified-router.mjs', import.meta.url));
const harness = `
  import http from 'node:http';
  import { pathToFileURL } from 'node:url';
  http.createServer = () => ({
    listen(_port, _host, ready) { ready(); },
    close(callback) { callback(); },
  });
  await import(pathToFileURL(process.env.ROUTER_SOURCE).href);
  await new Promise(resolve => setImmediate(resolve));
  process.exit(0);
`;

function start(level, envFile = fileURLToPath(new URL('./missing.env', import.meta.url))) {
  const env = {
    ...process.env,
    ROUTER_SOURCE: routerSource,
    CODEX_ROUTER_ENV_FILE: envFile,
    CODEX_ROUTER_TOKEN: 'a'.repeat(64),
    OPENROUTER_API_KEY: 'test-openrouter-key',
  };
  delete env.CODEX_ROUTER_PROVIDER_ORDER;
  if (level === undefined) delete env.CODEX_ROUTER_LOG_LEVEL;
  else env.CODEX_ROUTER_LOG_LEVEL = level;
  return spawnSync(process.execPath, ['--input-type=module', '--eval', harness], { encoding: 'utf8', env });
}

test('router logging defaults to errors and requires an explicit info opt-in', () => {
  const quiet = start(undefined);
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.equal(quiet.stdout, '');

  const info = start('info');
  assert.equal(info.status, 0, info.stderr);
  assert.match(info.stdout, /"event":"router\.ready"/);
});

test('router reads the log level from its environment file', t => {
  const directory = mkdtempSync(join(tmpdir(), 'router-log-level-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const envFile = join(directory, 'openrouter.env');
  writeFileSync(envFile, 'CODEX_ROUTER_LOG_LEVEL=info\n');
  const info = start(undefined, envFile);
  assert.equal(info.status, 0, info.stderr);
  assert.match(info.stdout, /"event":"router\.ready"/);
});

test('router reads endpoint preferences from its environment file and rejects malformed ones', t => {
  const directory = mkdtempSync(join(tmpdir(), 'router-provider-order-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const envFile = join(directory, 'openrouter.env');
  writeFileSync(envFile, 'CODEX_ROUTER_PROVIDER_ORDER=deepseek/deepseek-v4.1-flash-1017=deepseek\n');
  const valid = start(undefined, envFile);
  assert.equal(valid.status, 0, valid.stderr);
  writeFileSync(envFile, 'CODEX_ROUTER_PROVIDER_ORDER=google-vertex/us\n');
  const invalid = start(undefined, envFile);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /CODEX_ROUTER_PROVIDER_ORDER entries must look like model=provider/);
});

test('a corrupt session isolation record does not stop the router', t => {
  const directory = mkdtempSync(join(tmpdir(), 'router-isolation-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'session-sides.json'), '{not json');
  const result = start(undefined, join(directory, 'openrouter.env'));
  assert.equal(result.status, 0, result.stderr);
});

test('router rejects unknown log levels', () => {
  const invalid = start('verbose');
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /CODEX_ROUTER_LOG_LEVEL must be error, info, or debug/);
});
