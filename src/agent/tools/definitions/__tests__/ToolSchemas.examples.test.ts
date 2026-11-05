import {
  CodeSearchToolSchema,
  GraphContextToolSchema,
  StaticAnalysisToolSchema,
  LspDiagnosticsToolSchema,
  GitHistoryToolSchema,
  RuntimeDebugSchema,
  SandboxFileSystemSchema,
  NodeProcessSchema,
  RuntimeInspectorSchema
} from '../ToolSchemas';
import { extractExampleFromDescription } from '../../utils/schemaHelpers';

const toolSchemas = [
  { name: 'code-search', schema: CodeSearchToolSchema },
  { name: 'graph-context', schema: GraphContextToolSchema },
  { name: 'static-analysis', schema: StaticAnalysisToolSchema },
  { name: 'lsp-diagnostics', schema: LspDiagnosticsToolSchema },
  { name: 'git-history', schema: GitHistoryToolSchema },
  { name: 'runtime-debug', schema: RuntimeDebugSchema },
  { name: 'sandbox-fs', schema: SandboxFileSystemSchema },
  { name: 'node-process', schema: NodeProcessSchema },
  { name: 'runtime-inspector', schema: RuntimeInspectorSchema }
];

describe('Tool schema examples', () => {
  it.each(toolSchemas)('example matches schema for %s', ({ name, schema }) => {
    const example = extractExampleFromDescription(schema.description);
    expect(example).toBeTruthy();
    expect(() => schema.parse(example)).not.toThrow();
  });
});






