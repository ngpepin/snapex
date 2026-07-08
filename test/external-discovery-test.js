const assert = require('assert');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const Module = require('module');
const AdmZip = require('adm-zip');

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'snapex-external-discovery-'));
  const backupRoot = path.join(root, 'backups');
  const extRoot = path.join(root, 'extensions');
  const extensionPath = path.join(extRoot, 'acme.generic-tool-1.0.0');
  const globalStorageRoot = path.join(root, 'globalStorage');
  const workspaceStorageRoot = path.join(root, 'workspaceStorage');
  const selfGlobalStorage = path.join(globalStorageRoot, 'local-tools.snapex');
  const selfWorkspaceStorage = path.join(workspaceStorageRoot, 'local-tools.snapex');
  const fakeHome = path.join(root, 'home');
  const hiddenConfigPath = path.join(fakeHome, '.generic-tool', 'config.json');
  const hiddenStatePath = path.join(fakeHome, '.generic-tool', 'state', 'session.json');
  const ignoredCachePath = path.join(fakeHome, '.generic-tool', 'cache', 'ignored.txt');
  const xdgConfigPath = path.join(fakeHome, '.config', 'generic-tool', 'settings.yaml');
  const updatedSettings = [];
  const registered = new Map();
  const openDialogResponses = [];

  process.env.SNAPEX_TEST_HOME = fakeHome;

  try {
    await fs.mkdir(path.join(extensionPath, 'nested'), { recursive: true });
    await fs.writeFile(path.join(extensionPath, 'nested', 'feature.txt'), 'original generic extension content', 'utf8');
    await fs.mkdir(path.dirname(hiddenConfigPath), { recursive: true });
    await fs.mkdir(path.dirname(hiddenStatePath), { recursive: true });
    await fs.mkdir(path.dirname(ignoredCachePath), { recursive: true });
    await fs.mkdir(path.dirname(xdgConfigPath), { recursive: true });
    await fs.mkdir(selfGlobalStorage, { recursive: true });
    await fs.mkdir(selfWorkspaceStorage, { recursive: true });
    await fs.writeFile(hiddenConfigPath, '{"theme":"generic"}\n', 'utf8');
    await fs.writeFile(hiddenStatePath, '{"session":"saved"}\n', 'utf8');
    await fs.writeFile(ignoredCachePath, 'cache should not be archived', 'utf8');
    await fs.writeFile(xdgConfigPath, 'enabled: true\n', 'utf8');

    const genericExtension = {
      id: 'Acme.generic-tool',
      extensionPath,
      packageJSON: {
        displayName: 'Generic Tool',
        version: '1.0.0',
        publisher: 'Acme',
        name: 'generic-tool',
        isBuiltin: false,
        repository: {
          type: 'git',
          url: 'https://github.com/acme/generic-tool.git'
        },
        contributes: {
          configuration: {
            properties: {
              'genericTool.enabled': { type: 'boolean' }
            }
          }
        }
      }
    };

    const fakeVscode = {
      UIKind: { Desktop: 1, Web: 2 },
      ExtensionMode: { Production: 1, Development: 2, Test: 3 },
      ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
      Uri: { file: (fsPath) => ({ fsPath, toString: () => `file://${fsPath}` }) },
      env: { appName: 'Mock VS Code', appRoot: path.join(root, 'app'), uiKind: 1, remoteName: undefined },
      extensions: {
        all: [genericExtension],
        getExtension: (id) => id === genericExtension.id ? genericExtension : undefined
      },
      workspace: {
        workspaceFile: undefined,
        workspaceFolders: [],
        getConfiguration: (section) => ({
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
          inspect: (key) => key === 'genericTool.enabled' ? { globalValue: true } : undefined,
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
        showOpenDialog: async () => openDialogResponses.shift() || [],
        showQuickPick: async (items) => items[0],
        withProgress: async (_options, task) => task({ report() {} })
      },
      ProgressLocation: { Notification: 15 }
    };

    const originalLoad = Module._load;
    const compiledExtensionPath = path.join(process.cwd(), 'out', 'extension.js');
    delete require.cache[require.resolve(compiledExtensionPath)];
    Module._load = function patchedLoad(request, parent, isMain) {
      if (request === 'vscode') {
        return fakeVscode;
      }
      return originalLoad.apply(this, arguments);
    };

    try {
      const extensionModule = require(compiledExtensionPath);
      extensionModule.activate({
        subscriptions: [],
        globalStorageUri: { fsPath: selfGlobalStorage },
        storageUri: { fsPath: selfWorkspaceStorage },
        extensionPath: process.cwd(),
        extensionMode: fakeVscode.ExtensionMode.Production
      });

      await registered.get('extensionStateBackup.backupAll')();
    } finally {
      Module._load = originalLoad;
      delete require.cache[require.resolve(compiledExtensionPath)];
    }

    const [packageName] = await fs.readdir(backupRoot);
    assert.match(packageName, /^vscode-extension-backup-Acme\.generic-tool-1\.0\.0_\d{12}(AM|PM)\.zip$/);

    const outerZip = new AdmZip(path.join(backupRoot, packageName));
    const baseName = packageName.replace(/\.zip$/, '');
    const nestedEntry = outerZip.getEntry(`${baseName}/Acme.generic-tool-1.0.0.zip`);
    assert(nestedEntry, 'final package should contain the generic extension nested zip');

    const nestedZip = new AdmZip(nestedEntry.getData());
    const entryNames = nestedZip.getEntries().map((entry) => entry.entryName);

    for (const expectedEntry of [
      'externalState/home/.generic-tool/config.json',
      'externalState/home/.generic-tool/state/session.json',
      'externalState/home/.config/generic-tool/settings.yaml',
      'metadata/external-state.json'
    ]) {
      assert(entryNames.includes(expectedEntry), `Missing generalized external-state entry: ${expectedEntry}`);
    }

    assert(
      !entryNames.includes('externalState/home/.generic-tool/cache/ignored.txt'),
      'cache directories should be skipped during generalized external-state discovery'
    );

    const metadata = JSON.parse(nestedZip.getEntry('metadata/external-state.json').getData().toString('utf8'));
    assert(metadata.some((record) => record.homeRelativePath === '.generic-tool/config.json' && record.discoveredBy.includes('generic-tool')));
    assert(metadata.some((record) => record.homeRelativePath === '.config/generic-tool/settings.yaml' && record.discoveredBy.includes('generic-tool')));

    await fs.writeFile(hiddenConfigPath, '{"theme":"stale"}\n', 'utf8');
    await fs.writeFile(hiddenStatePath, '{"session":"stale"}\n', 'utf8');
    await fs.writeFile(xdgConfigPath, 'enabled: false\n', 'utf8');
    openDialogResponses.push([{ fsPath: path.join(backupRoot, packageName) }]);

    const originalLoad = Module._load;
    const compiledExtensionPath = path.join(process.cwd(), 'out', 'extension.js');
    delete require.cache[require.resolve(compiledExtensionPath)];
    Module._load = function patchedLoad(request, parent, isMain) {
      if (request === 'vscode') {
        return fakeVscode;
      }
      return originalLoad.apply(this, arguments);
    };

    try {
      const extensionModule = require(compiledExtensionPath);
      extensionModule.activate({
        subscriptions: [],
        globalStorageUri: { fsPath: selfGlobalStorage },
        storageUri: { fsPath: selfWorkspaceStorage },
        extensionPath: process.cwd(),
        extensionMode: fakeVscode.ExtensionMode.Production
      });

      await registered.get('extensionStateBackup.restoreFromZip')();
    } finally {
      Module._load = originalLoad;
      delete require.cache[require.resolve(compiledExtensionPath)];
    }

    assert.strictEqual(await fs.readFile(hiddenConfigPath, 'utf8'), '{"theme":"generic"}\n');
    assert.strictEqual(await fs.readFile(hiddenStatePath, 'utf8'), '{"session":"saved"}\n');
    assert.strictEqual(await fs.readFile(xdgConfigPath, 'utf8'), 'enabled: true\n');
    assert(updatedSettings.some((entry) => entry.key === 'genericTool.enabled' && entry.value === true && entry.target === fakeVscode.ConfigurationTarget.Global));

    console.log('Generalized external-state discovery regression test passed.');
  } finally {
    delete process.env.SNAPEX_TEST_HOME;
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
