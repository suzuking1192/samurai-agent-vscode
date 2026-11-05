"use strict";
// entry.ts
Object.defineProperty(exports, "__esModule", { value: true });
const middle_1 = require("./middle");
const startVar = 10;
// Hard breakpoint for diagnostics
debugger;
const result = (0, middle_1.runMiddle)(startVar); // Breakpoint here (Line 4)
console.log('Final:', result);
