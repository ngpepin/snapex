const assert = require('assert');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const Module = require('module');
const AdmZip = require('adm-zip');

const compiledExtensionPath = path.join(process.cwd(), 'out', 'extension.js');
const continueConfigFixturePath = path.join(process.cwd(), 'test', 'Continue-config.yaml');

const tests = [
  ['backup-all packages a final zip, captures restorable state, and restores from outer and nested zips', testBackupAllAndRestore],
  ['backup-selected backs up only the picked extension and respects disabled extension files', testBackupSelected],
  ['restore cancellation leaves installed files, storage, external state, and settings untouched', testRestoreCancellation],
  ['restore rejects archive entries that attempt to escape the target directory', testRejectsPathTraversalArchive],
  ['restore can recover external state from older archives without external-state metadata', testExternalStateMetadataFallback],
  ['open backup folder reveals either configured or fallback backup locations', testOpenBackupFolder]
];

async function testBackupAllAndRestore() {
  await withHarness({}, async (harness) => {
    assert(harness.registered.has('extensionStateBackup.backupAll'));
    assert(harness.registered.has('extensionStateBackup.backupSelected'));
    assert(harness.registered.has('extensionStateBackup.restoreFromZip'));
    assert(harness.registered.has('extensionStateBackup.openBackupFolder'));

    await harness.registered.get('extensionStateBackup.backupAll')();

    const packageNames = await fs.readdir(harness.backupRoot);
    assert.deepStrictEqual(packageNames.length, 1, 'built-in extensions should be excluded by default');
    assert.match(
      packageNames[0],
      /^vscode-extension-backup-Continue\.continue-2\.0\.0_\d{12}(AM|PM)\.zip$/,
      `Unexpected backup package name: ${packageNames[0]}`
    );

    const finalArchivePath = path.join(harness.backupRoot, packageNames[0]);
    const backupPackageBaseName = packageNames[0].replace(/\.zip$/, '');
    await assert.rejects(
      () => fs.stat(path.join(harness.backupRoot, backupPackageBaseName)),
      (error) => error && error.code === 'ENOENT',
      'the temporary staging folder should be deleted after the final package zip is written'
    );

    const nestedArchivePath = await assertValidContinuePackage(finalArchivePath, backupPackageBaseName, harness.continueConfig);

    await overwriteContinueState(harness, 'stale installed content', 'stale continue config');
    harness.enqueueOpenDialog(finalArchivePath);
    await harness.registered.get('extensionStateBackup.restoreFromZip')();
    await assertContinueStateRestored(harness);
    assertSettingsReplayed(harness.updatedSettings);

    await overwriteContinueState(harness, 'stale direct nested content', 'stale direct nested config');
    harness.enqueueOpenDialog(nestedArchivePath);
    await harness.registered.get('extensionStateBackup.restoreFromZip')();
    await assertContinueStateRestored(harness);
  });
}

async function testBackupSelected() {
  await withHarness(
    {
      settings: { includeExtensionFiles: false },
      extensions: ({ extRoot }) => [
        createContinueExtension(path.join(extRoot, 'continue.continue-2.0.0-linux-x64')),
        createMockExtension({
          id: 'Other.tool',
          publisher: 'Other',
          name: 'tool',
          version: '1.2.3',
          displayName: 'Other Tool',
          extensionPath: path.join(extRoot, 'other.tool-1.2.3')
        }),
        createMockExtension({
          id: 'Builtin.sample',
          publisher: 'Builtin',
          name: 'sample',
          version: '9.9.9',
          displayName: 'Built-in Sample',
          extensionPath: path.join(extRoot, 'builtin.sample-9.9.9'),
          isBuiltin: true
        })
      ],
      quickPick: (items) => {
        assert(items.some((item) => item.extension.id === 'Continue.continue'));
        assert(items.some((item) => item.extension.id === 'Other.tool'));
        assert(!items.some((item) => item.extension.id === 'Builtin.sample'), 'built-in extensions should not be selectable by default');
        return items.find((item) => item.extension.id === 'Other.tool');
      }
    },
    async (harness) => {
      await fs.mkdir(path.join(harness.extRoot, 'other.tool-1.2.3', 'nested'), { recursive: true });
      await fs.writeFile(path.join(harness.extRoot, 'other.tool-1.2.3', 'nested', 'ignored.txt'), 'should not be archived');

      await harness.registered.get('extensionStateBackup.backupSelected')();

      const packageNames = await fs.readdir(harness.backupRoot);
      assert.deepStrictEqual(packageNames.length, 1);
      assert.match(packageNames[0], /^vscode-extension-backup-Other\.tool-1\.2\.3_\d{12}(AM|PM)\.zip$/);

      const outerZip = new AdmZip(path.join(harness.backupRoot, packageNames[0]));
      const baseName = packageNames[0].replace(/\.zip$/, '');
      const nestedEntry = outerZip.getEntry(`${baseName}/Other.tool-1.2.3.zip`);
      assert(nestedEntry, 'selected extension package should contain the selected nested archive');

      const nestedZip = new AdmZip(nestedEntry.getData());
      const entryNames = nestedZip.getEntries().map((entry) => entry.entryName);
      assert(entryNames.includes('manifest.json'));
      assert(entryNames.includes('configuration/configuration.json'));
      assert(!entryNames.some((entryName) => entryName.startsWith('extension/')), 'extension files should not be archived when disabled');

      const manifest = JSON.parse(nestedZip.getEntry('manifest.json').getData().toString('utf8'));
      assert.strictEqual(manifest.extension.id, 'Other.tool');
      assert.strictEqual(manifest.contents.extensionFiles, false);
    }
  );
}

