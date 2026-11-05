"use strict";
// middle.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.runMiddle = runMiddle;
const leaf_1 = require("./leaf");
function runMiddle(start) {
    const middleVar = start + 5; // Breakpoint here (Line 5)
    return (0, leaf_1.calculateLeaf)(middleVar);
}
