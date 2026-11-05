# Node.js / Express Debugging Heuristics

- **Missing Body Parsers**  
  `req.body` being `undefined` usually means `app.use(express.json())` or `express.urlencoded()` is registered after the route. Ensure body-parsing middleware runs before any router that reads request payloads.

- **Middleware That Never Calls `next()`**  
  Requests that hang without error often stop inside custom middleware. Trace every branch and confirm it either calls `next()` or sends a response. Asynchronous middleware must wrap logic in `try/catch` and forward errors to `next(err)`.

- **Unhandled Async Errors**  
  Express 4 does not auto-handle promise rejections. Wrap `async` handlers in `try/catch` and call `next(err)` so centralized error handlers can respond gracefully instead of crashing the process.

