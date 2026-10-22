import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { logicalLines } from '../scripts/toml-lines.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'router-credentials-'));
  mkdirSync(join(home, 'unified-router'), { mode: 0o700 });
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { home, envFile: join(home, 'unified-router', 'openrouter.env'), config: join(home, 'config.toml') };
}
function run(script, args, key = '', extraEnv = {}) {
  return spawnSync(process.execPath, [join(root, script), ...args], {
    encoding: 'utf8',
    env: { ...process.env, OPENROUTER_API_KEY: key, CODEX_ROUTER_TOKEN: '', CODEX_ROUTER_DISABLE_APPS: '1', CODEX_ROUTER_DISABLE_ANALYTICS: '1', CODEX_ROUTER_AGENT_THREADS: '10', ...extraEnv },
  });
}
const featureHeaders = text => text.split('\n').filter(line => line.trim() === '[features]').length;
// Each setting with the table it belongs to, so a test can check that a merge
// kept a setting in the same TOML context regardless of layout.
function settings(text) {
  let table = '';
  const result = [];
  for (const line of logicalLines(text).map(value => value.trim())) {
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('[')) table = line;
    else result.push(`${table} ${line}`);
  }
  return result;
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

test('a key file or stdin supplies the key, ahead of the environment, without printing it', t => {
  const { home, envFile } = fixture(t);
  const keyFile = join(home, 'openrouter.key');
  writeFileSync(keyFile, 'synthetic-file-key\n', { mode: 0o600 });
  const prepare = (args, input, key = '') => spawnSync(process.execPath,
    [join(root, 'scripts/prepare-credentials.mjs'), envFile, ...args],
    { encoding: 'utf8', input, env: { ...process.env, OPENROUTER_API_KEY: key, CODEX_ROUTER_TOKEN: '' } });

  succeeds(prepare(['--api-key-file', keyFile], undefined, 'synthetic-environment-key'));
  assert.match(readFileSync(envFile, 'utf8'), /^OPENROUTER_API_KEY=synthetic-file-key$/m);
  succeeds(prepare(['--api-key-stdin'], 'synthetic-stdin-key\n'));
  assert.match(readFileSync(envFile, 'utf8'), /^OPENROUTER_API_KEY=synthetic-stdin-key$/m);

  writeFileSync(keyFile, 'synthetic-secret\nCODEX_ROUTER_TOKEN=injected\n');
  for (const args of [['--api-key-file', keyFile], ['--api-key-file'], ['--api-key-stdin', 'extra'], ['--unknown']]) {
    const result = prepare(args, '');
    assert.notEqual(result.status, 0, args.join(' '));
    assert.doesNotMatch(result.stdout + result.stderr, /synthetic-secret|injected/);
  }
  assert.match(readFileSync(envFile, 'utf8'), /^OPENROUTER_API_KEY=synthetic-stdin-key$/m);
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

test('config merges disable Codex apps by default inside a single features table', t => {
  const { home, envFile, config } = fixture(t);
  succeeds(run('scripts/prepare-credentials.mjs', [envFile], 'synthetic-key'));
  const profile = join(home, 'unified-openrouter.config.toml');
  const args = [config, home, config, envFile, profile];

  succeeds(run('scripts/merge-config.mjs', args));
  const created = readFileSync(config, 'utf8');
  assert.match(created, /# BEGIN codex-unified-router features\n\[features\]\napps = false\n# END codex-unified-router features/);
  assert.equal(featureHeaders(created), 1);
  assert.doesNotMatch(readFileSync(profile, 'utf8'), /features/);
  succeeds(run('scripts/verify-credentials.mjs', [home]));

  writeFileSync(config, '[features]\napps = true\nshell_tool = false\n\n[profiles.review]\nmodel = "review-model"\n');
  succeeds(run('scripts/merge-config.mjs', args));
  const merged = readFileSync(config, 'utf8');
  assert.match(merged, /\[features\]\n# BEGIN codex-unified-router features\napps = false\n# END codex-unified-router features\nshell_tool = false/);
  assert.doesNotMatch(merged, /apps = true/);
  assert.equal(featureHeaders(merged), 1);
  assert.match(merged, /\[profiles\.review\]\nmodel = "review-model"/);
  succeeds(run('scripts/merge-config.mjs', args));
  assert.equal(readFileSync(config, 'utf8'), merged);
  succeeds(run('scripts/verify-credentials.mjs', [home]));
});

test('CODEX_ROUTER_DISABLE_APPS=0 leaves Codex apps to the user', t => {
  const { home, envFile, config } = fixture(t);
  succeeds(run('scripts/prepare-credentials.mjs', [envFile], 'synthetic-key'));
  const args = [config, home, config, envFile, join(home, 'unified-openrouter.config.toml')];
  succeeds(run('scripts/merge-config.mjs', args));
  // A key added below the router-created header must keep its table.
  writeFileSync(config, readFileSync(config, 'utf8')
    .replace('# END codex-unified-router features\n', '# END codex-unified-router features\nshell_tool = false\n'));

  const keep = { CODEX_ROUTER_DISABLE_APPS: '0' };
  succeeds(run('scripts/merge-config.mjs', args, '', keep));
  const text = readFileSync(config, 'utf8');
  assert.doesNotMatch(text, /codex-unified-router features|apps = false/);
  assert.match(text, /\[features\]\nshell_tool = false/);
  succeeds(run('scripts/verify-credentials.mjs', [home], '', keep));
  assert.notEqual(run('scripts/verify-credentials.mjs', [home]).status, 0);

  succeeds(run('scripts/merge-config.mjs', args));
  const restored = readFileSync(config, 'utf8');
  assert.match(restored, /\[features\]\n# BEGIN codex-unified-router features\napps = false\n# END codex-unified-router features\nshell_tool = false/);
  assert.equal(featureHeaders(restored), 1);
});

test('apps management refuses top-level feature keys and unknown settings without writing', t => {
  const { home, envFile, config } = fixture(t);
  succeeds(run('scripts/prepare-credentials.mjs', [envFile], 'synthetic-key'));
  const output = join(home, 'merged.toml');
  writeFileSync(config, 'features.apps = true\n');
  assert.notEqual(run('scripts/merge-config.mjs', [config, home, output, envFile]).status, 0);
  assert.notEqual(run('scripts/merge-config.mjs', [config, home, output, envFile], '', { CODEX_ROUTER_DISABLE_APPS: 'yes' }).status, 0);
  assert.throws(() => statSync(output));
  succeeds(run('scripts/merge-config.mjs', [config, home, output, envFile], '', { CODEX_ROUTER_DISABLE_APPS: '0' }));
  assert.match(readFileSync(output, 'utf8'), /^features\.apps = true$/m);
});

test('config merges never parse inside TOML multi-line strings', t => {
  const { home, envFile, config } = fixture(t);
  succeeds(run('scripts/prepare-credentials.mjs', [envFile], 'synthetic-key'));
  const instructions = 'developer_instructions = """\nKeep this text intact:\n[model_providers.unified]\n'
    + 'model = "not-a-key"\n# BEGIN codex-unified-router managed keys\n"""';
  writeFileSync(config, `${instructions}\nmodel = '''\nold-multiline-model\n'''\n[profiles.review]\nmodel = "review-model"\n`,
    { mode: 0o600 });
  const args = [config, home, config, envFile, join(home, 'unified-openrouter.config.toml')];
  succeeds(run('scripts/merge-config.mjs', args));
  const merged = readFileSync(config, 'utf8');
  assert.ok(merged.includes(instructions));
  assert.doesNotMatch(merged, /old-multiline-model/);
  assert.match(merged, /\[profiles\.review\]\nmodel = "review-model"/);
  assert.equal(merged.split('\n').filter(line => line === 'model = "deepseek/deepseek-v4.1-flash-1017"').length, 1);
  succeeds(run('scripts/merge-config.mjs', args));
  assert.equal(readFileSync(config, 'utf8'), merged);
  succeeds(run('scripts/verify-credentials.mjs', [home]));
});

test('config merges ignore triple quotes inside comments and single-line strings', t => {
  const { home, envFile, config } = fixture(t);
  succeeds(run('scripts/prepare-credentials.mjs', [envFile], 'synthetic-key'));
  const unrelated = '[profiles.review]\nmodel = "review-model"';
  writeFileSync(config, '# Documentation example: developer_instructions = """\n'
    + 'note = "a \\"\\"\\" inside"\nmodel = "mine"\n' + unrelated + '\n', { mode: 0o600 });
  const args = [config, home, config, envFile, join(home, 'unified-openrouter.config.toml')];
  succeeds(run('scripts/merge-config.mjs', args));
  const merged = readFileSync(config, 'utf8');
  // The user's top-level model is replaced, not duplicated next to the managed one.
  assert.doesNotMatch(merged, /model = "mine"/);
  assert.equal(merged.split('\n').filter(line => line === 'model = "deepseek/deepseek-v4.1-flash-1017"').length, 1);
  assert.ok(merged.includes(unrelated));
  succeeds(run('scripts/verify-credentials.mjs', [home]));
});

test('config merges manage the spawned-agent limit inside an existing agents table', t => {
  const { home, envFile, config } = fixture(t);
  succeeds(run('scripts/prepare-credentials.mjs', [envFile], 'synthetic-key'));
  const role = '[agents.reviewer]\ndescription = "Reviews changes"';
  writeFileSync(config, `[agents]\nmax_threads = 3\ninterrupt_message = false\n\n${role}\n`, { mode: 0o600 });
  const args = [config, home, config, envFile, join(home, 'unified-openrouter.config.toml')];
  succeeds(run('scripts/merge-config.mjs', args));
  const merged = readFileSync(config, 'utf8');
  assert.match(merged, /\[agents\]\n# BEGIN codex-unified-router agents\nmax_concurrent_threads_per_session = 10\n# END codex-unified-router agents\ninterrupt_message = false/);
  assert.doesNotMatch(merged, /max_threads/);
  assert.ok(merged.includes(role));
  assert.equal(merged.split('\n').filter(line => line === '[agents]').length, 1);
  succeeds(run('scripts/merge-config.mjs', args));
  assert.equal(readFileSync(config, 'utf8'), merged);
  succeeds(run('scripts/verify-credentials.mjs', [home]));

  succeeds(run('scripts/merge-config.mjs', args, '', { CODEX_ROUTER_AGENT_THREADS: '6' }));
  assert.match(readFileSync(config, 'utf8'), /^max_concurrent_threads_per_session = 6$/m);
  assert.notEqual(run('scripts/verify-credentials.mjs', [home]).status, 0);
  succeeds(run('scripts/verify-credentials.mjs', [home], '', { CODEX_ROUTER_AGENT_THREADS: '6' }));

  succeeds(run('scripts/merge-config.mjs', args, '', { CODEX_ROUTER_AGENT_THREADS: '0' }));
  const unmanaged = readFileSync(config, 'utf8');
  assert.doesNotMatch(unmanaged, /codex-unified-router agents|max_concurrent_threads_per_session/);
  assert.match(unmanaged, /\[agents\]\ninterrupt_message = false/);
  for (const value of ['-1', '1.5', 'ten', '1000']) {
    assert.notEqual(run('scripts/merge-config.mjs', args, '', { CODEX_ROUTER_AGENT_THREADS: value }).status, 0);
  }
});

test('config merges turn off Codex analytics unless told to leave them alone', t => {
  const { home, envFile, config } = fixture(t);
  succeeds(run('scripts/prepare-credentials.mjs', [envFile], 'synthetic-key'));
  writeFileSync(config, '[analytics]\nenabled = true\n', { mode: 0o600 });
  const args = [config, home, config, envFile, join(home, 'unified-openrouter.config.toml')];
  succeeds(run('scripts/merge-config.mjs', args));
  const merged = readFileSync(config, 'utf8');
  assert.match(merged, /\[analytics\]\n# BEGIN codex-unified-router analytics\nenabled = false\n# END codex-unified-router analytics/);
  assert.doesNotMatch(merged, /enabled = true/);
  succeeds(run('scripts/verify-credentials.mjs', [home]));

  const keep = { CODEX_ROUTER_DISABLE_ANALYTICS: '0' };
  succeeds(run('scripts/merge-config.mjs', args, '', keep));
  assert.doesNotMatch(readFileSync(config, 'utf8'), /codex-unified-router analytics|enabled = false/);
  succeeds(run('scripts/verify-credentials.mjs', [home], '', keep));
  assert.notEqual(run('scripts/merge-config.mjs', args, '', { CODEX_ROUTER_DISABLE_ANALYTICS: 'no' }).status, 0);
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
  for (const setting of settings(unrelated)) assert.ok(settings(first).includes(setting), setting);
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

test('config merges keep keys and tables that Codex inserted inside managed blocks', t => {
  const { home, envFile, config } = fixture(t);
  succeeds(run('scripts/prepare-credentials.mjs', [envFile], 'synthetic-key'));
  const profile = join(home, 'unified-openrouter.config.toml');
  const args = [config, home, config, envFile, profile];
  succeeds(run('scripts/merge-config.mjs', args));
  const managed = readFileSync(config, 'utf8');
  // Codex's TOML editor appends new keys and tables before a trailing comment,
  // which is how these landed between the router's markers in a real config.
  const inserted = managed
    .replace('# END codex-unified-router managed keys', 'personality = "pragmatic"\n# END codex-unified-router managed keys')
    .replace('apps = false\n', 'apps = false\nmulti_agent = true\n')
    .replace('enabled = false\n', 'enabled = false\nlog_user_prompts = false\n')
    .replace('# END codex-unified-router provider', '\n[tui]\nstatus_line = ["model"]\n\n[tui.model_availability_nux]\n'
      + '"gpt-6-astra" = 1\n\n[projects."/work/after the poem"]\ntrust_level = "trusted"\n\n[mcp_servers.after-the-poem]\n'
      + 'command = "node"\nargs = ["server.mjs", "--stdio"]\n# END codex-unified-router provider');
  writeFileSync(config, inserted, { mode: 0o600 });
  succeeds(run('scripts/verify-credentials.mjs', [home]));

  succeeds(run('scripts/merge-config.mjs', args));
  const merged = readFileSync(config, 'utf8');
  for (const setting of settings(inserted)) assert.ok(settings(merged).includes(setting), setting);
  assert.equal(settings(merged).length, settings(inserted).length);
  // The provider block no longer ends the file, where Codex inserts new tables.
  assert.doesNotMatch(merged.trimEnd(), /# END codex-unified-router provider$/);
  succeeds(run('scripts/verify-credentials.mjs', [home]));
  succeeds(run('scripts/merge-config.mjs', args));
  assert.equal(readFileSync(config, 'utf8'), merged);

  // Opting out of a router-created table keeps the foreign keys in that table.
  succeeds(run('scripts/merge-config.mjs', args, '', { CODEX_ROUTER_DISABLE_ANALYTICS: '0' }));
  const optedOut = readFileSync(config, 'utf8');
  assert.ok(settings(optedOut).includes('[analytics] log_user_prompts = false'));
  assert.ok(!settings(optedOut).includes('[analytics] enabled = false'));
});
