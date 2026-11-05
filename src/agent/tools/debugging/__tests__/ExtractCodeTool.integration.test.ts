import * as path from 'path';
import * as fs from 'fs';
import { ExtractCodeTool } from '../../extractCodeTool';
import { SearchPlanner } from '../SearchPlanner';
import { HybridRetriever } from '../HybridRetriever';
import { DebuggingExtractionInput, CandidateFile } from '../types';

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

describe('ExtractCodeTool.extractForDebugging (large repo self-analysis)', () => {
  const repoRoot = findRepoRoot(__dirname);

  it('runs end-to-end with stubs and does not overflow', async () => {
    // Stub dependencies
    const llmProvider: any = { getClient: () => ({ chat: async () => ({}) }) };
    const codeParser: any = { getFileContent: async () => '' };

    const tool = new ExtractCodeTool(llmProvider, codeParser);

    // Spy: SearchPlanner returns a simple plan that covers many files
    jest.spyOn(SearchPlanner.prototype, 'makeSearchPlan').mockResolvedValue({
      candidateFiles: [],
      symbols: [],
      queries: ['function', 'class', 'import'],
      reasoning: 'stubbed',
      mode: 'behavior-first'
    } as any);

    // Spy: scanCodebase returns a map of many src files
    jest.spyOn<any, any>(tool as any, 'scanCodebase').mockResolvedValue(
      (() => {
        const files = new Map<string, any>();
        const srcDir = path.join(repoRoot, 'src');
        const stack = [srcDir];
        while (stack.length) {
          const dir = stack.pop()!;
          for (const entry of fs.readdirSync(dir)) {
            const full = path.join(dir, entry);
            const stat = fs.statSync(full);
            if (stat.isDirectory()) {
              stack.push(full);
            } else if (/\.(ts|tsx|js|jsx)$/.test(entry)) {
              files.set(full, {
                path: full,
                name: path.basename(full),
                extension: path.extname(full),
                language: 'typescript',
                size: stat.size,
                elements: [],
                lastModified: new Date(stat.mtime)
              });
            }
          }
        }
        return files;
      })()
    );

    // Spy: HybridRetriever returns top-N candidates from file map with symbols
    jest.spyOn(HybridRetriever.prototype, 'retrieveHybrid').mockImplementation(async (_plan, _evidence, fileInfos) => {
      const candidates: CandidateFile[] = [];
      let count = 0;
      for (const file of fileInfos.keys()) {
        candidates.push({
          file,
          score: Math.random(),
          evidence: ['path'],
          symbols: [{ file, symbol: 'bootstrap', startLine: 1, endLine: 5, score: 0.9, evidence: ['symbol'] } as any]
        });
        if (++count >= 200) break;
      }
      return candidates;
    });

    const extFile = path.join(repoRoot, 'src', 'extension.ts');
    const logs = fs.existsSync(extFile)
      ? `RangeError: Maximum call stack size exceeded\n    at activate (${extFile}:10:5)`
      : 'Error: something failed';

    const input: DebuggingExtractionInput = {
      userMessage: 'Self-analyze repository execution flow graph',
      workspace: repoRoot,
      noLogMode: false,
      logs,
      model: 'test-model'
    } as any;

    const result = await tool.extractForDebugging(input);

    expect(result).toBeDefined();
    expect(result.graph.nodes.length).toBeGreaterThan(0);
  });
});
