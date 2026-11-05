# Zustand Debugging Heuristics

- **Direct Store Mutation**  
  Zustand allows mutating state inside the `set` callback, but components only re-render when you replace root references. If you see stale UI, confirm the updater returns a new object rather than mutating nested fields in place.

- **Selector Identity Traps**  
  When using selectors with `useStore`, ensure they return stable references. Functions that assemble new arrays/objects each render defeat equality checks and trigger unnecessary updates. Memoize derived values or split selectors for granular reads.

- **Async Initializers**  
  Lazy initialization (`create((set, get) => { ... })`) that awaits data must guard against race conditions. If multiple fetches run concurrently, compare versions before writing to state or cancel obsolete updates to avoid showing stale results.

