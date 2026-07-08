import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import AdmZip from 'adm-zip';

const SELF_EXTENSION_IDS = new Set(['local-tools.snapex', 'local-tools.extension-state-backup']);
const BACKUP_SCHEMA_VERSION = 2;
const MIN_SUPPORTED_BACKUP_SCHEMA_VERSION = 1;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface ExtensionBackupSettings {
  defaultBackupLocation: string;
  includeBuiltIn: boolean;
  includeExtensionFiles: boolean;
  includeCurrentWorkspaceStorage: boolean;
  confirmBeforeRestore: boolean;
}

interface ConfigurationRecord {
  key: string;
  globalValue?: JsonValue;
  workspaceValue?: JsonValue;
  workspaceFolderValues?: Array<{
    workspaceFolderName: string;
    workspaceFolderUri: string;
    value: JsonValue;
  }>;
}

interface ConfigurationSnapshot {
  contributedKeys: string[];
  records: ConfigurationRecord[];
}

interface FileModeRecord {
  relativePath: string;
  mode: number;
}

interface ExternalStateRecord {
  archivePath: string;
  homeRelativePath: string;
  sourcePath: string;
  mode?: number;
}

interface BackupManifest {
  schemaVersion: number;
  createdAt: string;
  source: {
    appName: string;
    appRoot: string;
    remoteName?: string;
    uiKind: string;
    platform: NodeJS.Platform;
    arch: string;
    homeDir: string;
  };
  extension: {
    id: string;
    directoryName: string;
    version: string;
    displayName?: string;
    publisher?: string;
    name?: string;
    isBuiltin: boolean;
    extensionKind?: string[];
    extensionPath: string;
  };
  contents: {
    extensionFiles: boolean;
    configuration: boolean;
    globalStorage: boolean;
    currentWorkspaceStorage: boolean;
    externalState?: boolean;
  };
  notes: string[];
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('extensionStateBackup.backupAll', () => backupAllExtensions(context)),
    vscode.commands.registerCommand('extensionStateBackup.backupSelected', () => backupSelectedExtension(context)),
    vscode.commands.registerCommand('extensionStateBackup.restoreFromZip', () => restoreFromZip(context)),
    vscode.commands.registerCommand('extensionStateBackup.openBackupFolder', () => openBackupFolder(context))
  );
}

export function deactivate(): void {
  // No background resources to clean up.
}

async function backupAllExtensions(context: vscode.ExtensionContext): Promise<void> {
  const settings = getSettings();
  const extensions = getBackupCandidates(settings.includeBuiltIn);

  if (extensions.length === 0) {
    vscode.window.showInformationMessage('No extensions matched the current backup settings.');
    return;
  }

  const runDirectory = await chooseBackupRunDirectory(settings);
  if (!runDirectory) {
    return;
  }

  await withBackupProgress(`Backing up ${extensions.length} extensions`, async (progress) => {
    const archives: string[] = [];

    for (let index = 0; index < extensions.length; index += 1) {
      const extension = extensions[index];
      progress.report({
        message: `${extension.id} (${index + 1}/${extensions.length})`,
        increment: index === 0 ? 0 : 100 / extensions.length
      });

      const archivePath = await createExtensionBackup(context, extension, runDirectory, settings);
      archives.push(archivePath);
    }

    await writeBackupIndex(runDirectory, archives);
  });

  const open = await vscode.window.showInformationMessage(
    `Backed up ${extensions.length} extensions to ${runDirectory}.`,
    'Open Folder'
  );
  if (open === 'Open Folder') {
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(runDirectory));
  }
}

async function backupSelectedExtension(context: vscode.ExtensionContext): Promise<void> {
  const settings = getSettings();
  const candidates = getBackupCandidates(settings.includeBuiltIn);
  const picked = await vscode.window.showQuickPick(
    candidates.map((extension) => ({
      label: extension.packageJSON?.displayName || extension.id,
      description: `${extension.id}@${extension.packageJSON?.version ?? 'unknown'}`,
      detail: extension.extensionPath,
      extension
    })),
    { title: 'Choose an extension to back up' }
  );

  if (!picked) {
    return;
  }

  const runDirectory = await chooseBackupRunDirectory(settings);
  if (!runDirectory) {
    return;
  }

  await withBackupProgress(`Backing up ${picked.extension.id}`, async () => {
    await createExtensionBackup(context, picked.extension, runDirectory, settings);
    await writeBackupIndex(runDirectory, [path.join(runDirectory, backupFileNameFor(picked.extension))]);
  });

  const open = await vscode.window.showInformationMessage(
    `Backed up ${picked.extension.id} to ${runDirectory}.`,
    'Open Folder'
  );
  if (open === 'Open Folder') {
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(runDirectory));
  }
}

