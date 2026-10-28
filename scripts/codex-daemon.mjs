import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Prepare Codex's shared app-server daemon after an installation, or with
// --verify check it. The daemon keeps the configuration and catalog it started
// with, and unless pinned replaces its own copy of Codex with each new release,
// so it can run a version this router was not tested with. Pinning it to the
// CLI's Codex with `update --from-cli` also restarts it if it runs. Restarting
// interrupts its open sessions, so a running daemon is left alone when Codex
// itself runs the installer or when restarts are turned off; a stopped daemon
// is pinned without starting it.
const args = process.argv.slice(2);
const verify = args[0] === '--verify';
const [codexHome, ...flags] = verify ? args.slice(1) : args;
if (!codexHome || flags.some(flag => flag !== '--codex-runs-installer') || (verify && flags.length > 0)) {
  console.error('Usage: codex-daemon.mjs [--verify] <codex-home> [--codex-runs-installer]');
  process.exit(2);
}
function setting(name) {
  const value = process.env[name] || '1';
  if (!['0', '1'].includes(value)) {
    console.error(`${name} must be 0 or 1`);
    process.exit(2);
  }
  return value === '1';
}
const pin = setting('CODEX_ROUTER_PIN_DAEMON');
const restart = setting('CODEX_ROUTER_RESTART_DAEMON');
const codexRunsInstaller = flags.includes('--codex-runs-installer');

const windows = process.platform === 'win32';
const codex = commandArgs => spawnSync('codex', commandArgs, { encoding: 'utf8', shell: windows, timeout: 300000 });
// `daemon version` fails unless the daemon runs.
let daemon = null;
try {
  daemon = JSON.parse(codex(['app-server', 'daemon', 'version']).stdout);
} catch {}
const running = daemon?.status === 'running';
const packageRoot = join(codexHome, 'packages', 'app-server-daemon');
const installed = running || existsSync(join(packageRoot, 'current'));
const pinCommand = 'codex app-server daemon update --from-cli --yes';
// Codex installs the daemon the first time it needs one, which may be after this installation.
const notInstalled = 'No Codex app-server daemon is installed, so there is none to pin. If Codex installs one later, rerun the installer to pin it to the CLI\'s Codex.';

if (verify) {
  if (!pin) process.exit(0);
  if (!installed) {
    console.error(notInstalled);
    process.exit(0);
  }
  // Codex keeps this marker while the daemon follows its own updates and
  // removes it when `update --from-cli` pins the CLI's package.
  if (existsSync(join(packageRoot, 'auto-update-version'))) {
    console.error(`The Codex app-server daemon updates itself instead of following the CLI; rerun the installer, or run: ${pinCommand}`);
    process.exit(1);
  }
  if (running && daemon.managedCodexVersion !== daemon.cliVersion) {
    console.error(`The Codex app-server daemon runs Codex ${daemon.managedCodexVersion}, but the CLI is ${daemon.cliVersion}; rerun the installer, or run: ${pinCommand}`);
    process.exit(1);
  }
  process.exit(0);
}

if (!installed) {
  if (pin) console.error(notInstalled);
  process.exit(0);
}
if (running && codexRunsInstaller) {
  console.error(`Codex is running this installer, so its daemon was not restarted${pin ? ' or pinned' : ''}. Afterwards run: ${pin ? pinCommand : 'codex app-server daemon restart'}`);
  process.exit(0);
}
if (running && !restart) {
  if (pin) console.error(`The running Codex app-server daemon was not pinned, because CODEX_ROUTER_RESTART_DAEMON=0 skips restarting it. To pin it, run: ${pinCommand}`);
  process.exit(0);
}
if (pin) {
  console.error('==> Pinning the Codex app-server daemon to the CLI\'s Codex');
  if (codex(['app-server', 'daemon', 'update', '--from-cli', '--yes']).status === 0) {
    console.log(`Pinned the Codex app-server daemon to the CLI's Codex${running ? ' and restarted it' : ''}.`);
    process.exit(0);
  }
  console.error(`Could not pin the Codex app-server daemon to the CLI's Codex. Run: ${pinCommand}`);
}
if (running) {
  console.error('==> Restarting the Codex app-server daemon');
  if (codex(['app-server', 'daemon', 'restart']).status === 0) console.log('Restarted the Codex app-server daemon.');
  else console.error('Could not restart the Codex app-server daemon. Run: codex app-server daemon restart');
}
