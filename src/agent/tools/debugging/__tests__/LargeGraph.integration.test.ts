import * as path from 'path';
import * as fs from 'fs';
import { AstProgramBuilder } from '../AstProgramBuilder';
import { StaticSlicer } from '../StaticSlicer';
import { RootSpec } from '../types';

function findRepoRoot(startDir: string): string {
  let current = startDir;
  for (let i = 0; i < 10; i++) {
    const pkg = path.join(current, 'package.json');
    if (fs.existsSync(pkg)) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error('Could not locate repository root with package.json');
}

/**
 * Integration test: build a large execution graph from this repo's source.
 * Ensures we do not hit a RangeError: Maximum call stack size exceeded.
 */

describe('Large execution graph - repository self analysis', () => {
  const repoRoot = findRepoRoot(__dirname);
  const srcRoot = path.join(repoRoot, 'src');

  it('builds import/call graphs and computes a static slice without stack overflow', () => {
    expect(fs.existsSync(srcRoot)).toBe(true);

    const builder = new AstProgramBuilder(repoRoot);
    const tsProgram = builder.buildTsProgram(repoRoot, {});

    // Extract relations for large graph
    const importRelations = builder.extractImportGraph(tsProgram);
    const callRelations = builder.extractCallGraph(tsProgram);

    // Choose a stable root file in this repo
    const rootFile = path.join(srcRoot, 'extension.ts');
    const errorFrames = fs.existsSync(rootFile)
      ? [{ file: rootFile, line: 1, fn: 'bootstrap' }]
      : [];

    const roots: RootSpec = {
      errorFrames,
      topSymbols: [],
      userMentions: []
    };

    const slicer = new StaticSlicer();

    // Use generous limits to stress traversal while remaining bounded
    const limits = { maxNodes: 2000, maxDepth: 20, confidenceThreshold: 0.2 };

    // The primary assertion is that no RangeError is thrown
    const result = slicer.buildSlice(roots, importRelations, callRelations, limits);

    expect(result).toBeDefined();
    expect(Array.isArray(result.nodes)).toBe(true);
    expect(Array.isArray(result.edges)).toBe(true);
    expect(result.nodes.length).toBeGreaterThan(0);
  });
});