async function restoreFromZip(context: vscode.ExtensionContext): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: { 'Zip archives': ['zip'] },
    openLabel: 'Restore this backup'
  });

  if (!picked?.[0]) {
    return;
  }

  const zipPath = picked[0].fsPath;
  const zip = new AdmZip(zipPath);
  const manifest = readManifest(zip);
  const settings = getSettings();

  if (settings.confirmBeforeRestore) {
    const answer = await vscode.window.showWarningMessage(
      `Restore ${manifest.extension.id}@${manifest.extension.version}? This can overwrite the installed extension, its captured configuration values, storage folders, and external state files.`,
      { modal: true },
      'Restore'
    );

    if (answer !== 'Restore') {
      return;
    }
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Restoring ${manifest.extension.id}`,
      cancellable: false
    },
    async (progress) => {
      progress.report({ message: 'Restoring extension files' });
      if (manifest.contents.extensionFiles) {
        await restoreExtensionFiles(context, zip, manifest);
      }

      progress.report({ message: 'Restoring global storage' });
      if (manifest.contents.globalStorage) {
        await restoreDirectoryFromArchive(zip, 'globalStorage/', path.join(getGlobalStorageRoot(context), manifest.extension.id.toLowerCase()));
      }

      progress.report({ message: 'Restoring workspace storage' });
      if (manifest.contents.currentWorkspaceStorage && context.storageUri) {
        await restoreDirectoryFromArchive(zip, 'workspaceStorage/current/', path.join(path.dirname(context.storageUri.fsPath), manifest.extension.id.toLowerCase()));
      }

      progress.report({ message: 'Restoring configuration values' });
      if (manifest.contents.configuration) {
        await restoreConfiguration(zip);
      }

      progress.report({ message: 'Restoring external state files' });
      if (manifest.contents.externalState) {
        await restoreExternalState(zip);
      }
    }
  );

  const reload = await vscode.window.showInformationMessage(
    `Restored ${manifest.extension.id}. Reload VS Code to activate restored files and state.`,
    'Reload Window'
  );
  if (reload === 'Reload Window') {
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}

async function openBackupFolder(context: vscode.ExtensionContext): Promise<void> {
  const settings = getSettings();
  const configuredPath = settings.defaultBackupLocation.trim();

  if (configuredPath) {
    await fs.mkdir(configuredPath, { recursive: true });
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(configuredPath));
    return;
  }

  const fallback = path.join(context.globalStorageUri.fsPath, 'backups');
  await fs.mkdir(fallback, { recursive: true });
  await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(fallback));
}

function getSettings(): ExtensionBackupSettings {
  const config = vscode.workspace.getConfiguration('extensionStateBackup');
  return {
    defaultBackupLocation: config.get<string>('defaultBackupLocation', ''),
    includeBuiltIn: config.get<boolean>('includeBuiltIn', false),
    includeExtensionFiles: config.get<boolean>('includeExtensionFiles', true),
    includeCurrentWorkspaceStorage: config.get<boolean>('includeCurrentWorkspaceStorage', true),
    confirmBeforeRestore: config.get<boolean>('confirmBeforeRestore', true)
  };
}

function getBackupCandidates(includeBuiltIn: boolean): vscode.Extension<unknown>[] {
  return vscode.extensions.all
    .filter((extension) => includeBuiltIn || !Boolean(extension.packageJSON?.isBuiltin))
    .filter((extension) => Boolean(extension.extensionPath))
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function chooseBackupRunDirectory(settings: ExtensionBackupSettings): Promise<string | undefined> {
  const timestamp = new Date().toISOString().replace(/[.:]/g, '-');
  const configuredPath = settings.defaultBackupLocation.trim();
  const baseDirectory = configuredPath || await promptForBackupDirectory();

  if (!baseDirectory) {
    return undefined;
  }

  const runDirectory = path.join(baseDirectory, `vscode-extension-backup-${timestamp}`);
  await fs.mkdir(runDirectory, { recursive: true });
  return runDirectory;
}

async function promptForBackupDirectory(): Promise<string | undefined> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Use this backup folder'
  });

  return picked?.[0]?.fsPath;
}

async function createExtensionBackup(
  context: vscode.ExtensionContext,
  extension: vscode.Extension<unknown>,
  runDirectory: string,
  settings: ExtensionBackupSettings
): Promise<string> {
  const zip = new AdmZip();
  const configurationSnapshot = collectConfigurationSnapshot(extension.packageJSON);
  const externalStateRecords = await collectExternalStateRecords(extension);
  const manifest = await buildManifest(context, extension, settings, externalStateRecords);

  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
  zip.addFile('configuration/configuration.json', Buffer.from(JSON.stringify(configurationSnapshot, null, 2), 'utf8'));

  if (settings.includeExtensionFiles) {
    zip.addLocalFolder(extension.extensionPath, 'extension');
    const fileModes = await collectFileModes(extension.extensionPath);
    zip.addFile('metadata/extension-file-modes.json', Buffer.from(JSON.stringify(fileModes, null, 2), 'utf8'));
  }

  const globalStoragePath = await firstExistingPath([
    path.join(getGlobalStorageRoot(context), extension.id),
    path.join(getGlobalStorageRoot(context), extension.id.toLowerCase())
  ]);
  if (globalStoragePath) {
    zip.addLocalFolder(globalStoragePath, 'globalStorage');
  }

  if (settings.includeCurrentWorkspaceStorage && context.storageUri) {
    const workspaceStorageRoot = path.dirname(context.storageUri.fsPath);
    const workspaceStoragePath = await firstExistingPath([
      path.join(workspaceStorageRoot, extension.id),
      path.join(workspaceStorageRoot, extension.id.toLowerCase())
    ]);

    if (workspaceStoragePath) {
      zip.addLocalFolder(workspaceStoragePath, 'workspaceStorage/current');
    }
  }

  if (externalStateRecords.length > 0) {
    await addExternalStateToZip(zip, externalStateRecords);
  }

  const archivePath = path.join(runDirectory, backupFileNameFor(extension));
  zip.writeZip(archivePath);
  return archivePath;
}

async function buildManifest(
  context: vscode.ExtensionContext,
  extension: vscode.Extension<unknown>,
  settings: ExtensionBackupSettings,
  externalStateRecords: ExternalStateRecord[]
): Promise<BackupManifest> {
  const hasGlobalStorage = Boolean(await firstExistingPath([
    path.join(getGlobalStorageRoot(context), extension.id),
    path.join(getGlobalStorageRoot(context), extension.id.toLowerCase())
  ]));
  const hasWorkspaceStorage = Boolean(settings.includeCurrentWorkspaceStorage && context.storageUri && await firstExistingPath([
    path.join(path.dirname(context.storageUri.fsPath), extension.id),
    path.join(path.dirname(context.storageUri.fsPath), extension.id.toLowerCase())
  ]));

  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    source: {
      appName: vscode.env.appName,
      appRoot: vscode.env.appRoot,
      remoteName: vscode.env.remoteName,
      uiKind: vscode.env.uiKind === vscode.UIKind.Desktop ? 'Desktop' : 'Web',
      platform: process.platform,
      arch: process.arch,
      homeDir: getHomeDir()
    },
    extension: {
      id: extension.id,
      directoryName: path.basename(extension.extensionPath),
      version: extension.packageJSON?.version ?? 'unknown',
      displayName: extension.packageJSON?.displayName,
      publisher: extension.packageJSON?.publisher,
      name: extension.packageJSON?.name,
      isBuiltin: Boolean(extension.packageJSON?.isBuiltin),
      extensionKind: Array.isArray(extension.packageJSON?.extensionKind) ? extension.packageJSON.extensionKind : undefined,
      extensionPath: extension.extensionPath
    },
    contents: {
      extensionFiles: settings.includeExtensionFiles,
      configuration: true,
      globalStorage: hasGlobalStorage,
      currentWorkspaceStorage: hasWorkspaceStorage,
      externalState: externalStateRecords.length > 0
    },
    notes: [
      'This backup includes installed extension files, contributed VS Code configuration values, selected external state files, per-extension globalStorage, and current-workspace storage when available.',
      'VS Code does not expose another extension\'s SecretStorage, OS keychain entries, authentication sessions, or all private Memento records through the public API, so those items are not included.',
      'Workspace storage is limited to the workspace open when the backup command ran.',
      'External state files are limited to known extension-owned config files under the user home directory, such as Continue\'s ~/.continue/config.yaml.'
    ]
  };
}

function collectConfigurationSnapshot(packageJson: Record<string, unknown>): ConfigurationSnapshot {
  const contributedKeys = getContributedConfigurationKeys(packageJson);
  const records: ConfigurationRecord[] = [];
  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];

  for (const key of contributedKeys) {
    const inspected = vscode.workspace.getConfiguration().inspect<JsonValue>(key);
    if (!inspected) {
      continue;
    }

    const record: ConfigurationRecord = { key };
    let hasValue = false;

    if (inspected.globalValue !== undefined) {
      record.globalValue = inspected.globalValue;
      hasValue = true;
    }

    if (inspected.workspaceValue !== undefined) {
      record.workspaceValue = inspected.workspaceValue;
      hasValue = true;
    }

    const workspaceFolderValues: ConfigurationRecord['workspaceFolderValues'] = [];
    for (const folder of workspaceFolders) {
      const folderInspection = vscode.workspace.getConfiguration(undefined, folder.uri).inspect<JsonValue>(key);
      if (folderInspection?.workspaceFolderValue !== undefined) {
        workspaceFolderValues.push({
          workspaceFolderName: folder.name,
          workspaceFolderUri: folder.uri.toString(),
          value: folderInspection.workspaceFolderValue
        });
      }
    }

    if (workspaceFolderValues.length > 0) {
      record.workspaceFolderValues = workspaceFolderValues;
      hasValue = true;
    }

    if (hasValue) {
      records.push(record);
    }
  }

  return { contributedKeys, records };
}

function getContributedConfigurationKeys(packageJson: Record<string, unknown>): string[] {
  const contributes = asRecord(packageJson.contributes);
  const configuration = contributes ? contributes.configuration : undefined;
  const keys = new Set<string>();

  const readConfigurationBlock = (block: unknown) => {
    const properties = asRecord(asRecord(block)?.properties);
    if (!properties) {
      return;
    }

    for (const key of Object.keys(properties)) {
      keys.add(key);
    }
  };

  if (Array.isArray(configuration)) {
    configuration.forEach(readConfigurationBlock);
  } else if (configuration) {
    readConfigurationBlock(configuration);
  }

  return [...keys].sort();
}

async function collectExternalStateRecords(extension: vscode.Extension<unknown>): Promise<ExternalStateRecord[]> {
  const records: ExternalStateRecord[] = [];

  for (const homeRelativePath of getKnownHomeRelativeExternalStatePaths(extension)) {
    const archiveRelativePath = normalizeHomeRelativePathForArchive(homeRelativePath);
    if (!archiveRelativePath) {
      continue;
    }

    const sourcePath = safeJoin(getHomeDir(), fromArchivePath(archiveRelativePath));

    try {
      const stat = await fs.stat(sourcePath);
      if (!stat.isFile()) {
        continue;
      }

      records.push({
        archivePath: `externalState/home/${archiveRelativePath}`,
        homeRelativePath: archiveRelativePath,
        sourcePath,
        mode: stat.mode & 0o777
      });
    } catch {
      // Missing external state files are normal.
    }
  }

  return records.sort((a, b) => a.archivePath.localeCompare(b.archivePath));
}

function getKnownHomeRelativeExternalStatePaths(extension: vscode.Extension<unknown>): string[] {
  if (extension.id.toLowerCase() === 'continue.continue') {
    return [
      '.continue/config.yaml'
    ];
  }

  return [];
}

async function addExternalStateToZip(zip: AdmZip, records: ExternalStateRecord[]): Promise<void> {
  for (const record of records) {
    zip.addFile(record.archivePath, await fs.readFile(record.sourcePath));
  }

  zip.addFile('metadata/external-state.json', Buffer.from(JSON.stringify(records, null, 2), 'utf8'));
}

async function restoreExternalState(zip: AdmZip): Promise<void> {
  const metadataEntry = zip.getEntry('metadata/external-state.json');
  const records = metadataEntry
    ? JSON.parse(metadataEntry.getData().toString('utf8')) as ExternalStateRecord[]
    : deriveExternalStateRecordsFromArchive(zip);

  for (const record of records) {
    if (!record.homeRelativePath || !record.archivePath) {
      continue;
    }

    const entry = zip.getEntry(record.archivePath);
    if (!entry || entry.isDirectory) {
      continue;
    }

    const targetPath = safeJoin(getHomeDir(), fromArchivePath(record.homeRelativePath));
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, entry.getData());

    if (typeof record.mode === 'number') {
      try {
        await fs.chmod(targetPath, record.mode);
      } catch {
        // Best effort: chmod may fail on Windows, read-only filesystems, or remote environments.
      }
    }
  }
}

function deriveExternalStateRecordsFromArchive(zip: AdmZip): ExternalStateRecord[] {
  const prefix = 'externalState/home/';
  return zip.getEntries()
    .filter((entry) => entry.entryName.startsWith(prefix) && !entry.isDirectory)
    .map((entry) => {
      const homeRelativePath = entry.entryName.slice(prefix.length);
      return {
        archivePath: entry.entryName,
        homeRelativePath,
        sourcePath: safeJoin(getHomeDir(), fromArchivePath(homeRelativePath))
      };
    });
}

async function restoreExtensionFiles(context: vscode.ExtensionContext, zip: AdmZip, manifest: BackupManifest): Promise<void> {
  const existing = vscode.extensions.getExtension(manifest.extension.id);
  const targetDirectory = existing?.extensionPath ?? path.join(await resolveExtensionsRoot(context), manifest.extension.directoryName);

  await removeDirectoryIfExists(targetDirectory);
  await fs.mkdir(targetDirectory, { recursive: true });
  await extractPrefix(zip, 'extension/', targetDirectory);
  await restoreFileModes(zip, targetDirectory);
}

async function restoreConfiguration(zip: AdmZip): Promise<void> {
  const entry = zip.getEntry('configuration/configuration.json');
  if (!entry) {
    return;
  }

  const snapshot = JSON.parse(entry.getData().toString('utf8')) as ConfigurationSnapshot;
  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];

  for (const record of snapshot.records ?? []) {
    if (Object.prototype.hasOwnProperty.call(record, 'globalValue')) {
      await vscode.workspace.getConfiguration().update(record.key, record.globalValue, vscode.ConfigurationTarget.Global);
    }

    if (Object.prototype.hasOwnProperty.call(record, 'workspaceValue') && vscode.workspace.workspaceFile) {
      await vscode.workspace.getConfiguration().update(record.key, record.workspaceValue, vscode.ConfigurationTarget.Workspace);
    }

    for (const folderRecord of record.workspaceFolderValues ?? []) {
      const folder = workspaceFolders.find((candidate) => candidate.uri.toString() === folderRecord.workspaceFolderUri)
        ?? workspaceFolders.find((candidate) => candidate.name === folderRecord.workspaceFolderName)
        ?? (workspaceFolders.length === 1 ? workspaceFolders[0] : undefined);

      if (folder) {
        await vscode.workspace.getConfiguration(undefined, folder.uri).update(
          record.key,
          folderRecord.value,
          vscode.ConfigurationTarget.WorkspaceFolder
        );
      }
    }
  }
}

async function restoreDirectoryFromArchive(zip: AdmZip, archivePrefix: string, targetDirectory: string): Promise<void> {
  const hasEntries = zip.getEntries().some((entry) => entry.entryName.startsWith(archivePrefix) && !entry.isDirectory);
  if (!hasEntries) {
    return;
  }

  await removeDirectoryIfExists(targetDirectory);
  await fs.mkdir(targetDirectory, { recursive: true });
  await extractPrefix(zip, archivePrefix, targetDirectory);
}

async function restoreFileModes(zip: AdmZip, targetDirectory: string): Promise<void> {
  const entry = zip.getEntry('metadata/extension-file-modes.json');
  if (!entry) {
    return;
  }

  const records = JSON.parse(entry.getData().toString('utf8')) as FileModeRecord[];
  await Promise.all(records.map(async (record) => {
    const filePath = safeJoin(targetDirectory, record.relativePath);
    try {
      await fs.chmod(filePath, record.mode);
    } catch {
      // Best effort: chmod may fail on Windows, read-only filesystems, or remote environments.
    }
  }));
}

async function extractPrefix(zip: AdmZip, archivePrefix: string, targetDirectory: string): Promise<void> {
  for (const entry of zip.getEntries()) {
    if (!entry.entryName.startsWith(archivePrefix)) {
      continue;
    }

    const relativePath = entry.entryName.slice(archivePrefix.length);
    if (!relativePath) {
      continue;
    }

    const targetPath = safeJoin(targetDirectory, relativePath);

    if (entry.isDirectory) {
      await fs.mkdir(targetPath, { recursive: true });
      continue;
    }

    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, entry.getData());
  }
}

function readManifest(zip: AdmZip): BackupManifest {
  const entry = zip.getEntry('manifest.json');
  if (!entry) {
    throw new Error('This zip does not contain a manifest.json backup manifest.');
  }

  const manifest = JSON.parse(entry.getData().toString('utf8')) as BackupManifest;
  if (!manifest.extension?.id || manifest.schemaVersion < MIN_SUPPORTED_BACKUP_SCHEMA_VERSION || manifest.schemaVersion > BACKUP_SCHEMA_VERSION) {
    throw new Error('This zip is not a supported SnapEx backup archive.');
  }

  return manifest;
}

async function resolveExtensionsRoot(context: vscode.ExtensionContext): Promise<string> {
  const installedExtension = vscode.extensions.all.find((extension) =>
    !extension.packageJSON?.isBuiltin &&
    !SELF_EXTENSION_IDS.has(extension.id.toLowerCase()) &&
    extension.extensionPath &&
    path.dirname(extension.extensionPath) !== path.dirname(context.extensionPath)
  );

  if (installedExtension) {
    return path.dirname(installedExtension.extensionPath);
  }

  if (context.extensionMode !== vscode.ExtensionMode.Development) {
    return path.dirname(context.extensionPath);
  }

  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Choose VS Code extensions folder',
    title: 'Choose the folder where VS Code stores user extensions'
  });

  if (!picked?.[0]) {
    throw new Error('No extensions folder was selected, so the restore was cancelled.');
  }

  return picked[0].fsPath;
}

function getGlobalStorageRoot(context: vscode.ExtensionContext): string {
  return path.dirname(context.globalStorageUri.fsPath);
}

function getHomeDir(): string {
  return process.env.SNAPEX_TEST_HOME || os.homedir();
}

async function collectFileModes(rootDirectory: string): Promise<FileModeRecord[]> {
  const records: FileModeRecord[] = [];

  async function walk(currentDirectory: string): Promise<void> {
    const entries = await fs.readdir(currentDirectory, { withFileTypes: true });

    for (const entry of entries) {
      const absolutePath = path.join(currentDirectory, entry.name);
      const relativePath = toArchivePath(path.relative(rootDirectory, absolutePath));

      if (entry.isDirectory()) {
        await walk(absolutePath);
      } else if (entry.isFile()) {
        const stat = await fs.stat(absolutePath);
        records.push({ relativePath, mode: stat.mode & 0o777 });
      }
    }
  }

  await walk(rootDirectory);
  return records;
}

async function writeBackupIndex(runDirectory: string, archives: string[]): Promise<void> {
  const index = {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    archives: archives.map((archivePath) => path.basename(archivePath))
  };

  await fs.writeFile(path.join(runDirectory, 'backup-index.json'), JSON.stringify(index, null, 2), 'utf8');
}

async function firstExistingPath(paths: string[]): Promise<string | undefined> {
  for (const candidate of paths) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) {
        return candidate;
      }
    } catch {
      // Try the next candidate.
    }
  }

  return undefined;
}

async function removeDirectoryIfExists(directoryPath: string): Promise<void> {
  try {
    await fs.rm(directoryPath, { recursive: true, force: true });
  } catch (error) {
    throw new Error(`Could not remove ${directoryPath}: ${String(error)}`);
  }
}

function backupFileNameFor(extension: vscode.Extension<unknown>): string {
  const version = extension.packageJSON?.version ?? 'unknown';
  return `${safeFileName(extension.id)}-${safeFileName(version)}.zip`;
}

function safeFileName(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, '_');
}

function safeJoin(rootDirectory: string, relativePath: string): string {
  const targetPath = path.resolve(rootDirectory, relativePath);
  const rootPath = path.resolve(rootDirectory);

  if (targetPath !== rootPath && !targetPath.startsWith(rootPath + path.sep)) {
    throw new Error(`Archive entry escapes the target directory: ${relativePath}`);
  }

  return targetPath;
}

function normalizeHomeRelativePathForArchive(relativePath: string): string | undefined {
  if (path.isAbsolute(relativePath)) {
    return undefined;
  }

  const parts = relativePath.split(/[\\/]+/).filter(Boolean);
  if (parts.length === 0 || parts.some((part) => part === '..')) {
    return undefined;
  }

  return parts.join('/');
}

function fromArchivePath(filePath: string): string {
  return filePath.split('/').join(path.sep);
}

function toArchivePath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return undefined;
}

async function withBackupProgress<T>(title: string, task: (progress: vscode.Progress<{ message?: string; increment?: number }>) => Thenable<T> | T): Promise<T> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title,
      cancellable: false
    },
    (progress) => Promise.resolve(task(progress))
  );
}
