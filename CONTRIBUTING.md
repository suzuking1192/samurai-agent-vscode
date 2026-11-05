# Contributing

Thanks for helping improve Samurai Agent. MIT licensed — no contributor license agreement. A pull request is enough.

## Setup

```bash
git clone https://github.com/suzuking1192/samurai-agent-vscode.git
cd samurai-agent-vscode
pnpm install
pnpm run compile
```

Press **F5** to open the Extension Development Host. Add a provider, model name, and API key in the panel Settings before running a review.

```bash
pnpm test -- --selectProjects unit
pnpm run lint
```

CI runs lint and unit tests. Integration / live-LLM tests are not required for a green PR.

## Good first changes

| Goal | Where |
|------|--------|
| New JS/TS risk pattern | `src/services/RegressionRiskScorer.ts`, `src/agent/tools/analysis/` |
| Review prompt or rule | `src/agent/core/RuleSelector.ts`, `src/agent/prompts/` |
| New LLM provider protocol | Client in `src/agent/llm/` + add-model form |

Read [ARCHITECTURE.md](ARCHITECTURE.md) before diving into `PlanningAgent`. Prefer the extension points above.

## Pull requests

1. Fork and branch from `main`.
2. Keep the change focused.
3. Add or update unit tests when behavior changes.
4. Fill out the PR template checklist.

## Code of conduct

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
