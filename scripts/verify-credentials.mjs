import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const [codexHome] = process.argv.slice(2);
if (!codexHome) throw new Error('Usage: verify-credentials.mjs <codex-home>');
const envFile = join(codexHome, 'unified-router', 'openrouter.env');
const configFile = join(codexHome, 'config.toml');
const env = readFileSync(envFile, 'utf8');
const token = env.match(/^CODEX_ROUTER_TOKEN=([a-f0-9]{64})\r?$/m)?.[1];
if (!token || !/^OPENROUTER_API_KEY=.+\r?$/m.test(env)) {
  throw new Error('Router credentials are missing; rerun the installer');
}
const config = readFileSync(configFile, 'utf8');
const provider = config.split('# BEGIN codex-unified-router provider')[1]?.split('# END codex-unified-router provider')[0];
if (!provider?.includes(`http_headers = { "X-Codex-Router-Token" = "${token}" }`)) {
  throw new Error('Codex and router tokens differ; rerun the installer');
}
if (process.platform !== 'win32') {
  for (const file of [envFile, configFile, join(codexHome, 'unified-router')]) {
    const stat = statSync(file);
    if ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()) {
      throw new Error(`Expected a private, current-user-owned path: ${file}`);
    }
  }
}
