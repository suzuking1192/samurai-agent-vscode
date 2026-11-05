// Unified VS Code mock used across all test roots.
const path = require('path');

const makeUri = (targetPath) => {
  const resolved = path.resolve(targetPath);
  return {
    fsPath: resolved,
    toString: () => resolved,
  };
};

const FileType = {
  Unknown: 0,
  File: 1,
  Directory: 2,
  SymbolicLink: 64,
};

const workspace = {
  workspaceFolders: undefined,
  getConfiguration: jest.fn().mockReturnValue({
    get: jest.fn().mockReturnValue(true),
  }),
  fs: {
    readFile: jest.fn(),
    stat: jest.fn(),
    readDirectory: jest.fn(),
  },
};

const env = { appName: 'Unknown' };

module.exports = {
  env,
  FileType,
  Uri: {
    file: jest.fn((targetPath) => makeUri(targetPath)),
    joinPath: jest.fn((base, ...segments) => {
      const basePath = typeof base === 'string' ? base : base.fsPath;
      return makeUri(path.join(basePath, ...segments));
    }),
    parse: jest.fn((targetPath) => makeUri(targetPath)),
  },
  workspace,
  window: {
    showInformationMessage: jest.fn(),
    showErrorMessage: jest.fn(),
    showWarningMessage: jest.fn(),
  },
  commands: {
    registerCommand: jest.fn(),
  },
  WebviewViewProvider: class MockWebviewViewProvider {},
  CancellationToken: class MockCancellationToken {},
  ExtensionContext: jest.fn(),
  version: '1.80.0',
};
