/**
 * Tests for AstProgramBuilder
 */

import { AstProgramBuilder } from '../../../src/agent/tools/debugging/AstProgramBuilder';

// Mock fs module
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  readdirSync: jest.fn(),
  statSync: jest.fn()
}));

describe('AstProgramBuilder', () => {
  let astBuilder: AstProgramBuilder;
  let mockFs: any;

  beforeEach(() => {
    astBuilder = new AstProgramBuilder('/test/workspace');
    mockFs = require('fs');
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('buildTsProgram', () => {
    it('should create TypeScript program when tsconfig exists', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: {
            '@/*': ['./src/*']
          }
        }
      }));

      const program = astBuilder.buildTsProgram('/test/workspace');

      expect(program).toBeDefined();
      expect(program.projectRoot).toBe('/test/workspace');
      expect(program.tsconfigPaths).toEqual({
        '@/*': '/test/workspace/src/*'
      });
    });

    it('should create minimal program when tsconfig does not exist', () => {
      mockFs.existsSync.mockReturnValue(false);

      const program = astBuilder.buildTsProgram('/test/workspace');

      expect(program).toBeDefined();
      expect(program.projectRoot).toBe('/test/workspace');
      expect(program.tsconfigPaths).toEqual({});
    });

    it('should cache programs', () => {
      mockFs.existsSync.mockReturnValue(false);

      const program1 = astBuilder.buildTsProgram('/test/workspace');
      const program2 = astBuilder.buildTsProgram('/test/workspace');

      expect(program1).toBe(program2); // Same reference due to caching
    });
  });

  describe('extractImportGraph', () => {
    it('should extract import relations from TypeScript program', () => {
      mockFs.existsSync.mockReturnValue(false);

      const program = astBuilder.buildTsProgram('/test/workspace');
      const relations = astBuilder.extractImportGraph(program);

      expect(Array.isArray(relations)).toBe(true);
    });
  });

  describe('extractCallGraph', () => {
    it('should extract call relations from TypeScript program', () => {
      mockFs.existsSync.mockReturnValue(false);

      const program = astBuilder.buildTsProgram('/test/workspace');
      const relations = astBuilder.extractCallGraph(program);

      expect(Array.isArray(relations)).toBe(true);
    });
  });

  describe('clearCache', () => {
    it('should clear program cache', () => {
      astBuilder.clearCache();
      // Cache is internal, so we test by ensuring no errors are thrown
      expect(() => astBuilder.clearCache()).not.toThrow();
    });
  });
});
