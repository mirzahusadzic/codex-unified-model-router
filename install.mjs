#!/usr/bin/env node
// Install or verify the router on any platform: runs the matching script under
// platform/ with the same options, environment, and terminal.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const usage = 'Usage: node install.mjs [--verify] [--force] [--no-service] [--api-key-file <path>]';
const options = { verify: false, force: false, noService: false, apiKeyFile: null };
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  switch (args[index]) {
    case '--verify': options.verify = true; break;
    case '--force': options.force = true; break;
    case '--no-service': options.noService = true; break;
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
if (options.verify && (options.force || options.apiKeyFile)) {
  console.error('--verify accepts only --no-service');
  process.exit(2);
}

const windows = process.platform === 'win32';
const script = join(fileURLToPath(new URL('.', import.meta.url)), 'platform', windows ? 'windows' : 'unix',
  `${options.verify ? 'verify-install' : 'install'}.${windows ? 'ps1' : 'sh'}`);
const flags = windows
  ? [options.force && '-Force', options.noService && '-NoService', ...(options.apiKeyFile ? ['-ApiKeyFile', options.apiKeyFile] : [])]
  : [options.force && '--force', options.noService && '--no-service', ...(options.apiKeyFile ? ['--api-key-file', options.apiKeyFile] : [])];
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
