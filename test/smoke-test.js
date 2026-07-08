const assert = require('assert');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const Module = require('module');
const AdmZip = require('adm-zip');

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-state-backup-test-'));
  const backupRoot = path.join(root, 'backups');
  const extRoot = path.join(root, 'extensions');
  const sampleExt = path.join(extRoot, 'publisher.sample-1.0.0');
  const globalStorageRoot = path.join(root, 'globalStorage');
  const workspaceStorageRoot = path.join(root, 'workspaceStorage');
  const selfGlobalStorage = path.join(globalStorageRoot, 'local-tools.extension-state-backup');
  const selfWorkspaceStorage = path.join(workspaceStorageRoot, 'local-tools.extension-state-backup');

  await fs.mkdir(path.join(sampleExt, 'nested'), { recursive: true });
  await fs.writeFile(path.join(sampleExt, 'nested', 'feature.txt'), 'original extension content');
  await fs.mkdir(path.join(globalStorageRoot, 'publisher.sample'), { recursive: true });
  await fs.writeFile(path.join(globalStorageRoot, 'publisher.sample', 'state.json'), JSON.stringify({ global: true }));
  await fs.mkdir(path.join(workspaceStorageRoot, 'publisher.sample'), { recursive: true });
  await fs.writeFile(path.join(workspaceStorageRoot, 'publisher.sample', 'workspace.json'), JSON.stringify({ workspace: true }));
  await fs.mkdir(selfGlobalStorage, { recursive: true });
  await fs.mkdir(selfWorkspaceStorage, { recursive: true });

  const sampleExtension = {
    id: 'publisher.sample',
    extensionPath: sampleExt,
    packageJSON: {
      displayName: 'Sample Extension',
      version: '1.0.0',
      publisher: 'publisher',
      name: 'sample',
      isBuiltin: false,
      contributes: {
        configuration: {
          properties: {
            'sample.enabled': { type: 'boolean' },
            'sample.message': { type: 'string' }
          }
        }
      }
    }
  };

  const registered = new Map();
  const updatedSettings = [];
  let nextOpenDialog = [];

  const fakeVscode = {
    UIKind: { Desktop: 1, Web: 2 },
    ExtensionMode: { Production: 1, Development: 2, Test: 3 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    Uri: { file: (fsPath) => ({ fsPath, toString: () => `file://${fsPath}` }) },
    env: { appName: 'Mock VS Code', appRoot: path.join(root, 'app'), uiKind: 1, remoteName: undefined },
    extensions: {
      all: [sampleExtension],
      getExtension: (id) => id === 'publisher.sample' ? sampleExtension : undefined
    },
    workspace: {
      workspaceFile: { fsPath: path.join(root, 'workspace.code-workspace') },
      workspaceFolders: [{ name: 'Fixture', uri: { fsPath: path.join(root, 'workspace'), toString: () => `file://${path.join(root, 'workspace')}` } }],
      getConfiguration: (section, scope) => ({
        get: (key, fallback) => {
          if (section === 'extensionStateBackup') {
            return {
              defaultBackupLocation: backupRoot,
              includeBuiltIn: false,
              includeExtensionFiles: true,
              includeCurrentWorkspaceStorage: true,
              confirmBeforeRestore: true
            }[key] ?? fallback;
          }
          return fallback;
        },
        inspect: (key) => {
          if (key === 'sample.enabled') {
            return { globalValue: true, workspaceValue: false, workspaceFolderValue: scope ? true : undefined };
          }
          if (key === 'sample.message') {
            return { globalValue: 'hello' };
          }
          return undefined;
        },
        update: async (key, value, target) => updatedSettings.push({ key, value, target })
      })
    },
    commands: {
      registerCommand: (id, callback) => {
        registered.set(id, callback);
        return { dispose() {} };
      },
      executeCommand: async () => undefined
    },
    window: {
      showInformationMessage: async () => undefined,
      showWarningMessage: async () => 'Restore',
      showOpenDialog: async () => nextOpenDialog,
      showQuickPick: async (items) => items[0],
      withProgress: async (_options, task) => task({ report() {} })
    },
    ProgressLocation: { Notification: 15 }
  };

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'vscode') {
      return fakeVscode;
    }
    return originalLoad.apply(this, arguments);
  };

  const extensionModule = require(path.join(process.cwd(), 'out', 'extension.js'));
  extensionModule.activate({
    subscriptions: [],
    globalStorageUri: { fsPath: selfGlobalStorage },
    storageUri: { fsPath: selfWorkspaceStorage },
    extensionPath: process.cwd(),
    extensionMode: fakeVscode.ExtensionMode.Production
  });

  assert(registered.has('extensionStateBackup.backupAll'));
  assert(registered.has('extensionStateBackup.restoreFromZip'));

  await registered.get('extensionStateBackup.backupAll')();
  const runDir = path.join(backupRoot, (await fs.readdir(backupRoot))[0]);
  const archivePath = path.join(runDir, 'publisher.sample-1.0.0.zip');
  const zip = new AdmZip(archivePath);
  const entryNames = zip.getEntries().map((entry) => entry.entryName);

  for (const expectedEntry of [
    'manifest.json',
    'configuration/configuration.json',
    'extension/nested/feature.txt',
    'globalStorage/state.json',
    'workspaceStorage/current/workspace.json'
  ]) {
    assert(entryNames.includes(expectedEntry), `Missing archive entry: ${expectedEntry}`);
  }

  const manifest = JSON.parse(zip.getEntry('manifest.json').getData().toString('utf8'));
  assert.strictEqual(manifest.extension.id, 'publisher.sample');
  assert.strictEqual(manifest.contents.extensionFiles, true);
  assert.strictEqual(manifest.contents.globalStorage, true);
  assert.strictEqual(manifest.contents.currentWorkspaceStorage, true);

  await fs.writeFile(path.join(sampleExt, 'nested', 'feature.txt'), 'stale installed content');
  await fs.writeFile(path.join(globalStorageRoot, 'publisher.sample', 'state.json'), JSON.stringify({ global: false }));
  await fs.writeFile(path.join(workspaceStorageRoot, 'publisher.sample', 'workspace.json'), JSON.stringify({ workspace: false }));

  nextOpenDialog = [{ fsPath: archivePath }];
  await registered.get('extensionStateBackup.restoreFromZip')();

  assert.strictEqual(await fs.readFile(path.join(sampleExt, 'nested', 'feature.txt'), 'utf8'), 'original extension content');
  assert.deepStrictEqual(JSON.parse(await fs.readFile(path.join(globalStorageRoot, 'publisher.sample', 'state.json'), 'utf8')), { global: true });
  assert.deepStrictEqual(JSON.parse(await fs.readFile(path.join(workspaceStorageRoot, 'publisher.sample', 'workspace.json'), 'utf8')), { workspace: true });
  assert(updatedSettings.some((entry) => entry.key === 'sample.enabled' && entry.value === true && entry.target === fakeVscode.ConfigurationTarget.Global));
  assert(updatedSettings.some((entry) => entry.key === 'sample.enabled' && entry.value === false && entry.target === fakeVscode.ConfigurationTarget.Workspace));
  assert(updatedSettings.some((entry) => entry.key === 'sample.enabled' && entry.value === true && entry.target === fakeVscode.ConfigurationTarget.WorkspaceFolder));
  assert(updatedSettings.some((entry) => entry.key === 'sample.message' && entry.value === 'hello' && entry.target === fakeVscode.ConfigurationTarget.Global));

  console.log(`Smoke test passed: ${path.basename(archivePath)} contained ${entryNames.length} entries and restore replayed ${updatedSettings.length} settings.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
