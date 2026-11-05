// middle.ts

import { calculateLeaf } from './leaf';

export function runMiddle(start: number) {
  const middleVar = start + 5; // Breakpoint here (Line 5)
  return calculateLeaf(middleVar);
}