async function testRestoreCancellation() {
  await withHarness({ warningResponses: [undefined] }, async (harness) => {
    await harness.registered.get('extensionStateBackup.backupAll')();
    const [packageName] = await fs.readdir(harness.backupRoot);
    const finalArchivePath = path.join(harness.backupRoot, packageName);

    await overwriteContinueState(harness, 'cancelled stale content', 'cancelled stale config');
    harness.enqueueOpenDialog(finalArchivePath);
    await harness.registered.get('extensionStateBackup.restoreFromZip')();

    assert.strictEqual(await fs.readFile(harness.continueFeaturePath, 'utf8'), 'cancelled stale content');
    assert.strictEqual(await fs.readFile(harness.continueConfigPath, 'utf8'), 'cancelled stale config');
    assert.deepStrictEqual(harness.updatedSettings, []);
  });
}

async function testRejectsPathTraversalArchive() {
  await withHarness({}, async (harness) => {
    const maliciousZipPath = path.join(harness.root, 'malicious.zip');
    const zip = new AdmZip();
    zip.addFile('manifest.json', Buffer.from(JSON.stringify({
      schemaVersion: 2,
      createdAt: new Date().toISOString(),
      source: {
        appName: 'Mock VS Code',
        appRoot: harness.root,
        uiKind: 'Desktop',
        platform: process.platform,
        arch: process.arch,
        homeDir: harness.fakeHome
      },
      extension: {
        id: 'Evil.extension',
        directoryName: 'evil.extension-1.0.0',
        version: '1.0.0',
        isBuiltin: false,
        extensionPath: path.join(harness.extRoot, 'evil.extension-1.0.0')
      },
      contents: {
        extensionFiles: true,
        configuration: false,
        globalStorage: false,
        currentWorkspaceStorage: false,
        externalState: false
      },
      notes: []
    }, null, 2)));
    zip.addFile('extension/../escape.txt', Buffer.from('escaped'));
    zip.writeZip(maliciousZipPath);

    harness.enqueueOpenDialog(maliciousZipPath);
    await assert.rejects(
      () => harness.registered.get('extensionStateBackup.restoreFromZip')(),
      /Archive entry escapes the target directory/
    );
    await assert.rejects(() => fs.stat(path.join(harness.extRoot, 'escape.txt')), (error) => error && error.code === 'ENOENT');
  });
}

async function testExternalStateMetadataFallback() {
  await withHarness({}, async (harness) => {
    const legacyZipPath = path.join(harness.root, 'legacy-without-external-metadata.zip');
    const restoredConfig = 'name: restored-from-legacy\nversion: 1\n';
    const zip = new AdmZip();
    zip.addFile('manifest.json', Buffer.from(JSON.stringify({
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      source: {
        appName: 'Mock VS Code',
        appRoot: harness.root,
        uiKind: 'Desktop',
        platform: process.platform,
        arch: process.arch,
        homeDir: harness.fakeHome
      },
      extension: {
        id: 'Continue.continue',
        directoryName: 'continue.continue-2.0.0-linux-x64',
        version: '2.0.0',
        isBuiltin: false,
        extensionPath: harness.sampleExt
      },
      contents: {
        extensionFiles: false,
        configuration: false,
        globalStorage: false,
        currentWorkspaceStorage: false,
        externalState: true
      },
      notes: []
    }, null, 2)));
    zip.addFile('externalState/home/.continue/config.yaml', Buffer.from(restoredConfig, 'utf8'));
    zip.writeZip(legacyZipPath);

    await fs.writeFile(harness.continueConfigPath, 'before legacy restore', 'utf8');
    harness.enqueueOpenDialog(legacyZipPath);
    await harness.registered.get('extensionStateBackup.restoreFromZip')();

    assert.strictEqual(await fs.readFile(harness.continueConfigPath, 'utf8'), restoredConfig);
  });
}

