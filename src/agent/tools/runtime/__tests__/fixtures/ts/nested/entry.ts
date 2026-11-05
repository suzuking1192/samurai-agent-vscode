// entry.ts

import { runMiddle } from './middle';

const startVar = 10;
// Hard breakpoint for diagnostics
debugger;

const result = runMiddle(startVar); // Breakpoint here (Line 4)

console.log('Final:', result);








