# TypeScript Debugging Heuristics

- **`this` Context Loss**  
  Watch any callback passed to third-party utilities or event emitters. If a class method is handed off without binding, `this` becomes `undefined`. Verify callers use arrow functions or `.bind(this)` before invoking logic that relies on class state.

- **Module Resolution Mismatches**  
  When you see "Cannot find module" for an alias like `@/components/Button`, confirm `tsconfig.json` `paths` align with the bundler/runtime config (`vite.config.ts`, `webpack.config.js`, `next.config.js`). A mismatch between TypeScript and the runtime resolver silently breaks imports.

- **Implicit or Hidden `any`**  
  Crashes involving API responses or `JSON.parse` outputs often come from values typed as `any`. Track the data flow back to the boundary, annotate it with a concrete interface, and add runtime guards (e.g., Zod) if the structure is untrusted.

