import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../router/unified-router.mjs', import.meta.url));
const verifier = fileURLToPath(new URL('../scripts/verify-health.mjs', import.meta.url));
const health = {
  ok: true, openai: true, openrouter: true, clientAuth: true,
  revision: createHash('sha256').update(readFileSync(source)).digest('hex'),
  capabilities: {
    routingPolicies: ['preserve-model-v1'],
    openrouterRejectionRecovery: 'completed-diagnostic-v1',
    revisionPrecondition: true,
  },
};

test('health verifier requires current source identity and capabilities, not just old booleans', () => {
  for (const value of [health, { ...health, revision: '0'.repeat(64) },
    { ...health, capabilities: undefined }, { ...health, capabilities: { routingPolicies: ['preserve-model-v1'] } },
    { ...health, capabilities: { routingPolicies: 'preserve-model-v1', revisionPrecondition: true } },
    { ...health, capabilities: { ...health.capabilities, openrouterRejectionRecovery: undefined } },
    { ...health, clientAuth: false }, { ...health, openrouter: false }, null]) {
    const result = spawnSync(process.execPath, [verifier, source], { input: JSON.stringify(value), encoding: 'utf8' });
    assert.equal(result.status === 0, value === health, result.stderr);
  }
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
