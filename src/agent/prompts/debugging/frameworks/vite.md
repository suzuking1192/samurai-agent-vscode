# Vite Debugging Heuristics

- **Client Env Vars**  
  Any variable read in browser code must start with `VITE_`. If `import.meta.env.MY_KEY` is `undefined`, search `.env*` files for missing prefixes and ensure the value is reloaded (restart dev server after changes).

- **Hot Module Replacement Drift**  
  When state behaves differently between dev and build, HMR may be preserving stale modules. Reproduce the bug after a full reload or disable HMR to confirm whether module-level singletons need explicit reset logic.

- **Alias Misalignment**  
  Align `resolve.alias` with TypeScript `paths`. Mixed ESM/CJS dependencies can break when aliases resolve to `.ts` instead of built `.js`. If bundling fails, inspect the compiled output and adjust alias extensions (`{ find: '@', replacement: '/src' }`) accordingly.

