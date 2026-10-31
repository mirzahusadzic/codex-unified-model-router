import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('../platform/unix/service-pids.sh', import.meta.url));
const skip = process.platform === 'win32' ? 'the Unix helper needs bash' : false;

// Fake launchctl, systemctl, pgrep, id and node, so the helper runs without a
// real service; pgrep reports children from PGREP_CHILDREN ("parent:child ...").
const fakes = {
  launchctl: '#!/usr/bin/env bash\nprintf "%b" "$LAUNCHCTL_OUTPUT"\n',
  systemctl: '#!/usr/bin/env bash\ncase "$*" in *"show -p MainPID --value"*) printf "%s\\n" "$SYSTEMD_PID" ;; esac\n',
  pgrep: '#!/usr/bin/env bash\nfor pair in $PGREP_CHILDREN; do [[ "${pair%%:*}" == "$2" ]] && printf "%s\\n" "${pair#*:}"; done\nexit 0\n',
  id: '#!/usr/bin/env bash\nprintf "501\\n"\n',
  node: '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$NODE_CALLS"\nexit 0\n',
};

function withFakes(t) {
  const root = mkdtempSync(join(tmpdir(), 'service-pids-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  for (const [name, body] of Object.entries(fakes)) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  const calls = join(root, 'node-calls.txt');
  t.after(() => {
    for (const name of Object.keys(fakes)) rmSync(join(bin, name));
    rmSync(calls, { force: true });
    rmdirSync(bin);
    rmdirSync(root);
  });
  return (script, env) => {
    const result = spawnSync('bash', ['-c', `source "${helper}"; ${script}`], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, NODE_CALLS: calls, ...env },
    });
    assert.equal(result.status, 0, result.stderr);
    let nodeCalls = '';
    try { nodeCalls = readFileSync(calls, 'utf8'); } catch {}
    return { stdout: result.stdout, nodeCalls };
  };
}

test('service PIDs are launchd\'s or systemd\'s process and every process it started', { skip }, t => {
  const run = withFakes(t);
  const launchd = { LAUNCHCTL_OUTPUT: '\\tstate = running\\n\\tpid = 4242\\n', PGREP_CHILDREN: '4242:4243 4243:4244' };
  assert.equal(run('service_pids Darwin label unit', launchd).stdout, '4242,4243,4244');
  // Throttled between restarts, launchd shows no PID: the service runs none.
  assert.equal(run('service_pids Darwin label unit', { LAUNCHCTL_OUTPUT: '\\tstate = spawn scheduled\\n' }).stdout, '');
  assert.equal(run('service_pids Linux label unit', { SYSTEMD_PID: '5252', PGREP_CHILDREN: '' }).stdout, '5252');
  assert.equal(run('service_pids Linux label unit', { SYSTEMD_PID: '0' }).stdout, '');
});

test('the installers\' readiness wait passes the service PIDs to the health check', { skip }, t => {
  const run = withFakes(t);
  const { nodeCalls } = run('wait_for_service_router Darwin label unit verify-health.mjs router.mjs http://127.0.0.1:1/health',
    { LAUNCHCTL_OUTPUT: '\\tpid = 4242\\n', PGREP_CHILDREN: '4242:4243' });
  assert.equal(nodeCalls, 'verify-health.mjs router.mjs http://127.0.0.1:1/health --service-pid=4242,4243\n');
});
