import { getDefaultConfig } from './config';

export function processUser(name: string): string {
  const config = getDefaultConfig();
  return `${name} handled with ${config.timeout}`;
}








