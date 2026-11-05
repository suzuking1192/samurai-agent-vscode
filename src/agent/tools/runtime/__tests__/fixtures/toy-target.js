// toy-target.js
let secretMessage = "Success! You extracted this string via V8.";
const number = 42;
let globalCounter = 0;

// Global complex objects
const globalConfig = {
    appName: "Toy Inspector",
    version: "1.0.0",
    settings: {
        debug: true,
        logLevel: "info",
        features: ["feature1", "feature2"]
    },
    metadata: {
        author: "Test",
        created: new Date().toISOString()
    }
};

const globalData = {
    users: [
        { id: 1, name: "Alice", active: true },
        { id: 2, name: "Bob", active: false }
    ],
    stats: {
        total: 100,
        completed: 75,
        pending: 25
    }
};

console.log("--- Target Script Running ---");

function outerFunction(param1) {
    const outerVar = "I'm in outer function";
    let outerCounter = 10;
    
    // Object in outer function
    const outerData = {
        functionName: "outerFunction",
        param: param1,
        nested: {
            level: 1,
            parent: null,
            children: ["innerFunction"]
        },
        counters: {
            outer: outerCounter,
            global: globalCounter
        }
    };
    
    console.log("Outer function called with:", param1);
    
    function innerFunction(param2) {
        const innerVar = "I'm in inner function";
        let innerCounter = 20;
        const closureVar = outerVar + " (accessed from closure)";
        
        // Object in inner function
        const innerData = {
            functionName: "innerFunction",
            param: param2,
            parent: outerData,
            nested: {
                level: 2,
                parent: "outerFunction",
                children: ["deeplyNestedFunction"]
            },
            values: {
                innerVar,
                innerCounter,
                closureVar,
                outerVar: outerVar // from closure
            }
        };
        
        console.log("Inner function called with:", param2);
        console.log("Accessing outer variable:", outerVar);
        
        // Nested function
        function deeplyNestedFunction() {
            const deepVar = "I'm in deeply nested function";
            const deepCounter = innerCounter + outerCounter + globalCounter;
            
            // Complex object in deeply nested function
            const deepData = {
                functionName: "deeplyNestedFunction",
                nested: {
                    level: 3,
                    parent: "innerFunction",
                    children: []
                },
                calculations: {
                    deepCounter,
                    formula: "innerCounter + outerCounter + globalCounter",
                    values: {
                        innerCounter,
                        outerCounter,
                        globalCounter
                    }
                },
                references: {
                    innerData: innerData, // from closure
                    outerData: outerData, // from closure
                    globalConfig: globalConfig // global
                },
                array: [1, 2, 3, { nested: "object" }, [4, 5, 6]]
            };
            
            console.log("Deeply nested function executing...");
            console.log("Deep counter:", deepCounter);
            
            // This is where we'll set a breakpoint
            secretMessage = "Modified inside deeply nested function!";
            
            return {
                deepVar,
                deepCounter,
                message: secretMessage,
                data: deepData
            };
        }
        
        // Call nested function
        const result = deeplyNestedFunction();
        return result;
    }
    
    // Call inner function
    const result = innerFunction("inner-param");
    return result;
}

// Call the nested function chain
const finalResult = outerFunction("outer-param");
console.log("Final result:", finalResult);

secretMessage = "Success! Changed the value at top level.";

debugger; 

// Keep process alive for a bit to ensure breakpoints can be hit
setTimeout(() => {
  console.log("--- Target Script Finished ---");
  process.exit(0);
}, 5000);