async function testOpenBackupFolder() {
  await withHarness({}, async (harness) => {
    await harness.registered.get('extensionStateBackup.openBackupFolder')();
    assert(harness.executedCommands.some((command) => command.id === 'revealFileInOS' && command.args[0].fsPath === harness.backupRoot));
  });

  await withHarness({ settings: { defaultBackupLocation: '' } }, async (harness) => {
    await harness.registered.get('extensionStateBackup.openBackupFolder')();
    const fallback = path.join(harness.selfGlobalStorage, 'backups');
    assert(harness.executedCommands.some((command) => command.id === 'revealFileInOS' && command.args[0].fsPath === fallback));
    const stat = await fs.stat(fallback);
    assert(stat.isDirectory());
  });
}

async function withHarness(options, callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'snapex-regression-'));
  const backupRoot = path.join(root, 'backups');
  const extRoot = path.join(root, 'extensions');
  const sampleExt = path.join(extRoot, 'continue.continue-2.0.0-linux-x64');
  const globalStorageRoot = path.join(root, 'globalStorage');
  const workspaceStorageRoot = path.join(root, 'workspaceStorage');
  const fakeHome = path.join(root, 'home');
  const continueConfigPath = path.join(fakeHome, '.continue', 'config.yaml');
  const continueFeaturePath = path.join(sampleExt, 'nested', 'feature.txt');
  const selfGlobalStorage = path.join(globalStorageRoot, 'local-tools.snapex');
  const selfWorkspaceStorage = path.join(workspaceStorageRoot, 'local-tools.snapex');
  const continueConfig = await fs.readFile(continueConfigFixturePath, 'utf8');

  const registered = new Map();
  const updatedSettings = [];
  const executedCommands = [];
  const openDialogResponses = [];
  const warningResponses = Array.isArray(options.warningResponses) ? [...options.warningResponses] : ['Restore'];

  process.env.SNAPEX_TEST_HOME = fakeHome;

  await createBaseFixture({
    sampleExt,
    continueFeaturePath,
    globalStorageRoot,
    workspaceStorageRoot,
    continueConfigPath,
    continueConfig,
    selfGlobalStorage,
    selfWorkspaceStorage
  });

  const extensionFactory = options.extensions || (({ extRoot }) => [
    createContinueExtension(path.join(extRoot, 'continue.continue-2.0.0-linux-x64')),
    createMockExtension({
      id: 'Builtin.theme',
      publisher: 'Builtin',
      name: 'theme',
      version: '1.0.0',
      displayName: 'Built-in Theme',
      extensionPath: path.join(extRoot, 'builtin.theme-1.0.0'),
      isBuiltin: true
    })
  ]);
  const extensions = extensionFactory({ root, extRoot });

  const settings = {
    defaultBackupLocation: backupRoot,
    includeBuiltIn: false,
    includeExtensionFiles: true,
    includeCurrentWorkspaceStorage: true,
    confirmBeforeRestore: true,
    ...(options.settings || {})
  };

  const configurationInspections = options.configurationInspections || {
    'continue.enableConsole': {
      globalValue: true,
      workspaceValue: false,
      workspaceFolderValue: true
    },
    'continue.enableQuickActions': {
      globalValue: true
    }
  };

  const fakeVscode = {
    UIKind: { Desktop: 1, Web: 2 },
    ExtensionMode: { Production: 1, Development: 2, Test: 3 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    Uri: { file: (fsPath) => ({ fsPath, toString: () => `file://${fsPath}` }) },
    env: { appName: 'Mock VS Code', appRoot: path.join(root, 'app'), uiKind: 1, remoteName: undefined },
    extensions: {
      all: extensions,
      getExtension: (id) => extensions.find((extension) => extension.id === id)
    },
    workspace: {
      workspaceFile: { fsPath: path.join(root, 'workspace.code-workspace') },
      workspaceFolders: [{ name: 'Fixture', uri: { fsPath: path.join(root, 'workspace'), toString: () => `file://${path.join(root, 'workspace')}` } }],
      getConfiguration: (section, scope) => ({
        get: (key, fallback) => section === 'extensionStateBackup' ? settings[key] ?? fallback : fallback,
        inspect: (key) => inspectConfiguration(configurationInspections, key, scope),
        update: async (key, value, target) => updatedSettings.push({ key, value, target, scope: scope?.fsPath })
      })
    },
    commands: {
      registerCommand: (id, callback) => {
        registered.set(id, callback);
        return { dispose() {} };
      },
      executeCommand: async (id, ...args) => {
        executedCommands.push({ id, args });
        return undefined;
      }
    },
    window: {
      showInformationMessage: async () => undefined,
      showWarningMessage: async () => (warningResponses.length > 0 ? warningResponses.shift() : 'Restore'),
      showOpenDialog: async () => openDialogResponses.shift() || [],
      showQuickPick: async (items) => options.quickPick ? options.quickPick(items) : items[0],
      withProgress: async (_options, task) => task({ report() {} })
    },
    ProgressLocation: { Notification: 15 }
  };

  const originalLoad = Module._load;
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

    await callback({
      root,
      backupRoot,
      extRoot,
      sampleExt,
      globalStorageRoot,
      workspaceStorageRoot,
      fakeHome,
      continueConfigPath,
      continueFeaturePath,
      continueConfig,
      selfGlobalStorage,
      selfWorkspaceStorage,
      registered,
      updatedSettings,
      executedCommands,
      enqueueOpenDialog: (fsPath) => openDialogResponses.push([{ fsPath }])
    });
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve(compiledExtensionPath)];
    delete process.env.SNAPEX_TEST_HOME;
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function createBaseFixture(paths) {
  await fs.mkdir(path.join(paths.sampleExt, 'nested'), { recursive: true });
  await fs.writeFile(paths.continueFeaturePath, 'original extension content');
  await fs.mkdir(path.join(paths.globalStorageRoot, 'continue.continue'), { recursive: true });
  await fs.writeFile(path.join(paths.globalStorageRoot, 'continue.continue', 'state.json'), JSON.stringify({ global: true }));
  await fs.mkdir(path.join(paths.workspaceStorageRoot, 'continue.continue'), { recursive: true });
  await fs.writeFile(path.join(paths.workspaceStorageRoot, 'continue.continue', 'workspace.json'), JSON.stringify({ workspace: true }));
  await fs.mkdir(path.dirname(paths.continueConfigPath), { recursive: true });
  await fs.writeFile(paths.continueConfigPath, paths.continueConfig, 'utf8');
  await fs.mkdir(paths.selfGlobalStorage, { recursive: true });
  await fs.mkdir(paths.selfWorkspaceStorage, { recursive: true });
}

