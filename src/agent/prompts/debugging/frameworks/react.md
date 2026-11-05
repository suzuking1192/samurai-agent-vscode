# React Debugging Heuristics

- **Infinite Re-render Loops**  
  Inspect every `useEffect` that calls a setter. If the state variable it updates is also in the dependency array—or the dependencies include a freshly-created object/array literal—the effect will loop forever.

- **Stale Closures**  
  When event handlers or effects read outdated state, check for missing dependencies. Effects with `[]` often capture the initial value. Prefer the functional form `setState(prev => ...)` when updating values inside callbacks triggered later.

- **Direct State Mutation**  
  Components that modify arrays or objects in place (`push`, `splice`, direct property assignment) won't trigger re-renders. Ensure updates create new references via spreads, `map`, or `filter` before calling the setter.

