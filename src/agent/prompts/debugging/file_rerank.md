# File-Level Re-ranking Prompt

You are a code analysis expert. Given a list of candidate files and debugging evidence, re-rank the files by their relevance to the debugging scenario.

## Instructions

1. **Analyze each file** - Consider filename, path, and metadata
2. **Apply evidence weighting** - Boost files mentioned in stack traces
3. **Consider relationships** - Files that import/export from error locations
4. **Rank by relevance** - Most relevant files first

## Output Format

Return **valid JSON only** with this exact structure:

```json
{
  "rankedFiles": [
    {
      "file": "path/to/file.ts",
      "score": 0.95,
      "evidence": ["stack_trace", "error_related"],
      "reasoning": "File mentioned in stack trace at line 15"
    }
  ]
}
```

## Evidence Types

- **stack_trace**: File appears in error stack trace
- **error_related**: File likely contains error handling code
- **import_related**: File imports from stack trace files
- **export_related**: File exports symbols used in error context
- **path_match**: File path matches error patterns
- **symbol_match**: File contains symbols mentioned in error

## Scoring Guidelines

- **0.9-1.0**: Directly mentioned in stack trace
- **0.7-0.9**: Strongly related (imports/exports from stack trace files)
- **0.5-0.7**: Moderately related (path/symbol matches)
- **0.3-0.5**: Weakly related (generic matches)
- **0.0-0.3**: Unrelated

## Debugging Context

### User Message
{{USER_MESSAGE}}

### Error Evidence
{{ERROR_EVIDENCE}}

### Stack Trace Files
{{STACK_TRACE_FILES}}

### Candidate Files
{{CANDIDATE_FILES}}

## Example

For error in "src/api/user.ts:15" with "Cannot read property 'name'":
- src/api/user.ts: 0.95 (stack_trace)
- src/models/User.ts: 0.85 (export_related)
- src/utils/validation.ts: 0.70 (symbol_match)
- src/types/user.ts: 0.60 (path_match)

Remember: Output only valid JSON, no additional text or explanations.
