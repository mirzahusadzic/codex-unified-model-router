# Platform entry points

Each operating system has its own installer and verifier here. The shared Node.js code they call lives in [`scripts/`](../scripts/), and the cross-platform tests live in [`tests/`](../tests/). Run these files from the repository root.

| Platform | File | Purpose |
| --- | --- | --- |
| macOS, Linux | [`unix/install.sh`](unix/install.sh) | Install or update the router, catalog, and Codex configuration. |
| macOS, Linux | [`unix/verify-install.sh`](unix/verify-install.sh) | Verify an installation. |
| Windows | [`windows/install.ps1`](windows/install.ps1) | Install or update the router, catalog, and Codex configuration. |
| Windows | [`windows/verify-install.ps1`](windows/verify-install.ps1) | Verify an installation. |
| Windows | [`windows/private-path.ps1`](windows/private-path.ps1) | Restrict a file or directory to the current user; used by the Windows installer and verifier. |
| Windows | [`windows/private-path.test.ps1`](windows/private-path.test.ps1) | Test for `private-path.ps1`; CI runs it on Windows. |

The installers accept the same settings on every platform; see [Installer settings](../docs/setup.md#installer-settings). Keep the two platforms' behavior aligned, including backups and preservation of unrelated configuration.
