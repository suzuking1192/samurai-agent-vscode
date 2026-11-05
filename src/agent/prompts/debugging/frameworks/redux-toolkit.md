# Redux Toolkit Debugging Heuristics

- **Accidental Mutations**  
  Immer lets you mutate draft state, but mixing direct mutations with manual object spreads can produce confusing results. Confirm reducers either mutate the draft or return a new state—not both. Pay special attention to nested arrays where `.push` or `.splice` might be misused.

- **Selector Memoization Gaps**  
  Components that re-render excessively often use selectors that return new objects each time. Wrap expensive selectors with `createSelector` and ensure inputs capture the minimal slice of state required.

- **Thunk Error Handling**  
  Silent failures in async thunks usually stem from missing `rejectWithValue` handling. Check `extraReducers` for rejected cases and verify the UI listens for `action.error` or custom payloads to surface the failure.

