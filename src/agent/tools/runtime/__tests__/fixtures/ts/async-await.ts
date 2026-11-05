interface FetchResult {
  users: number;
}

async function fetchData(): Promise<void> {
  console.log('Fetching...');
  const data: FetchResult = await new Promise((resolve) => {
    setTimeout(() => resolve({ users: 100 }), 100); // Shorter delay
  });

  // After await - these variables are now in scope
  const marker = data;
  const checkpoint = 'AFTER_AWAIT'; // Line 13 - use this as breakpoint marker
  console.log('Done', marker, checkpoint);
}

// Call the async function
fetchData();








