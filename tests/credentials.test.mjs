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

test('reinstallation keeps router settings stored beside the credentials', t => {
  const { envFile } = fixture(t);
  writeFileSync(envFile, 'OPENROUTER_API_KEY=synthetic-stored-key\nCODEX_ROUTER_LOG_LEVEL=info\n'
    + 'CODEX_ROUTER_REJECTED_REQUEST_DIR=/private/captures\n');
  succeeds(run('scripts/prepare-credentials.mjs', [envFile], 'synthetic-new-key'));
  assert.match(readFileSync(envFile, 'utf8'), new RegExp('^OPENROUTER_API_KEY=synthetic-new-key\\n'
    + 'CODEX_ROUTER_TOKEN=[a-f0-9]{64}\\nCODEX_ROUTER_LOG_LEVEL=info\\n'
    + 'CODEX_ROUTER_REJECTED_REQUEST_DIR=/private/captures\\n$'));
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
  const profile = join(home, 'unified-openrouter.config.toml');
  succeeds(run('scripts/merge-config.mjs', [config, home, config, envFile, profile]));
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

test('OpenRouter-only profile supplies transport and strict routing without changing mixed-provider defaults', t => {
  const { home, envFile, config } = fixture(t);
  succeeds(run('scripts/prepare-credentials.mjs', [envFile], 'synthetic-key'));
  const profile = join(home, 'unified-openrouter.config.toml');
  writeFileSync(config, 'developer_instructions = "private ambient instructions"\n');
  succeeds(run('scripts/merge-config.mjs', [config, home, config, envFile, profile]));
  const text = readFileSync(profile, 'utf8');
  assert.match(text, /requires_openai_auth = false/);
  assert.match(text, /X-Codex-Routing-Policy" = "preserve-model-v1"/);
  assert.doesNotMatch(text, /ambient|developer_instructions|synthetic-key/);
  const mixed = readFileSync(config, 'utf8');
  assert.match(mixed, /requires_openai_auth = true/);
  assert.match(mixed, /private ambient instructions/);
  assert.doesNotMatch(mixed, /X-Codex-Routing-Policy/);
  const token = readFileSync(envFile, 'utf8').match(/^CODEX_ROUTER_TOKEN=(.+)$/m)[1];
  assert.ok(text.includes(token));
  if (process.platform !== 'win32') assert.equal(statSync(profile).mode & 0o777, 0o600);
});

test('unmanaged profile collisions refuse both writes; explicit conversion preserves unrelated settings', t => {
  const { home, envFile, config } = fixture(t);
  succeeds(run('scripts/prepare-credentials.mjs', [envFile], 'synthetic-key'));
  const profile = join(home, 'unified-openrouter.config.toml');
  const main = 'developer_instructions = "keep main instructions"\n';
  const unrelated = 'model = "deepseek/custom"\nmodel_reasoning_effort = "high"\n'
    + 'developer_instructions = "keep profile instructions"\n[features]\nshell_tool = false\n';
  const original = 'model_provider = "old"\n' + unrelated + '[model_providers.unified]\nname = "old"\n';
  writeFileSync(config, main, { mode: 0o600 });
  writeFileSync(profile, original, { mode: 0o600 });
  const args = [config, home, config, envFile, profile];
  assert.notEqual(run('scripts/merge-config.mjs', args).status, 0);
  assert.equal(readFileSync(profile, 'utf8'), original);
  assert.equal(readFileSync(config, 'utf8'), main);
  succeeds(run('scripts/merge-config.mjs', [...args, '--force']));
  const first = readFileSync(profile, 'utf8');
  assert.ok(first.includes(unrelated));
  assert.doesNotMatch(first, /"old"/);
  succeeds(run('scripts/merge-config.mjs', args));
  assert.equal(readFileSync(profile, 'utf8'), first);
  succeeds(run('scripts/verify-credentials.mjs', [home]));
});

test('verifier rejects missing, drifted or non-private OpenRouter profiles', t => {
  const { home, envFile, config } = fixture(t);
  succeeds(run('scripts/prepare-credentials.mjs', [envFile], 'synthetic-key'));
  const profile = join(home, 'unified-openrouter.config.toml');
  succeeds(run('scripts/merge-config.mjs', [config, home, config, envFile, profile]));
  const original = readFileSync(profile, 'utf8');
  for (const changed of [
    original.replace('preserve-model-v1', 'unknown-policy'),
    original.replace('requires_openai_auth = false', 'requires_openai_auth = true'),
    original.replace('supports_websockets = false', 'supports_websockets = true'),
    original.replace('http://127.0.0.1:18766/v1', 'http://127.0.0.1:9999/v1'),
    original.replace('models.json', 'other-models.json'),
    original.replace('wire_api = "responses"', 'wire_api = "chat"'),
    original.replace(/X-Codex-Router-Token" = "[a-f0-9]{64}/, 'X-Codex-Router-Token" = "wrong'),
  ]) {
    writeFileSync(profile, changed);
    const result = run('scripts/verify-credentials.mjs', [home]);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout + result.stderr, /synthetic-key|[a-f0-9]{64}/);
  }
  writeFileSync(profile, original);
  if (process.platform !== 'win32') {
    chmodSync(profile, 0o644);
    assert.notEqual(run('scripts/verify-credentials.mjs', [home]).status, 0);
    chmodSync(profile, 0o600);
  }
  succeeds(run('scripts/verify-credentials.mjs', [home]));
  rmSync(profile);
  assert.notEqual(run('scripts/verify-credentials.mjs', [home]).status, 0);
});