function createContinueExtension(extensionPath) {
  return createMockExtension({
    id: 'Continue.continue',
    publisher: 'Continue',
    name: 'continue',
    version: '2.0.0',
    displayName: 'Continue - open-source AI code agent',
    extensionPath,
    contributesConfiguration: {
      'continue.enableConsole': { type: 'boolean' },
      'continue.enableQuickActions': { type: 'boolean' }
    }
  });
}

function createMockExtension({ id, publisher, name, version, displayName, extensionPath, isBuiltin = false, contributesConfiguration = {} }) {
  return {
    id,
    extensionPath,
    packageJSON: {
      displayName,
      version,
      publisher,
      name,
      isBuiltin,
      contributes: {
        configuration: {
          properties: contributesConfiguration
        }
      }
    }
  };
}

function inspectConfiguration(configurationInspections, key, scope) {
  const record = configurationInspections[key];
  if (!record) {
    return undefined;
  }

  if (scope) {
    return Object.prototype.hasOwnProperty.call(record, 'workspaceFolderValue')
      ? { workspaceFolderValue: record.workspaceFolderValue }
      : undefined;
  }

  return {
    globalValue: record.globalValue,
    workspaceValue: record.workspaceValue
  };
}

async function assertValidContinuePackage(finalArchivePath, backupPackageBaseName, continueConfig) {
  const outerZip = new AdmZip(finalArchivePath);
  const outerEntryNames = outerZip.getEntries().map((entry) => entry.entryName);
  const nestedArchiveEntryName = `${backupPackageBaseName}/Continue.continue-2.0.0.zip`;

  assert(outerEntryNames.includes(`${backupPackageBaseName}/backup-index.json`), 'final package should include backup-index.json');
  assert(outerEntryNames.includes(nestedArchiveEntryName), 'final package should include the nested extension archive');

  const backupIndex = JSON.parse(outerZip.getEntry(`${backupPackageBaseName}/backup-index.json`).getData().toString('utf8'));
  assert.deepStrictEqual(backupIndex.archives, ['Continue.continue-2.0.0.zip']);

  const nestedArchiveEntry = outerZip.getEntry(nestedArchiveEntryName);
  const nestedArchivePath = path.join(path.dirname(finalArchivePath), 'nested-Continue.continue-2.0.0.zip');
  await fs.writeFile(nestedArchivePath, nestedArchiveEntry.getData());

  const zip = new AdmZip(nestedArchiveEntry.getData());
  const entryNames = zip.getEntries().map((entry) => entry.entryName);

  for (const expectedEntry of [
    'manifest.json',
    'configuration/configuration.json',
    'extension/nested/feature.txt',
    'globalStorage/state.json',
    'workspaceStorage/current/workspace.json',
    'externalState/home/.continue/config.yaml',
    'metadata/external-state.json',
    'metadata/extension-file-modes.json'
  ]) {
    assert(entryNames.includes(expectedEntry), `Missing archive entry: ${expectedEntry}`);
  }

  assert.strictEqual(zip.getEntry('externalState/home/.continue/config.yaml').getData().toString('utf8'), continueConfig);

  const manifest = JSON.parse(zip.getEntry('manifest.json').getData().toString('utf8'));
  assert.strictEqual(manifest.extension.id, 'Continue.continue');
  assert.strictEqual(manifest.extension.version, '2.0.0');
  assert.strictEqual(manifest.contents.extensionFiles, true);
  assert.strictEqual(manifest.contents.configuration, true);
  assert.strictEqual(manifest.contents.globalStorage, true);
  assert.strictEqual(manifest.contents.currentWorkspaceStorage, true);
  assert.strictEqual(manifest.contents.externalState, true);

  const externalStateMetadata = JSON.parse(zip.getEntry('metadata/external-state.json').getData().toString('utf8'));
  assert.strictEqual(externalStateMetadata[0].archivePath, 'externalState/home/.continue/config.yaml');
  assert.strictEqual(externalStateMetadata[0].homeRelativePath, '.continue/config.yaml');

  return nestedArchivePath;
}

