import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const run = (script, args) => spawnSync(process.execPath, [join(root, 'scripts', script), ...args], { encoding: 'utf8' });
// A synthetic login: only the claims matter, the signature is never checked.
const idToken = claims => ['{"alg":"none"}', JSON.stringify(claims), 'signature']
  .map(part => Buffer.from(part).toString('base64url')).join('.');
const planClaims = until => ({ 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus', chatgpt_subscription_active_until: until } });

test('ChatGPT plan detection reads the login claims without printing tokens', t => {
  const home = mkdtempSync(join(tmpdir(), 'router-plan-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const status = auth => {
    if (auth !== undefined) writeFileSync(join(home, 'auth.json'), typeof auth === 'string' ? auth : JSON.stringify(auth));
    const result = run('chatgpt-plan.mjs', [home]);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /signature|eyJ/);
    return result.stdout.trim();
  };
  assert.equal(status(), 'inactive');
  const future = new Date(Date.now() + 86400000).toISOString();
  const past = new Date(Date.now() - 86400000).toISOString();
  assert.equal(status({ tokens: { id_token: idToken(planClaims(future)) } }), 'active');
  assert.equal(status({ tokens: { id_token: idToken(planClaims(past)) } }), 'inactive');
  assert.equal(status({ auth_mode: 'apikey', OPENAI_API_KEY: 'synthetic' }), 'inactive');
  assert.equal(status({ tokens: { id_token: idToken({ sub: 'user' }) } }), 'unknown');
  assert.equal(status('not json'), 'unknown');
});

test('catalog builds can hide native models from the picker and keep catalog entries listed', t => {
  const directory = mkdtempSync(join(tmpdir(), 'router-native-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'bundled.json'), JSON.stringify({ models: [
    { slug: 'gpt-6-astra', visibility: 'list' }, { slug: 'codex-auto-review', visibility: 'hide' },
  ] }));
  const build = mode => run('build-catalog.mjs', ['--bundled', join(directory, 'bundled.json'),
    '--catalog-dir', join(root, 'catalog'), ...(mode ? ['--native-models', mode] : []),
    '--output', join(directory, 'models.json')]);
  const visibility = () => Object.fromEntries(JSON.parse(readFileSync(join(directory, 'models.json'), 'utf8')).models
    .map(model => [model.slug, model.visibility]));

  assert.equal(build('hide').status, 0);
  const hidden = visibility();
  assert.equal(hidden['gpt-6-astra'], 'hide');
  assert.equal(hidden['codex-auto-review'], 'hide');
  assert.equal(hidden['deepseek/deepseek-v4.1-flash-1017'], 'list');
  assert.equal(build().status, 0);
  assert.equal(visibility()['gpt-6-astra'], 'list');
  assert.match(build('none').stderr, /--native-models must be show or hide/);
});
