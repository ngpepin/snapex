# SnapEx

SnapEx is a local VS Code extension that creates one final zip package per installed extension. Each package contains a timestamped backup folder with the extension archive plus a best-effort snapshot of that extension's configuration, discovered external state files, and storage folders.

## User guide

See [USER-GUIDE.md](USER-GUIDE.md) for step-by-step installation, backup, restore, inspection, troubleshooting, and usage examples.

## Commands

Open the SnapEx Activity Bar icon (`snapex-icon.png`), or open the Command Palette and run one of these commands:

- `SnapEx: Backup All Extensions`
- `SnapEx: Backup Selected Extension`
- `SnapEx: Restore Extension from Zip`
- `SnapEx: Open Backup Folder`

## Backup package names

Each extension backup is staged in its own folder, then SnapEx writes a final `.zip` of that folder and deletes the uncompressed folder. The final package uses this format:

```text
vscode-extension-backup-<extension-name-and-version>_YYYYMMDDHHMMAM/PM.zip
```

The timestamp is generated from the local time of the machine running VS Code. For example, a Continue `2.0.0` backup made at 4:05 PM on July 8, 2026 would produce:

```text
vscode-extension-backup-Continue.continue-2.0.0_202607080405PM.zip
```

Inside the final package, the backed-up folder contains `backup-index.json` and the shorter extension archive, such as `Continue.continue-2.0.0.zip`.

## What each extension archive contains

The nested extension archive contains:

- `manifest.json` with the extension id, version, original install folder, source environment, and archive contents.
- `extension/` with the installed extension files, when `extensionStateBackup.includeExtensionFiles` is enabled.
- `configuration/configuration.json` with explicitly set global, workspace, and workspace-folder values for configuration keys contributed by that extension.
- `globalStorage/` with the extension's per-extension global storage folder, when present.
- `workspaceStorage/current/` with the extension's storage folder for the currently open workspace, when present.
- `externalState/home/` with discovered extension-owned config/state files from the user's home directory, when present.
- `metadata/external-state.json` with restore metadata and discovery hints for files captured under `externalState/home/`.
- `metadata/extension-file-modes.json` with executable/file mode metadata so restored extension files can keep Unix permissions when possible.

The restore command accepts either the final `vscode-extension-backup-...zip` package or the nested extension archive directly.

## External config and state discovery

VS Code extension manifests do not expose a universal list of every external config or state file an extension may create. SnapEx therefore uses a conservative, generalized discovery layer instead of a single Continue-specific path.

During backup, SnapEx builds identity tokens from each extension's:

- extension id
- manifest `name`
- manifest `displayName`
- manifest `publisher`
- repository basename, when declared
- contributed configuration key prefixes, such as `continue.*` or `genericTool.*`

It then checks common per-user config/state locations under the home directory, including:

```text
~/.<token>/
~/.<token>.json
~/.<token>.yaml
~/.config/<token>/
~/.config/<token>.json
~/.config/<token>.yaml
~/.local/share/<token>/
~/Library/Application Support/<token>/
~/Library/Preferences/<token>/
~/AppData/Roaming/<token>/
~/AppData/Local/<token>/
```

Publisher/name combinations are also checked in common XDG, macOS, and Windows locations. For example, Continue is now captured through the generic `continue` token, so `~/.continue/config.yaml` is still included without a dedicated hard-coded Continue-only function.

To avoid sweeping too broadly, SnapEx skips common cache/log/build folders, ignores symlinks, and applies per-file, per-extension file-count, and total-size limits. The metadata file records a `discoveredBy` hint for each external file so backups can be inspected later.

## What cannot be fully backed up

VS Code does not expose every private state location of other extensions through the public API. This extension therefore cannot export or restore:

- SecretStorage values, passwords, auth tokens, or OS keychain entries.
- Authentication sessions managed by VS Code or by the operating system.
- Every private Memento/globalState record if an extension stores it in VS Code's shared internal state database instead of in its own `globalStorage` folder.
- Workspace storage for workspaces that are not open during the backup run.
- Arbitrary files referenced from an extension's config, such as custom model files, certificates, rule files, prompt files, or MCP server working directories outside the discovered external-state paths.

