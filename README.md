# Extension State Backup

A local VS Code extension that creates one zip archive per installed extension. Each archive contains the extension files plus a best-effort snapshot of that extension's configuration and storage folders.

## Commands

Open the Command Palette and run one of these commands:

- `Extension State Backup: Backup All Extensions`
- `Extension State Backup: Backup Selected Extension`
- `Extension State Backup: Restore Extension from Zip`
- `Extension State Backup: Open Backup Folder`

## What each zip contains

Each extension backup is written as a separate `.zip` file and contains:

- `manifest.json` with the extension id, version, original install folder, source environment, and archive contents.
- `extension/` with the installed extension files, when `extensionStateBackup.includeExtensionFiles` is enabled.
- `configuration/configuration.json` with explicitly set global, workspace, and workspace-folder values for configuration keys contributed by that extension.
- `globalStorage/` with the extension's per-extension global storage folder, when present.
- `workspaceStorage/current/` with the extension's storage folder for the currently open workspace, when present.
- `metadata/extension-file-modes.json` with executable/file mode metadata so restored extension files can keep Unix permissions when possible.

## What cannot be fully backed up

VS Code does not expose every private state location of other extensions through the public API. This extension therefore cannot export or restore:

- SecretStorage values, passwords, auth tokens, or OS keychain entries.
- Authentication sessions managed by VS Code or by the operating system.
- Every private Memento/globalState record if an extension stores it in VS Code's shared internal state database instead of in its own `globalStorage` folder.
- Workspace storage for workspaces that are not open during the backup run.

The archive is still useful for restoring the installed extension files, contributed user/workspace settings, and storage folders that are visible to the extension host.

## Settings

- `extensionStateBackup.defaultBackupLocation`: Optional absolute folder path where backup runs are written.
- `extensionStateBackup.includeBuiltIn`: Include built-in VS Code extensions. Disabled by default.
- `extensionStateBackup.includeExtensionFiles`: Include the installed extension directory. Enabled by default.
- `extensionStateBackup.includeCurrentWorkspaceStorage`: Include storage for the currently open workspace. Enabled by default.
- `extensionStateBackup.confirmBeforeRestore`: Ask before overwriting files/settings/storage during restore. Enabled by default.

## Install locally

From this project folder:

```bash
npm install
npm run compile
npm run package
```

Then install the generated `.vsix` file:

```bash
code --install-extension extension-state-backup-0.1.0.vsix --force
```

Reload VS Code after installation.

## Development

```bash
npm install
npm run compile
```

Press `F5` in VS Code to launch an Extension Development Host.

## Restore behavior

When restoring a backup zip, the extension:

1. Reads `manifest.json` to identify the target extension.
2. Removes the currently installed extension directory if that extension already exists.
3. Extracts the backed-up `extension/` files into the extension install folder.
4. Restores captured `globalStorage/` and current-workspace storage folders.
5. Restores captured contributed settings.
6. Prompts you to reload the VS Code window.

Restoring an active extension can fail on locked files, especially on Windows. Closing extra VS Code windows and retrying usually helps.
