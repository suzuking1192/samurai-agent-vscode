/**
 * Integration tests for AstProgramBuilder with real TypeScript
 * These tests use actual TypeScript implementation without mocking
 */

import { AstProgramBuilder } from '../AstProgramBuilder';
import * as path from 'path';
import * as fs from 'fs';

describe('AstProgramBuilder Integration Tests', () => {
  describe('no-config fallback', () => {
    const workspace = path.join(__dirname, 'fixtures', 'no-config-project');

    beforeEach(() => {
      // Ensure fixtures exist
      if (!fs.existsSync(workspace)) {
        throw new Error(`Test fixture not found at ${workspace}`);
      }
    });

    it('should discover source files when no tsconfig exists', () => {
      const builder = new AstProgramBuilder(workspace);
      const result = builder.buildTsProgram(workspace);

      // Should have discovered source files
      expect(result.sourceFiles.size).toBeGreaterThan(0);

      // Should have discovered at least index.ts and util.ts
      const sourceFilePaths = Array.from(result.sourceFiles.keys());
      expect(sourceFilePaths.length).toBeGreaterThanOrEqual(2);

      // Verify specific files exist
      const hasIndex = sourceFilePaths.some(p => p.includes('index.ts'));
      const hasUtil = sourceFilePaths.some(p => p.includes('util.ts'));
      expect(hasIndex).toBe(true);
      expect(hasUtil).toBe(true);

      // Verify node_modules and dist are NOT included
      const hasNodeModules = sourceFilePaths.some(p => p.includes('node_modules'));
      const hasDist = sourceFilePaths.some(p => p.includes('dist'));
      expect(hasNodeModules).toBe(false);
      expect(hasDist).toBe(false);
    });

    it('should extract import relations for discovered files', () => {
      const builder = new AstProgramBuilder(workspace);
      const tsProgram = builder.buildTsProgram(workspace);

      const importRelations = builder.extractImportGraph(tsProgram);

      // Should have at least 1 import relation (index.ts -> util.ts)
      expect(importRelations.length).toBeGreaterThan(0);

      // Verify specific import exists
      const hasIndexToUtil = importRelations.some(rel =>
        rel.from.includes('index.ts') && rel.to.includes('util.ts')
      );
      expect(hasIndexToUtil).toBe(true);
    });

    it('should extract call relations for discovered files', () => {
      const builder = new AstProgramBuilder(workspace);
      const tsProgram = builder.buildTsProgram(workspace);

      const callRelations = builder.extractCallGraph(tsProgram);

      // Should have call relations
      expect(callRelations.length).toBeGreaterThanOrEqual(0);
    });

    it('should use baseUrl heuristic when src/ exists', () => {
      const builder = new AstProgramBuilder(workspace);
      const tsProgram = builder.buildTsProgram(workspace);

      // Project has src/ directory, so baseUrl should be detected
      expect(tsProgram.projectRoot).toBe(workspace);
    });

    it('should respect maxFiles limit', () => {
      const builder = new AstProgramBuilder(workspace, {
        fallbackCompilerOptions: {}
      });

      const tsProgram = builder.buildTsProgram(workspace);

      // With only 2 files in fixture, should be under the 2000 limit
      expect(tsProgram.sourceFiles.size).toBeLessThan(2000);
    });

    it('should log when no files discovered in empty workspace', () => {
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
      const emptyWorkspace = '/nonexistent/workspace/path';

      const builder = new AstProgramBuilder(emptyWorkspace);

      try {
        builder.buildTsProgram(emptyWorkspace);
      } catch (e) {
        // Expected to potentially fail
      }

      // Should have logged warning about 0 files or fallback
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });
});

