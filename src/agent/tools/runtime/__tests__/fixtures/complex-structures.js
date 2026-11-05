/**
 * Complex Structures Test - "The Crash Maker"
 * 
 * Tests:
 * 1. Circular references (nodeA -> nodeB -> nodeA)
 * 2. Deep nested objects (5 levels deep)
 * 3. Large arrays within objects
 * 
 * Goal: Ensure recursion limit (depth 3) and circular reference protection works.
 * Without this, the agent WILL crash VS Code with "Maximum call stack size exceeded".
 */

// 1. Create a circular reference (The "Crash Maker")
const nodeA = { 
  id: 1, 
  name: "Node A",
  metadata: { heavy: new Array(1000).fill('data') } 
};
const nodeB = { 
  id: 2, 
  name: "Node B",
  metadata: { light: "simple" } 
};
nodeA.next = nodeB;
nodeB.next = nodeA; // <--- CIRCULAR! nodeA -> nodeB -> nodeA

// 2. Create a deep object (Depth 5 - beyond our max depth of 3)
const deepObject = {
  level1: {
    value: "L1",
    level2: {
      value: "L2",
      level3: {
        value: "L3",
        level4: {
          value: "L4",
          level5: {
            value: "Hidden Treasure"
          }
        }
      }
    }
  }
};

// 3. Create an object with many properties (tests 15-property limit)
const manyProps = {};
for (let i = 0; i < 25; i++) {
  manyProps[`prop${i}`] = `value${i}`;
}

console.log("Structures initialized.");
// BREAKPOINT at line 53
const checkpoint = "Structures ready for inspection";
console.log(checkpoint);

// Keep process alive
setTimeout(() => {
  console.log("Done.");
  process.exit(0);
}, 5000);








