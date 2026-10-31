import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { routerRevision } from '../router/common.mjs';

const source = fileURLToPath(new URL('../router/unified-router.mjs', import.meta.url));
const verifier = fileURLToPath(new URL('../scripts/verify-health.mjs', import.meta.url));
const health = {
  ok: true, openai: true, openrouter: true, clientAuth: true,
  revision: routerRevision(source),
  capabilities: {
    routingPolicies: ['preserve-model-v1'],
    openrouterRejectionRecovery: 'completed-diagnostic-v1',
    providerIsolation: 'session-v3',
    revisionPrecondition: true,
  },
};

test('health verifier requires current source identity and capabilities, not just old booleans', () => {
  // The revision covers the router's modules, not only its entry file.
  const entryOnly = createHash('sha256').update(readFileSync(source)).digest('hex');
  for (const value of [health, { ...health, revision: '0'.repeat(64) }, { ...health, revision: entryOnly },
    { ...health, capabilities: undefined }, { ...health, capabilities: { routingPolicies: ['preserve-model-v1'] } },
    { ...health, capabilities: { routingPolicies: 'preserve-model-v1', revisionPrecondition: true } },
    { ...health, capabilities: { ...health.capabilities, openrouterRejectionRecovery: undefined } },
    // session-v3 adds the data-collection filter for sessions that used OpenAI or Claude.
    { ...health, capabilities: { ...health.capabilities, providerIsolation: undefined } },
    { ...health, capabilities: { ...health.capabilities, providerIsolation: 'session-v2' } },
    { ...health, clientAuth: false }, { ...health, openrouter: false }, null]) {
    const result = spawnSync(process.execPath, [verifier, source], { input: JSON.stringify(value), encoding: 'utf8' });
    assert.equal(result.status === 0, value === health, result.stderr);
  }
});

test('health verifier accepts only the router process the service runs', () => {
  const run = (value, option) => spawnSync(process.execPath, [verifier, source, option],
    { input: JSON.stringify(value), encoding: 'utf8' });
  const answering = { ...health, pid: 4242 };
  assert.equal(run(answering, '--service-pid=4242').status, 0);
  // A stray copy of the same code holds the port while the service's process restarts.
  const stray = run(answering, '--service-pid=5151');
  assert.notEqual(stray.status, 0);
  assert.match(stray.stderr, /Router process 4242 answers instead of the service's process 5151/);
  // The service runs no process at all, yet something answers on its port.
  const none = run(answering, '--service-pid=');
  assert.notEqual(none.status, 0);
  assert.match(none.stderr, /no running process, yet router process 4242 answers/);
  assert.notEqual(run(health, '--service-pid=4242').status, 0);
});

test('shared readiness probe rejects redirects without contacting their target', async t => {
  let targetContacts = 0;
  let redirect = null;
  const server = http.createServer((request, response) => {
    if (request.url === '/target') targetContacts++;
    if (redirect !== null) {
      response.writeHead(redirect, { location: `http://127.0.0.1:${server.address().port}/target` });
      response.end();
    } else {
      response.end(JSON.stringify(health));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  for (const code of [null, 301, 302, 303, 307, 308]) {
    redirect = code;
    const child = spawn(process.execPath, [verifier, source, `http://127.0.0.1:${server.address().port}/health`], { stdio: 'ignore' });
    const [status] = await once(child, 'exit');
    assert.equal(status === 0, code === null);
  }
  assert.equal(targetContacts, 0);
});
