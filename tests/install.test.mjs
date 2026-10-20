import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const windows = process.platform === 'win32';

test('no-service installer guards collisions before mutation and preserves backed-up profile preferences', t => {
  const directory = mkdtempSync(join(tmpdir(), 'router-install-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = join(directory, 'codex-home');
  const bin = join(directory, 'bin');
  mkdirSync(home);
  mkdirSync(bin);
  writeFileSync(join(bin, windows ? 'codex.cmd' : 'codex'), windows
    ? '@echo off\r\necho {"models":[]}\r\n'
    : '#!/bin/sh\nprintf \'{"models":[]}\\n\'\n', { mode: 0o700 });
  const environment = { ...process.env, HOME: directory, CODEX_HOME: home,
    PATH: bin + (windows ? ';' : ':') + process.env.PATH, OPENROUTER_API_KEY: 'synthetic-install-key',
    CODEX_ROUTER_TOKEN: '' };
  function invoke(verify = false, force = false) {
    const script = verify ? 'scripts/verify-install' : 'install';
    return spawnSync(windows ? 'powershell.exe' : 'bash', windows
      ? ['-NoProfile', '-File', join(root, script + '.ps1'), '-NoService', ...(force ? ['-Force'] : [])]
      : [join(root, script + '.sh'), '--no-service', ...(force ? ['--force'] : [])],
    { env: environment, encoding: 'utf8', timeout: 30000 });
  }
  const profile = join(home, 'unified-openrouter.config.toml');
  const original = 'model = "deepseek/custom"\nmodel_reasoning_effort = "high"\n'
    + '[features]\nshell_tool = false\n';
  writeFileSync(profile, original);
  const collision = invoke();
  assert.equal(collision.status, 2, collision.stderr);
  assert.equal(readFileSync(profile, 'utf8'), original);
  assert.deepEqual(readdirSync(home), ['unified-openrouter.config.toml']);
  const converted = invoke(false, true);
  assert.equal(converted.status, 0, converted.stderr);
  const first = readFileSync(profile, 'utf8');
  assert.ok(first.includes(original));
  const backups = readdirSync(join(home, 'backups'));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(home, 'backups', backups[0], 'unified-openrouter.config.toml'), 'utf8'), original);
  const verified = invoke(true);
  assert.equal(verified.status, 0, verified.stderr);
  const updated = invoke();
  assert.equal(updated.status, 0, updated.stderr);
  assert.equal(readFileSync(profile, 'utf8'), first);
  assert.equal(existsSync(join(home, 'unified-router/start-router.cmd')), false);
  rmSync(profile);
  assert.notEqual(invoke(true).status, 0);
});
