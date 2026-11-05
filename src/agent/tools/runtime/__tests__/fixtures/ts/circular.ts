interface GraphNode {
  id: number;
  next?: GraphNode;
}

function testCircular() {
  const nodeA: GraphNode = { id: 1 };
  const nodeB: GraphNode = { id: 2 };

  nodeA.next = nodeB;
  nodeB.next = nodeA; // Circular dependency!

  const marker = nodeA;
  console.log('Done', marker); // BREAKPOINT HERE (line 14) - inside function scope
}

testCircular();

export {};
