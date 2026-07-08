# SnapEx User Guide

SnapEx is a local Visual Studio Code extension for backing up and restoring installed VS Code extensions. It creates one final zip package per backed-up extension. Each package contains the extension files, selected VS Code configuration, visible storage folders, and selected external state files when SnapEx can identify them.

This guide explains how to install SnapEx, create backups, restore an extension, inspect backup contents, and troubleshoot common issues.

## Contents

- [What SnapEx backs up](#what-snapex-backs-up)
- [What SnapEx cannot fully back up](#what-snapex-cannot-fully-back-up)
- [Install or update SnapEx](#install-or-update-snapex)
- [Open SnapEx in VS Code](#open-snapex-in-vs-code)
- [Create backups](#create-backups)
- [Restore from a backup](#restore-from-a-backup)
- [Backup package examples](#backup-package-examples)
- [Inspect a backup zip manually](#inspect-a-backup-zip-manually)
- [Settings](#settings)
- [Recommended workflows](#recommended-workflows)
- [Troubleshooting](#troubleshooting)
- [Developer and testing notes](#developer-and-testing-notes)

## What SnapEx backs up

For each backed-up extension, SnapEx creates a final backup package named like this:

```text
vscode-extension-backup-<extension-name-and-version>_YYYYMMDDHHMMAM/PM.zip
```

The timestamp is based on the local time of the machine running VS Code.

Inside the final package, SnapEx stores a timestamped backup folder. That folder contains:

- `backup-index.json`, which summarizes the backup package.
- A nested extension archive, such as `Continue.continue-2.0.0.zip`.

The nested extension archive can include:

- `manifest.json` with extension identity, version, install path, backup metadata, and captured sections.
- `extension/` with the installed extension files.
- `configuration/configuration.json` with explicitly set VS Code settings contributed by that extension.
- `globalStorage/` with the extension's per-extension global storage folder, when present.
- `workspaceStorage/current/` with storage for the currently open workspace, when present.
- `externalState/home/` with selected extension-owned files under your home directory, when present.
- `metadata/external-state.json` with restore metadata for captured external state files.
- `metadata/extension-file-modes.json` with file permission metadata for restored extension files, where supported.

## What SnapEx cannot fully back up

SnapEx is a best-effort extension backup tool. VS Code does not expose every private extension state location through public APIs, and many extensions store state in their own custom ways.

SnapEx cannot reliably back up or restore:

- Passwords, tokens, API keys, and VS Code SecretStorage values.
- OS keychain entries.
- Authentication sessions managed by VS Code, GitHub, Microsoft, or another provider.
- Private in-memory state.
- Every `globalState` or `workspaceState` value if the extension stores it only in VS Code's shared internal databases.
- Workspace storage for workspaces that are not currently open during the backup.
- Arbitrary files referenced by an extension, such as model files, certificates, prompts, rule files, server logs, or custom working directories outside the selected captured paths.

Treat every backup as important but not as a guaranteed complete clone of all extension behavior. After restoring, you may still need to sign in again or re-enter secrets.

## Install or update SnapEx

From your local `snapex` repository, run:

```bash
cd ~/Projects/snapex
bash update-extension.sh
```

The script will:

1. Fetch the latest `origin/main` and tags.
2. Fast-forward your local branch.
3. Compare the local package version against the latest visible semver tag or release.
4. Install npm dependencies.
5. Run the regression test suite.
6. Package the current VSIX.
7. Uninstall older SnapEx extension IDs.
8. Install the newly packaged VSIX with `--force`.
9. Verify that VS Code lists SnapEx as installed.

After the script finishes, reload VS Code.

If your local branch has diverged from GitHub and you want to force your local checkout to match the remote repo, run:

```bash
cd ~/Projects/snapex
bash update-extension.sh --reset-to-origin
```

Use this only when you are comfortable discarding local-only commits and aligning your checkout with `origin/main`.

You can manually verify the installed extension with:

```bash
code --list-extensions --show-versions | grep '^local-tools.snapex@'
```

You should see output similar to:

```text
local-tools.snapex@0.1.4
```

The exact version may be newer than this guide if SnapEx has been updated.

## Open SnapEx in VS Code

After installation and reload, SnapEx can be opened in two ways.

### Option 1: Activity Bar

1. Open VS Code.
2. Look for the SnapEx icon in the Activity Bar.
3. Click the SnapEx icon.
4. Use one of the actions shown in the SnapEx view:
   - **Backup All Extensions**
   - **Backup Selected Extension**
   - **Restore Extension from Zip**
   - **Open Backup Folder**

### Option 2: Command Palette

1. Open the Command Palette:
   - Linux/Windows: `Ctrl+Shift+P`
   - macOS: `Cmd+Shift+P`
2. Search for `SnapEx`.
3. Run one of these commands:
   - `SnapEx: Backup All Extensions`
   - `SnapEx: Backup Selected Extension`
   - `SnapEx: Restore Extension from Zip`
   - `SnapEx: Open Backup Folder`

## Create backups

### Back up all extensions

Use this when you want a full snapshot of all eligible installed extensions.

1. Open the SnapEx Activity Bar view or Command Palette.
2. Run `SnapEx: Backup All Extensions`.
3. Choose a backup destination folder if prompted.
4. Wait for SnapEx to create backup packages.
5. Open the backup destination folder to confirm the zip files were created.

SnapEx creates one final zip package per extension.

Example output files:

```text
vscode-extension-backup-Continue.continue-2.0.0_202607080405PM.zip
vscode-extension-backup-ms-python.python-2026.8.0_202607080406PM.zip
vscode-extension-backup-esbenp.prettier-vscode-11.0.0_202607080406PM.zip
```

### Back up one selected extension

Use this when you want to test SnapEx or capture one extension before making a risky change.

1. Open the SnapEx Activity Bar view or Command Palette.
2. Run `SnapEx: Backup Selected Extension`.
3. Select the extension from the picker.
4. Choose a backup destination folder if prompted.
5. Confirm that a zip package was created for that extension.

Example: backing up Continue could create:

```text
vscode-extension-backup-Continue.continue-2.0.0_202607080405PM.zip
```

### Open the configured backup folder

Run `SnapEx: Open Backup Folder` to open the configured backup location or SnapEx's fallback backup folder.

This is useful after a backup completes and you want to inspect or copy the generated zip packages.

## Restore from a backup

The restore command accepts either:

- The final outer package, such as `vscode-extension-backup-Continue.continue-2.0.0_202607080405PM.zip`.
- The nested per-extension archive inside that package, such as `Continue.continue-2.0.0.zip`.

The final outer package is recommended because it is the product SnapEx creates for normal use.

### Restore steps

1. Open the SnapEx Activity Bar view or Command Palette.
2. Run `SnapEx: Restore Extension from Zip`.
3. Select the backup zip to restore.
4. Review the confirmation prompt.
5. Confirm the restore if you want SnapEx to overwrite the current installed extension state.
6. Reload VS Code when prompted.

During restore, SnapEx may overwrite:

- The installed extension directory.
- Captured global storage.
- Captured current-workspace storage.
- Captured contributed VS Code settings.
- Captured external state files under your home directory.

### Restore example: Continue

Assume you backed up Continue and have this file:

```text
vscode-extension-backup-Continue.continue-2.0.0_202607080405PM.zip
```

To restore it:

1. Run `SnapEx: Restore Extension from Zip`.
2. Select the Continue backup zip.
3. Confirm the overwrite prompt.
4. Reload VS Code.
5. Open Continue and verify that the extension loads.
6. Check whether expected configuration was restored, such as `~/.continue/config.yaml` when captured.

You may still need to sign back in or re-enter secrets if Continue or another extension depends on authentication tokens.

## Backup package examples

### Example 1: Continue backup

A Continue backup may be named:

```text
vscode-extension-backup-Continue.continue-2.0.0_202607080405PM.zip
```

Inside the final zip, you should expect a structure similar to:

```text
vscode-extension-backup-Continue.continue-2.0.0_202607080405PM/
  backup-index.json
  Continue.continue-2.0.0.zip
```

Inside `Continue.continue-2.0.0.zip`, you may see:

```text
manifest.json
extension/
configuration/configuration.json
globalStorage/
workspaceStorage/current/
externalState/home/.continue/config.yaml
metadata/external-state.json
metadata/extension-file-modes.json
```

The exact contents depend on what exists on your machine and which SnapEx settings are enabled.

### Example 2: extension with only VS Code settings

Some extensions do not have obvious external files or storage folders. Their nested archive may contain only:

```text
manifest.json
extension/
configuration/configuration.json
metadata/extension-file-modes.json
```

That can still be a valid and useful backup.

### Example 3: extension with no explicitly configured settings

If you never changed an extension's settings, `configuration/configuration.json` may be empty or may not contain many values. SnapEx backs up explicitly set values; it does not need to copy default values because the extension already contributes those defaults.

## Inspect a backup zip manually

You can inspect a backup without restoring it.

### List the final package contents

```bash
unzip -l vscode-extension-backup-Continue.continue-2.0.0_202607080405PM.zip
```

You should see a timestamped folder, `backup-index.json`, and a nested extension zip.

### Extract the final package

```bash
mkdir /tmp/snapex-check
unzip vscode-extension-backup-Continue.continue-2.0.0_202607080405PM.zip -d /tmp/snapex-check
```

### List the nested extension archive

```bash
unzip -l /tmp/snapex-check/vscode-extension-backup-Continue.continue-2.0.0_202607080405PM/Continue.continue-2.0.0.zip
```

### Check for Continue config.yaml

```bash
unzip -l /tmp/snapex-check/vscode-extension-backup-Continue.continue-2.0.0_202607080405PM/Continue.continue-2.0.0.zip | grep 'externalState/home/.continue/config.yaml'
```

If the file was captured, you should see an entry like:

```text
externalState/home/.continue/config.yaml
```

### Read the backup manifest

```bash
unzip -p /tmp/snapex-check/vscode-extension-backup-Continue.continue-2.0.0_202607080405PM/Continue.continue-2.0.0.zip manifest.json
```

The manifest helps identify the extension ID, version, original install folder, and captured archive sections.

## Settings

Open VS Code Settings and search for `SnapEx` or `extensionStateBackup`.

### `extensionStateBackup.defaultBackupLocation`

Optional absolute folder path where SnapEx writes backup packages.

When empty, SnapEx prompts you to choose a destination.

Example:

```text
/home/npepin/Backups/SnapEx
```

### `extensionStateBackup.includeBuiltIn`

Controls whether SnapEx includes built-in VS Code extensions.

Default:

```text
false
```

Usually leave this disabled. Built-in VS Code extensions are normally restored by VS Code itself.

### `extensionStateBackup.includeExtensionFiles`

Controls whether SnapEx includes each extension's installed files.

Default:

```text
true
```

Leave this enabled if you want to restore the extension version that was installed at backup time.

### `extensionStateBackup.includeCurrentWorkspaceStorage`

Controls whether SnapEx includes storage for the currently open workspace.

Default:

```text
true
```

Only the current workspace is captured. Other workspace storage folders are not scanned.

### `extensionStateBackup.confirmBeforeRestore`

Controls whether SnapEx asks before overwriting files, storage, external state, or settings during restore.

Default:

```text
true
```

Leave this enabled unless you are testing repeated restores and understand the risk.

## Recommended workflows

### Before updating an important extension

1. Run `SnapEx: Backup Selected Extension`.
2. Select the extension you plan to update.
3. Confirm the backup zip was created.
4. Update the extension normally in VS Code.
5. Test the extension.
6. If something breaks, run `SnapEx: Restore Extension from Zip` and select the backup.

### Before migrating to a new machine

1. Open VS Code on the old machine.
2. Run `SnapEx: Backup All Extensions`.
3. Copy the generated zip packages to the new machine.
4. Install SnapEx on the new machine.
5. Restore the most important extensions one by one.
6. Reload VS Code after restore prompts.
7. Sign back in to accounts and re-enter secrets where required.

### Before experimenting with AI coding extensions

1. Back up the extension first, such as Continue or another AI assistant extension.
2. Confirm any expected external config files are in the backup.
3. Make your changes.
4. Test carefully.
5. Restore the backup if configuration or state becomes unstable.

### Periodic safety backup

1. Set `extensionStateBackup.defaultBackupLocation` to a stable backup folder.
2. Run `SnapEx: Backup All Extensions` periodically.
3. Keep several dated backup sets.
4. Delete old backups only after confirming newer ones restore successfully.

## Troubleshooting

### SnapEx is installed but I do not see the Activity Bar icon

Try these steps:

1. Reload VS Code.
2. Open the Command Palette and run `Developer: Reload Window`.
3. Check that SnapEx is installed:

   ```bash
   code --list-extensions --show-versions | grep '^local-tools.snapex@'
   ```

4. Open the Command Palette and search for `SnapEx`.
5. If commands exist but the icon is hidden, right-click the Activity Bar and confirm SnapEx is enabled.

### Installing from VSIX does not appear to update SnapEx

Run the update script:

```bash
cd ~/Projects/snapex
bash update-extension.sh
```

The script uses `code --install-extension ... --force`, which is more reliable for local VSIX reinstall testing than manually selecting the VSIX in the UI.

### VS Code Git Sync reports divergent branches

If your local `main` has diverged from GitHub and you want to match the remote repository exactly, run:

```bash
cd ~/Projects/snapex
bash update-extension.sh --reset-to-origin
```

This discards local-only commits and resets your checkout to `origin/main` before rebuilding and reinstalling SnapEx.

### A backup zip was created, but an expected config file is missing

Check whether that file is one SnapEx can currently identify and capture.

For Continue, check for:

```text
externalState/home/.continue/config.yaml
```

Use:

```bash
unzip -l vscode-extension-backup-Continue.continue-2.0.0_202607080405PM.zip
```

Then inspect the nested zip:

```bash
unzip -l Continue.continue-2.0.0.zip
```

Some extensions store configuration in locations that are not declared in their VS Code manifest. SnapEx cannot infer every custom path with complete reliability.

### Restore fails on Windows because files are locked

Close extra VS Code windows and retry the restore. If an extension is active, Windows may prevent overwriting files that are still in use.

### Restored extension still asks me to sign in

This is expected for many extensions. SnapEx does not back up SecretStorage, OS keychain entries, or authentication sessions. Sign in again through the extension's normal flow.

### The restored extension version is different from the Marketplace version

SnapEx restores the extension files captured in the backup when `extensionStateBackup.includeExtensionFiles` was enabled. This is useful when you intentionally want to roll back to the backed-up version.

If you want the latest Marketplace version instead, install or update that extension normally through VS Code after restoring any configuration you need.

## Developer and testing notes

### Run the regression suite

```bash
npm test
```

This compiles the TypeScript extension and runs the regression suite.

### Run the regression suite directly

```bash
npm run test:regression
```

### Run the older smoke test

```bash
npm run test:smoke
```

### Package the VSIX manually

```bash
npm run package
```

This creates a file named like:

```text
snapex-0.1.4.vsix
```

The exact version follows the current `package.json` version.

### Install the packaged VSIX manually

```bash
code --install-extension snapex-0.1.4.vsix --force
```

Reload VS Code after installing.

## Practical safety notes

- Keep backup zips in a safe folder, especially if they contain extension configuration files.
- Do not share backup zips publicly unless you have inspected them for secrets or sensitive paths.
- Test restore with a non-critical extension before relying on SnapEx for important migrations.
- Keep multiple backups when experimenting with extension updates or configuration changes.
- Remember that backups are machine- and environment-sensitive; paths, OS behavior, and extension storage formats can vary.
