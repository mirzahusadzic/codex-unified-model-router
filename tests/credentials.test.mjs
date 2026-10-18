import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'router-credentials-'));
  mkdirSync(join(home, 'unified-router'), { mode: 0o700 });
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { home, envFile: join(home, 'unified-router', 'openrouter.env'), config: join(home, 'config.toml') };
}
function run(script, args, key = '') {
  return spawnSync(process.execPath, [join(root, script), ...args], {
    encoding: 'utf8', env: { ...process.env, OPENROUTER_API_KEY: key, CODEX_ROUTER_TOKEN: '' },
  });
}
function succeeds(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '', 'credentials must not be printed');
}

test('installation generates a private token and preserves it when the API key changes', t => {
  const { envFile } = fixture(t);
  succeeds(run('scripts/prepare-credentials.mjs', [envFile], 'synthetic-first-key'));
  const first = readFileSync(envFile, 'utf8');
  const token = first.match(/^CODEX_ROUTER_TOKEN=([a-f0-9]{64})$/m)?.[1];
  assert.ok(token);
  if (process.platform !== 'win32') {
    assert.equal(statSync(envFile).mode & 0o777, 0o600);
    chmodSync(envFile, 0o644);
  }
  succeeds(run('scripts/prepare-credentials.mjs', [envFile], 'synthetic-second-key'));
  assert.equal(readFileSync(envFile, 'utf8'), `OPENROUTER_API_KEY=synthetic-second-key\nCODEX_ROUTER_TOKEN=${token}\n`);
  succeeds(run('scripts/prepare-credentials.mjs', [envFile]));
  if (process.platform !== 'win32') assert.equal(statSync(envFile).mode & 0o777, 0o600);
});

test('upgrades an existing quoted key without requiring it in the environment', t => {
  const { envFile } = fixture(t);
  writeFileSync(envFile, "# existing install\nOPENROUTER_API_KEY='synthetic-stored-key'\n");
  succeeds(run('scripts/prepare-credentials.mjs', [envFile]));
  assert.match(readFileSync(envFile, 'utf8'), /^OPENROUTER_API_KEY=synthetic-stored-key\nCODEX_ROUTER_TOKEN=[a-f0-9]{64}\n$/);
});

test('rejects missing credentials and environment-file injection without exposing the key', t => {
  const { envFile } = fixture(t);
  for (const key of ['', 'synthetic-secret\nCODEX_ROUTER_TOKEN=injected']) {
    const result = run('scripts/prepare-credentials.mjs', [envFile], key);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout + result.stderr, /synthetic-secret|injected/);
  }
});

test('config upgrades preserve unrelated tables and synchronize the local token', t => {
  const { home, envFile, config } = fixture(t);
  succeeds(run('scripts/prepare-credentials.mjs', [envFile], 'synthetic-key'));
  const unrelated = '[profiles.review] # keep this profile\nmodel = "review-model"\nmodel_provider = "other"';
  writeFileSync(config, 'model = "old-model"\n[model_providers.unified] # old provider\nname = "old"\n'
    + '[model_providers.unified.http_headers]\nOld-Token = "old"\n' + unrelated + '\n', { mode: 0o600 });
  succeeds(run('scripts/merge-config.mjs', [config, home, config, envFile]));
  const first = readFileSync(config, 'utf8');
  assert.ok(first.includes(unrelated));
  assert.doesNotMatch(first, /old-model|Old-Token|name = "old"/);
  succeeds(run('scripts/verify-credentials.mjs', [home]));
  succeeds(run('scripts/merge-config.mjs', [config, home, config, envFile]));
  assert.equal(readFileSync(config, 'utf8'), first);
  writeFileSync(config, first.replace(/X-Codex-Router-Token" = "[a-f0-9]+/, 'X-Codex-Router-Token" = "wrong'));
  assert.notEqual(run('scripts/verify-credentials.mjs', [home]).status, 0);
});

test('router refuses to start without a local authentication token', t => {
  const { envFile } = fixture(t);
  const result = spawnSync(process.execPath, [join(root, 'router/unified-router.mjs')], {
    encoding: 'utf8', timeout: 3000,
    env: { ...process.env, CODEX_ROUTER_ENV_FILE: envFile, CODEX_ROUTER_TOKEN: '', OPENROUTER_API_KEY: 'synthetic-key' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /CODEX_ROUTER_TOKEN is required/);
});