The archive is still useful for restoring the installed extension files, contributed user/workspace settings, storage folders that are visible to the extension host, and discovered external config/state files such as Continue's `~/.continue/config.yaml`.

## Settings

- `extensionStateBackup.defaultBackupLocation`: Optional absolute folder path where backup packages are written.
- `extensionStateBackup.includeBuiltIn`: Include built-in VS Code extensions. Disabled by default.
- `extensionStateBackup.includeExtensionFiles`: Include the installed extension directory. Enabled by default.
- `extensionStateBackup.includeCurrentWorkspaceStorage`: Include storage for the currently open workspace. Enabled by default.
- `extensionStateBackup.confirmBeforeRestore`: Ask before overwriting files/settings/storage during restore. Enabled by default.

## Update and install locally

From this project folder, run:

```bash
bash update-extension.sh
```

The script fetches the latest `origin/main` and tags, fast-forwards the local branch, reports the current `package.json` version against the latest semver release/tag it can see, installs npm dependencies, runs the regression suite, packages the VSIX for the current version, uninstalls older SnapEx extension ids, reinstalls the newly packaged VSIX with `--force`, and verifies that VS Code lists the installed SnapEx extension.

After it finishes, reload VS Code.

The script runs this verification automatically, but you can re-run it manually if needed:

```bash
code --list-extensions --show-versions | grep '^local-tools.snapex@'
```

For a local branch that must be force-aligned with GitHub first, run:

```bash
bash update-extension.sh --reset-to-origin
```

Use `--skip-pull` only when intentionally packaging the current checkout instead of the latest remote branch.

You can also open the Command Palette and run `SnapEx: Backup All Extensions`.

## Development

```bash
npm install
npm run compile
```

Press `F5` in VS Code to launch an Extension Development Host.

## Regression testing

Run the full regression suite with:

```bash
npm test
```

`npm test` compiles the TypeScript extension, runs `test/regression-test.js`, and then runs `test/external-discovery-test.js`. The tests use mocked VS Code extension hosts plus temporary filesystem fixtures. They do not need a real VS Code window.

The regression suite currently verifies that SnapEx:

1. Registers the backup, restore, selected-backup, and open-folder commands.
2. Excludes built-in extensions from default backups.
3. Creates the final timestamped `vscode-extension-backup-<extension-and-version>_YYYYMMDDHHMMAM/PM.zip` package.
4. Deletes the temporary uncompressed staging folder after writing the final package.
5. Writes `backup-index.json` and the nested per-extension zip.
6. Captures installed extension files, contributed VS Code settings, global storage, current-workspace storage, external state, external-state metadata, and file-mode metadata.
7. Restores from both the final outer package and the nested extension archive directly.
8. Replays global, workspace, and workspace-folder configuration values.
9. Leaves files, storage, external state, and settings untouched when restore confirmation is cancelled.
10. Rejects malicious archive entries that try to write outside the target restore directory.
11. Restores external state from older-compatible archives that contain `externalState/home/` files but no `metadata/external-state.json`.
12. Reveals either the configured backup folder or the fallback SnapEx storage backup folder.
13. Discovers external config/state files for a non-Continue extension through manifest and configuration-key hints.
14. Skips cache folders during generalized external-state discovery.

You can also run the suite explicitly with:

```bash
npm run test:regression
```

Run only the generalized external-state discovery test with:

```bash
npm run test:external-discovery
```

The older narrow smoke test remains available for comparison:

```bash
npm run test:smoke
```

## Restore behavior

When restoring a backup zip, the extension:

1. Opens either the final backup package or a nested extension archive.
2. Reads `manifest.json` to identify the target extension.
3. Removes the currently installed extension directory if that extension already exists.
4. Extracts the backed-up `extension/` files into the extension install folder.
5. Restores captured `globalStorage/` and current-workspace storage folders.
6. Restores captured contributed settings.
7. Restores captured external state files under the current user's home directory, such as `~/.continue/config.yaml` when discovered and captured.
8. Prompts you to reload the VS Code window.

Restoring an active extension can fail on locked files, especially on Windows. Closing extra VS Code windows and retrying usually helps.
