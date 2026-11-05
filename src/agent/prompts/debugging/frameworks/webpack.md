# Webpack Debugging Heuristics

- **Loader Order**  
  Loader chains execute right-to-left. If transformations appear skipped, confirm the order: e.g., `style-loader`, `css-loader`, `postcss-loader`, `sass-loader`. Misordered rules often surface as missing styles or runtime errors.

- **Path vs. Alias Conflicts**  
  When imports resolve unexpectedly, inspect `resolve.alias` alongside `extensions`. Webpack may pick `.js` over `.ts` or treat alias prefixes as absolute paths. Use `require.resolve` in the config to verify the computed destination.

- **Production vs. Development Divergence**  
  Bugs that only appear in production builds often trace to minification or tree shaking. Check `optimization.minimizer` and `sideEffects` settings, and verify that code relying on `process.env.NODE_ENV` has fallbacks when bundlers strip branches.

