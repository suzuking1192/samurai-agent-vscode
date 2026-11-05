/**
 * Closure Scope Test - "The Invisible Variables"
 * 
 * Tests:
 * 1. Variables in closure scope (not local scope)
 * 2. Accessing parent scope variables from inner functions
 * 3. Variables that V8 might optimize away
 * 
 * Goal: JS variables inside inner functions are tricky because they live in 
 * the "Closure Scope," not "Local Scope." Simple debuggers often miss these.
 */

function createCounter(startValue) {
  // 'secretConfig' is NOT used in the inner function directly,
  // but we reference it to prevent V8 from optimizing it away
  const secretConfig = { key: "hidden_key_123", secret: "super_secret" };
  
  // 'startValue' IS used, so it lives in the Closure.
  let count = startValue;
  
  // 'unusedVar' might be optimized away by V8
  const unusedVar = "I might disappear";
  
  // Create a reference to keep secretConfig alive
  const configRef = secretConfig;

  return {
    increment: function() {
      count++;
      // Access configRef to keep secretConfig in scope
      const configCheck = configRef.key;
      console.log("Incrementing... config:", configCheck);
      // BREAKPOINT at line 33
      const checkpoint = "Inside increment function";
      console.log(checkpoint);
      return count;
    },
    getSecret: function() {
      return secretConfig.secret;
    }
  };
}

// Create nested closures to test multi-level scope
function outerScope(outerParam) {
  const outerVar = "Outer: " + outerParam;
  
  function middleScope(middleParam) {
    const middleVar = "Middle: " + middleParam;
    
    function innerScope(innerParam) {
      const innerVar = "Inner: " + innerParam;
      
      // This function has access to all parent scopes
      console.log("Accessing all scopes...");
      // BREAKPOINT at line 56
      const allScopes = {
        inner: innerVar,
        middle: middleVar,
        outer: outerVar
      };
      console.log("All scopes captured");
      return allScopes;
    }
    
    return innerScope("inner-value");
  }
  
  return middleScope("middle-value");
}

// Run the tests
const counter = createCounter(10);
counter.increment();

const scopeResult = outerScope("outer-value");
console.log("Scope result:", scopeResult);

// Keep process alive
setTimeout(() => {
  console.log("Done.");
  process.exit(0);
}, 5000);








