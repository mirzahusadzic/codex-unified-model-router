#!/usr/bin/env node
// Install or verify the router on any platform: runs the matching script under
// platform/ with the same options, environment, and terminal.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const usage = 'Usage: node install.mjs [--verify] [--force] [--no-service] [--api-key-file <path> | --change-api-key]';
const options = { verify: false, force: false, noService: false, apiKeyFile: null, changeApiKey: false };
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  switch (args[index]) {
    case '--verify': options.verify = true; break;
    case '--force': options.force = true; break;
    case '--no-service': options.noService = true; break;
    case '--change-api-key': options.changeApiKey = true; break;
    case '--api-key-file':
      options.apiKeyFile = args[index + 1] ?? null;
      if (!options.apiKeyFile) {
        console.error(usage);
        process.exit(2);
      }
      index += 1;
      break;
    case '--help':
    case '-h':
      console.log(usage);
      process.exit(0);
      break;
    default:
      console.error(usage);
      process.exit(2);
  }
}
if (options.verify && (options.force || options.apiKeyFile || options.changeApiKey)) {
  console.error('--verify accepts only --no-service');
  process.exit(2);
}
if (options.apiKeyFile && options.changeApiKey) {
  console.error('Use either --api-key-file or --change-api-key');
  process.exit(2);
}

const windows = process.platform === 'win32';

// Codex can change request headers and catalog templates between versions.
// Warn, without stopping, when the CLI or the shared app-server daemon, which
// keeps and may update its own copy of Codex, differs from the tested version.
const testedCodexVersion = '0.163.0';
function codex(commandArgs) {
  const run = spawnSync('codex', commandArgs, { encoding: 'utf8', shell: windows, timeout: 15000 });
  return run.status === 0 ? run.stdout : '';
}
const cliVersion = codex(['--version']).match(/\b(\d+\.\d+\.\d+)\b/)?.[1];
let daemon = null;
try {
  daemon = JSON.parse(codex(['app-server', 'daemon', 'version']));
} catch {}
const versionNotes = [
  cliVersion && cliVersion !== testedCodexVersion && `the Codex CLI is ${cliVersion}`,
  daemon?.status === 'running' && typeof daemon.appServerVersion === 'string'
    && daemon.appServerVersion !== testedCodexVersion && `the Codex app-server daemon runs ${daemon.appServerVersion}`,
].filter(Boolean);
if (versionNotes.length > 0) {
  console.error(`Warning: this router is tested with Codex ${testedCodexVersion}, but ${versionNotes.join(' and ')}.`
    + ` To match it: npm install -g @openai/codex@${testedCodexVersion}`);
}

const script = join(fileURLToPath(new URL('.', import.meta.url)), 'platform', windows ? 'windows' : 'unix',
  `${options.verify ? 'verify-install' : 'install'}.${windows ? 'ps1' : 'sh'}`);
const flags = windows
  ? [options.force && '-Force', options.noService && '-NoService', options.changeApiKey && '-ChangeApiKey',
    ...(options.apiKeyFile ? ['-ApiKeyFile', options.apiKeyFile] : [])]
  : [options.force && '--force', options.noService && '--no-service', options.changeApiKey && '--change-api-key',
    ...(options.apiKeyFile ? ['--api-key-file', options.apiKeyFile] : [])];
// Bypass applies to this one PowerShell process, so a restrictive default
// execution policy does not block the installer the user just asked to run.
const [command, commandArgs] = windows
  ? ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...flags.filter(Boolean)]]
  : ['bash', [script, ...flags.filter(Boolean)]];

const result = spawnSync(command, commandArgs, { stdio: 'inherit' });
if (result.error) {
  console.error(`Could not run ${script}: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
