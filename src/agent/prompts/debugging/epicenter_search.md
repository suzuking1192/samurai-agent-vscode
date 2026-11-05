# Epicenter Search Strategy Prompt

You are helping to find the starting point (epicenter) for debugging a code issue. 

Since you don't know the exact file names, you must generate **multiple distinct search strategies** to ensure we find the relevant code.

## Task

Generate a list of 2-3 search queries to find the code responsible for the user's issue.

## Code Search Tool Schema

{{CODE_SEARCH_SCHEMA}}

## Search Modes

1. **`file`**: Use this when you can guess the file name (e.g., "PlanningAgent").

2. **`symbol`**: Use this for Class names, Function names, or Interfaces (e.g., "PlanningAgent", "MAX_ITERATIONS").

3. **`text`**: Use this for unique string literals, error messages, or log outputs (e.g., "maximum number of iterations").

## Input

User Query: "{{USER_QUERY}}"

Context Snippet: "{{CONTEXT_SNIPPET}}"

Recent Files: {{RECENT_FILES}}

## Strategy Guidelines

1. **Diversity:** Don't just guess the same name three times. Try a file name, a class name, and a unique string.

2. **Specificity:** If the user quotes an error like "Process failed", use `mode='text'` with that exact string.

3. **Naming Conventions:** If the user says "Planning Agent", guess "PlanningAgent", "Planner", and "Agent".

4. **Context Awareness:** The user was recently working on: {{RECENT_FILES}}.
   - If the user query is vague (e.g., "fix the bug"), prioritize searching in or near these recent files.
   - If the user query is specific (e.g., "Database connection"), but the recent files are all frontend components, you should widen your search to the backend.
   - Use the folder structure in recent files to understand the architecture (e.g., `src/legacy/` vs `src/v2/`).

5. **Ignore generic logs** (e.g., "200 OK") if they contradict the query.

## Output Format

Return a **JSON Object** with a `queries` array containing up to 3 search configurations:

```json
{
  "queries": [
    { "query": "PlanningAgent", "mode": "file" },
    { "query": "PlanningAgent", "mode": "symbol" },
    { "query": "maximum number of iterations", "mode": "text" }
  ]
}
```

## Examples

### Example 1: Class/Component mentioned
Input: "Planning agent is hitting maximum number of iterations"
Output:
```json
{
  "queries": [
    { "query": "PlanningAgent", "mode": "file" },
    { "query": "PlanningAgent", "mode": "symbol" },
    { "query": "maximum number of iterations", "mode": "text" }
  ]
}
```

### Example 2: Service with error message
Input: "AuthService is throwing errors"
Output:
```json
{
  "queries": [
    { "query": "AuthService", "mode": "symbol" },
    { "query": "AuthService", "mode": "file" },
    { "query": "auth", "mode": "file" }
  ]
}
```

### Example 3: Vague query with context
Input: "Login is not working"
Context: "Error: Cannot read property 'name' of undefined\n    at getUser (/app/src/api/user.ts:15:8)"
Output:
```json
{
  "queries": [
    { "query": "user.ts", "mode": "file" },
    { "query": "getUser", "mode": "symbol" },
    { "query": "login", "mode": "file" }
  ]
}
```

### Example 4: Filename mentioned
Input: "Why is User.ts failing?"
Output:
```json
{
  "queries": [
    { "query": "User.ts", "mode": "file" },
    { "query": "User", "mode": "symbol" }
  ]
}
```

## Important

- Output **ONLY** valid JSON, no additional text or explanations
- Generate 2-3 diverse search strategies (different modes and queries when possible)
- Each query object must have `query` (string) and `mode` ("file" | "symbol" | "text")
- The `queries` array should contain 1-3 items

