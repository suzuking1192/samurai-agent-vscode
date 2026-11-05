// Test setup file for VS Code extension
import { jest } from '@jest/globals';

// Mock console methods to reduce noise in tests
global.console = {
  ...console,
  log: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

// VS Code API is mocked in __mocks__/vscode.js

// Set test environment variables
process.env.NODE_ENV = 'test';

// Global test timeout
jest.setTimeout(10000);
