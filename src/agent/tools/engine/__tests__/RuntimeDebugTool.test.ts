import { RuntimeDebugTool } from '../RuntimeDebugTool';
import { RuntimeAnalysisAgent } from '../../../core/RuntimeAnalysisAgent';

jest.mock('../../../core/RuntimeAnalysisAgent', () => {
  return {
    RuntimeAnalysisAgent: jest.fn(),
    __esModule: true
  };
});

describe('RuntimeDebugTool', () => {
  beforeEach(() => {
    (RuntimeAnalysisAgent as jest.Mock).mockClear();
  });

  it('normalizes filePath/lineNumber targets from planning-agent runtime-debug log', async () => {
    const analyze = jest.fn().mockResolvedValue({
      value: 'ok',
      type: 'string',
      logs: [],
      rootCauseFound: false
    });

    (RuntimeAnalysisAgent as jest.Mock).mockImplementation(() => ({
      analyze,
      setReporter: jest.fn(),
      setLogger: jest.fn()
    }));

    const tool = new RuntimeDebugTool({} as any, {} as any);

    const params = {
      description: "Debug the `getFrequency` function to understand why it returns few words with low counts.",
      targets: [
        {
          filePath: "/Users/yutosuzuki/code/ninjasales/lib/tokenizer.ts",
          lineNumber: 104,
          expression: "cleanedSegments"
        },
        {
          filePath: "/Users/yutosuzuki/code/ninjasales/lib/tokenizer.ts",
          lineNumber: 109,
          expression: "tokens"
        },
        {
          filePath: "/Users/yutosuzuki/code/ninjasales/lib/tokenizer.ts",
          lineNumber: 118,
          expression: "wordCounts"
        },
        {
          filePath: "/Users/yutosuzuki/code/ninjasales/lib/tokenizer.ts",
          lineNumber: 126,
          expression: "words"
        },
        {
          filePath: "/Users/yutosuzuki/code/ninjasales/lib/tokenizer.ts",
          lineNumber: 61,
          expression: "cleanedSegments"
        },
        {
          filePath: "/Users/yutosuzuki/code/ninjasales/lib/tokenizer.ts",
          lineNumber: 72,
          expression: "segments"
        }
      ]
    };

    const result = await tool.execute(params as any);

    expect(analyze).toHaveBeenCalledTimes(params.targets.length);
    params.targets.forEach((target, idx) => {
      expect(analyze).toHaveBeenNthCalledWith(
        idx + 1,
        target.filePath,
        target.lineNumber,
        target.expression,
        params.description,
        undefined
      );
    });

    expect(result.success).toBe(true);
    expect(result.structuredData?.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: "/Users/yutosuzuki/code/ninjasales/lib/tokenizer.ts",
          line: 104,
          variable: "cleanedSegments"
        })
      ])
    );
  });
});








