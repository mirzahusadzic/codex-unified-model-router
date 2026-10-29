import { readFileSync } from 'node:fs';
import http from 'node:http';
import { routerRevision } from '../router/common.mjs';

const [source, endpoint] = process.argv.slice(2);
if (!source) throw new Error('Usage: verify-health.mjs <installed-router-source> [local-health-url]');
const revision = routerRevision(source);

async function fetchHealth(endpoint) {
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password
      || url.search || url.hash || !['/health', '/v1/health'].includes(url.pathname)) {
    throw new Error('Expected a local 127.0.0.1 health endpoint');
  }
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      const request = http.get(url, response => {
        if (response.statusCode !== 200) {
          response.destroy();
          reject(new Error('Health endpoint must return HTTP 200; redirects are not accepted'));
          return;
        }
        const chunks = [];
        let bytes = 0;
        response.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > 16384) response.destroy(new Error('Health response exceeds 16 KiB'));
          else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      });
      request.on('error', reject);
      timer = setTimeout(() => request.destroy(new Error('Health request timed out')), 2000);
    });
  } finally {
    clearTimeout(timer);
  }
}

const health = JSON.parse(endpoint ? await fetchHealth(endpoint) : readFileSync(0, 'utf8'));
if (!health || !['ok', 'openai', 'openrouter', 'clientAuth'].every(key => health[key] === true)
    || !Array.isArray(health.capabilities?.routingPolicies)
    || !health.capabilities.routingPolicies.includes('preserve-model-v1')
    || health.capabilities.openrouterRejectionRecovery !== 'completed-diagnostic-v1'
    || health.capabilities.providerIsolation !== 'session-v2'
    || health.capabilities.revisionPrecondition !== true || health.revision !== revision) {
  throw new Error('Router health, required capabilities or installed source revision do not match; update and restart the router');
}
