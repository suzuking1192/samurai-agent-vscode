function testCircular() {
  const nodeA = { id: 1 };
  const nodeB = { id: 2 };

  nodeA.next = nodeB;
  nodeB.next = nodeA; // Circular dependency!

  const marker = nodeA;
  console.log('Done', marker); // BREAKPOINT HERE (line 9) - inside function scope
  // Inspect 'nodeA'
  // Expect: { id: 1, next: { id: 2, next: [Circular] } }
}

testCircular();
