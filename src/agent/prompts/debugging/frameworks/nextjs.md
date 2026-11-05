# Next.js Debugging Heuristics

- **Hydration Mismatch**  
  Errors like "Hydration failed" usually mean SSR and client render paths diverge. Search for `window`, `localStorage`, `Math.random`, or `Date.now` used outside of `useEffect`. Move browser-only code behind guards or effects.

- **Silent `getServerSideProps` Failures**  
  Review every `try/catch` in data-fetching methods. Returning `props: {}` from a catch block hides real errors. Log the failure and rethrow or surface it so the page can present a meaningful fallback.

- **Stale ISR Data**  
  If pages never refresh, inspect `revalidate` and fetch caching options. `fetch` defaults to `{ cache: 'force-cache' }`; switch to `{ cache: 'no-store' }` when freshness matters, or lower the `revalidate` interval for incremental static regeneration.

