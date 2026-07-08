const assert = require('assert');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const Module = require('module');
const AdmZip = require('adm-zip');

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'snapex-test-'));
  const backupRoot = path.join(root, 'backups');
  const extRoot = path.join(root, 'extensions');
  const sampleExt = path.join(extRoot, 'continue.continue-2.0.0-linux-x64');
  const globalStorageRoot = path.join(root, 'globalStorage');
  const workspaceStorageRoot = path.join(root, 'workspaceStorage');
  const fakeHome = path.join(root, 'home');
  const continueConfigPath = path.join(fakeHome, '.continue', 'config.yaml');
  const selfGlobalStorage = path.join(globalStorageRoot, 'local-tools.snapex');
  const selfWorkspaceStorage = path.join(workspaceStorageRoot, 'local-tools.snapex');

  process.env.SNAPEX_TEST_HOME = fakeHome;

  await fs.mkdir(path.join(sampleExt, 'nested'), { recursive: true });
  await fs.writeFile(path.join(sampleExt, 'nested', 'feature.txt'), 'original extension content');
  await fs.mkdir(path.join(globalStorageRoot, 'continue.continue'), { recursive: true });
  await fs.writeFile(path.join(globalStorageRoot, 'continue.continue', 'state.json'), JSON.stringify({ global: true }));
  await fs.mkdir(path.join(workspaceStorageRoot, 'continue.continue'), { recursive: true });
  await fs.writeFile(path.join(workspaceStorageRoot, 'continue.continue', 'workspace.json'), JSON.stringify({ workspace: true }));
  await fs.mkdir(path.dirname(continueConfigPath), { recursive: true });
  const continueConfig = await fs.readFile(path.join(process.cwd(), 'test', 'Continue-config.yaml'), 'utf8');
  await fs.writeFile(continueConfigPath, continueConfig, 'utf8');
  await fs.mkdir(selfGlobalStorage, { recursive: true });
  await fs.mkdir(selfWorkspaceStorage, { recursive: true });

  const continueExtension = {
    id: 'Continue.continue',
    extensionPath: sampleExt,
    packageJSON: {
      displayName: 'Continue - open-source AI code agent',
      version: '2.0.0',
      publisher: 'Continue',
      name: 'continue',
      isBuiltin: false,
      contributes: {
        configuration: {
          properties: {
            'continue.enableConsole': { type: 'boolean' },
            'continue.enableQuickActions': { type: 'boolean' }
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
      all: [continueExtension],
      getExtension: (id) => id === 'Continue.continue' ? continueExtension : undefined
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
          if (key === 'continue.enableConsole') {
            return { globalValue: true, workspaceValue: false, workspaceFolderValue: scope ? true : undefined };
          }
          if (key === 'continue.enableQuickActions') {
            return { globalValue: true };
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
  const archivePath = path.join(runDir, 'Continue.continue-2.0.0.zip');
  const zip = new AdmZip(archivePath);
  const entryNames = zip.getEntries().map((entry) => entry.entryName);

  for (const expectedEntry of [
    'manifest.json',
    'configuration/configuration.json',
    'extension/nested/feature.txt',
    'globalStorage/state.json',
    'workspaceStorage/current/workspace.json',
    'externalState/home/.continue/config.yaml',
    'metadata/external-state.json'
  ]) {
    assert(entryNames.includes(expectedEntry), `Missing archive entry: ${expectedEntry}`);
  }

  assert.strictEqual(zip.getEntry('externalState/home/.continue/config.yaml').getData().toString('utf8'), continueConfig);

  const manifest = JSON.parse(zip.getEntry('manifest.json').getData().toString('utf8'));
  assert.strictEqual(manifest.extension.id, 'Continue.continue');
  assert.strictEqual(manifest.contents.extensionFiles, true);
  assert.strictEqual(manifest.contents.globalStorage, true);
  assert.strictEqual(manifest.contents.currentWorkspaceStorage, true);
  assert.strictEqual(manifest.contents.externalState, true);

  await fs.writeFile(path.join(sampleExt, 'nested', 'feature.txt'), 'stale installed content');
  await fs.writeFile(path.join(globalStorageRoot, 'continue.continue', 'state.json'), JSON.stringify({ global: false }));
  await fs.writeFile(path.join(workspaceStorageRoot, 'continue.continue', 'workspace.json'), JSON.stringify({ workspace: false }));
  await fs.writeFile(continueConfigPath, 'stale continue config', 'utf8');

  nextOpenDialog = [{ fsPath: archivePath }];
  await registered.get('extensionStateBackup.restoreFromZip')();

  assert.strictEqual(await fs.readFile(path.join(sampleExt, 'nested', 'feature.txt'), 'utf8'), 'original extension content');
  assert.deepStrictEqual(JSON.parse(await fs.readFile(path.join(globalStorageRoot, 'continue.continue', 'state.json'), 'utf8')), { global: true });
  assert.deepStrictEqual(JSON.parse(await fs.readFile(path.join(workspaceStorageRoot, 'continue.continue', 'workspace.json'), 'utf8')), { workspace: true });
  assert.strictEqual(await fs.readFile(continueConfigPath, 'utf8'), continueConfig);
  assert(updatedSettings.some((entry) => entry.key === 'continue.enableConsole' && entry.value === true && entry.target === fakeVscode.ConfigurationTarget.Global));
  assert(updatedSettings.some((entry) => entry.key === 'continue.enableConsole' && entry.value === false && entry.target === fakeVscode.ConfigurationTarget.Workspace));
  assert(updatedSettings.some((entry) => entry.key === 'continue.enableConsole' && entry.value === true && entry.target === fakeVscode.ConfigurationTarget.WorkspaceFolder));
  assert(updatedSettings.some((entry) => entry.key === 'continue.enableQuickActions' && entry.value === true && entry.target === fakeVscode.ConfigurationTarget.Global));

  console.log(`Smoke test passed: ${path.basename(archivePath)} contained ${entryNames.length} entries and restore replayed ${updatedSettings.length} settings.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
