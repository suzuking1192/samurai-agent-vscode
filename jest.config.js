// Jest configuration with separate projects for unit vs integration tests
// Integration tests (*.integration.test.ts) run serially to avoid port conflicts
module.exports = {
  projects: [
    // Unit tests - run in parallel (default)
    {
      displayName: 'unit',
      preset: 'ts-jest',
      testEnvironment: 'node',
      roots: ['<rootDir>/src', '<rootDir>/tests'],
      testMatch: [
        '**/__tests__/**/*.test.ts',
        '**/__tests__/**/*.test.js',
        '**/?(*.)+(spec|test).ts',
        '**/tests/**/*.test.js'
      ],
      testPathIgnorePatterns: [
        '\\.integration\\.test\\.ts$',
        '\\.production\\.integration\\.test\\.ts$'
      ],
      transform: {
        '^.+\\.ts$': ['ts-jest', { tsconfig: { module: 'commonjs' } }],
      },
      transformIgnorePatterns: [
        'node_modules/(?!(.*\\.mjs$))'
      ],
      setupFilesAfterEnv: ['<rootDir>/src/__tests__/setup.ts'],
      moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/src/$1',
        '^vscode$': '<rootDir>/src/__tests__/__mocks__/vscode.js',
        '^(.*)\\.js$': '$1'
      }
    },
    // Integration tests - run serially to avoid debug port conflicts
    {
      displayName: 'integration',
      preset: 'ts-jest',
      testEnvironment: 'node',
      roots: ['<rootDir>/src', '<rootDir>/tests'],
      testMatch: [
        '**/*.integration.test.ts',
        '**/*.production.integration.test.ts'
      ],
      transform: {
        '^.+\\.ts$': ['ts-jest', { tsconfig: { module: 'commonjs' } }],
      },
      transformIgnorePatterns: [
        'node_modules/(?!(.*\\.mjs$))'
      ],
      setupFilesAfterEnv: ['<rootDir>/src/__tests__/setup.ts'],
      // Run integration tests serially to avoid port conflicts
      maxWorkers: 1,
      moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/src/$1',
        '^vscode$': '<rootDir>/src/__tests__/__mocks__/vscode.js',
        '^(.*)\\.js$': '$1'
      }
    }
  ],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/__tests__/**',
    '!src/**/*.test.ts',
    '!src/**/*.spec.ts'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  verbose: true
};