async function overwriteContinueState(harness, extensionContent, configContent) {
  await fs.writeFile(harness.continueFeaturePath, extensionContent, 'utf8');
  await fs.writeFile(path.join(harness.globalStorageRoot, 'continue.continue', 'state.json'), JSON.stringify({ global: false }));
  await fs.writeFile(path.join(harness.workspaceStorageRoot, 'continue.continue', 'workspace.json'), JSON.stringify({ workspace: false }));
  await fs.writeFile(harness.continueConfigPath, configContent, 'utf8');
}

async function assertContinueStateRestored(harness) {
  assert.strictEqual(await fs.readFile(harness.continueFeaturePath, 'utf8'), 'original extension content');
  assert.deepStrictEqual(JSON.parse(await fs.readFile(path.join(harness.globalStorageRoot, 'continue.continue', 'state.json'), 'utf8')), { global: true });
  assert.deepStrictEqual(JSON.parse(await fs.readFile(path.join(harness.workspaceStorageRoot, 'continue.continue', 'workspace.json'), 'utf8')), { workspace: true });
  assert.strictEqual(await fs.readFile(harness.continueConfigPath, 'utf8'), harness.continueConfig);
}

function assertSettingsReplayed(updatedSettings) {
  assert(updatedSettings.some((entry) => entry.key === 'continue.enableConsole' && entry.value === true && entry.target === 1));
  assert(updatedSettings.some((entry) => entry.key === 'continue.enableConsole' && entry.value === false && entry.target === 2));
  assert(updatedSettings.some((entry) => entry.key === 'continue.enableConsole' && entry.value === true && entry.target === 3));
  assert(updatedSettings.some((entry) => entry.key === 'continue.enableQuickActions' && entry.value === true && entry.target === 1));
}

async function main() {
  let passed = 0;

  for (const [name, test] of tests) {
    process.stdout.write(`- ${name} ... `);
    await test();
    passed += 1;
    process.stdout.write('passed\n');
  }

  console.log(`\nRegression test suite passed: ${passed}/${tests.length} tests.`);
}

main().catch((error) => {
  console.error('\nRegression test suite failed.');
  console.error(error);
  process.exitCode = 1;
});
