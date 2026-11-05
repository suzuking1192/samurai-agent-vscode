# Security Policy

## Reporting a vulnerability

Do **not** open a public issue for a leaked key, RCE, or other security problem.

Use [GitHub private security advisories](https://github.com/suzuking1192/samurai-agent-vscode/security/advisories/new) on this repository.

## Scope

- The extension stores API keys in VS Code Secret Storage. Do not commit keys.
- Reviews send code context to the LLM provider the user configured. Treat that as equivalent to pasting code into that provider’s chat product.
