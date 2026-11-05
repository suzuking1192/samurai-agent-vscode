async function fetchData() {
  console.log('Fetching...');
  const data = await new Promise(resolve => {
    setTimeout(() => resolve({ users: 100 }), 500);
  });

  const marker = data;
  console.log('Done', marker); // BREAKPOINT HERE (line 8) - after await resolves and marker assigned
  // Inspect 'data'
  // Ensure we are PAUSED and 'data' is fully resolved (not a Promise object)
}

fetchData();








