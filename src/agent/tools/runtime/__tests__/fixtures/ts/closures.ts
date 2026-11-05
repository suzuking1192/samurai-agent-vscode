function createDatabase() {
  // 'secretKey' is NOT local to the inner function.
  // It is in the Closure Scope.
  const secretKey = 'API_KEY_12345';

  return {
    connect: () => {
      const status = 'connecting';
      const marker = secretKey;
      console.log(`Using ${marker}`); // BREAKPOINT HERE (line 10) - after marker is assigned
    },
  };
}

const db = createDatabase();
db.connect();








