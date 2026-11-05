// Mock vscode module for standalone tests
module.exports = {
  workspace: {
    workspaceFolders: [{
      uri: {
        fsPath: process.cwd()
      }
    }],
    fs: {
      readDirectory: async () => [],
      readFile: async () => Buffer.from(''),
      stat: async () => ({ type: 1, size: 0, mtime: 0, ctime: 0 })
    }
  },
  Uri: {
    file: (path) => ({ fsPath: path }),
    parse: (path) => ({ fsPath: path })
  },
  FileType: {
    File: 1,
    Directory: 2
  },
  window: {
    showErrorMessage: () => {}
  }
};
