# Samurai Agent

**Prevent JS/TS regression bugs by reviewing AI code edits inside your IDE — before they break your app.**

Open source under the MIT License. Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=SamuraiAgent.samurai-agent) or [Open VSX](https://open-vsx.org/extension/SamuraiAgent/samurai-agent). Site: [GitHub Pages](https://suzuking1192.github.io/samurai-agent-vscode/).

## What it does

1. Detects AI-like edit bursts (editor + filesystem).
2. Scores JS/TS regression risk locally — no model call.
3. Shows an IDE warning; one click starts a focused review.
4. The agent uses tools (search, git, diagnostics, sandbox) and **your** LLM.

Samurai does not replace Cursor or Copilot. It reviews what they write.

## Bring your own key

There is **no default model** and **no proxy**.

In the Samurai Agent panel → Settings:

1. Choose a provider: OpenAI, Gemini, or Anthropic.
2. Type any model name that provider accepts.
3. Paste your API key (stored in VS Code Secret Storage).

Nothing runs until an entry is active.

## Develop

```bash
pnpm install
pnpm run compile
# Press F5 in VS Code / Cursor to launch the Extension Development Host
pnpm test -- --selectProjects unit
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [ARCHITECTURE.md](ARCHITECTURE.md).

## License

MIT — see [LICENSE.md](LICENSE.md).
