export interface Config {
  timeout: number;
}

export function getDefaultConfig(): Config {
  const TIMEOUT = 5000;
  const config: Config = { timeout: TIMEOUT };
  return config; // BREAKPOINT HERE (Line 8) - after config is assigned
}
