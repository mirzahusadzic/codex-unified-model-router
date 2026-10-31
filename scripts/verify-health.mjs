import { readFileSync } from 'node:fs';
import http from 'node:http';
import { routerRevision } from '../router/common.mjs';

// --service-pid names the service's own router process: launchd's, systemd's,
// or the Windows supervisor's child; empty or 0 means the service runs none.
// Any other argument shape is refused, so a typo cannot skip the check.
const args = process.argv.slice(2);
const options = args.filter(arg => arg.startsWith('-'));
const [source, endpoint, ...extra] = args.filter(arg => !arg.startsWith('-'));
if (!source || extra.length > 0 || options.length > 1
    || options.some(arg => !/^--service-pid=(?:0|[1-9][0-9]*)?$/.test(arg))) {
  throw new Error('Usage: verify-health.mjs <installed-router-source> [local-health-url] [--service-pid=<pid>]');
}
const servicePidOption = options[0];
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
    || health.capabilities.providerIsolation !== 'session-v3'
    || health.capabilities.revisionPrecondition !== true || health.revision !== revision) {
  throw new Error('Router health, required capabilities or installed source revision do not match; update and restart the router');
}
if (servicePidOption !== undefined) {
  const servicePid = Number(servicePidOption.slice('--service-pid='.length) || 0);
  if (!Number.isSafeInteger(servicePid) || servicePid <= 0) {
    throw new Error(`The router service has no running process, yet router process ${health.pid ?? 'unknown'} answers; stop that process and restart the service`);
  }
  if (health.pid !== servicePid) {
    throw new Error(`Router process ${health.pid ?? 'unknown'} answers instead of the service's process ${servicePid}; stop it and restart the service`);
  }
}
