/**
 * Async State Test - "The Timing Challenge"
 * 
 * Tests:
 * 1. Variables exist only AFTER await resolves
 * 2. The debugger can pause after an async operation
 * 3. The value is the resolved data, not Promise { <pending> }
 * 
 * Goal: Verify the debugger waits for Promises to resolve before pausing.
 * If it pauses too early, you see `Promise { <pending> }` instead of the data.
 */

function mockApiCall() {
  return new Promise(resolve => 
    setTimeout(() => resolve("API_DATA_PAYLOAD"), 100)
  );
}

function mockDatabaseQuery() {
  return new Promise(resolve => 
    setTimeout(() => resolve({ 
      userId: 42, 
      username: "testuser",
      permissions: ["read", "write"] 
    }), 50)
  );
}

async function processData() {
  console.log("Step 1: Fetching API data...");
  const rawData = await mockApiCall();
  
  console.log("Step 2: Fetching user data...");
  const userData = await mockDatabaseQuery();
  
  // The variables 'rawData' and 'userData' exist here, but only AFTER the awaits.
  // If we break too early, they're undefined or Promise { <pending> }.
  const processed = `Processed: ${rawData}`;
  const combined = {
    apiResult: rawData,
    user: userData,
    timestamp: Date.now()
  };
  
  console.log("Step 3: Processing Complete");
  // BREAKPOINT at line 45
  const checkpoint = "Async operations complete";
  console.log(checkpoint);
  
  return combined;
}

processData().then(() => {
  console.log("All done!");
  process.exit(0);
});








