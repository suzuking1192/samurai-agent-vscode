#!/usr/bin/env node

const { execSync } = require('child_process');

// Run the given command (everything after the script name) via npx so the locally installed webpack is used
const command = 'npx ' + process.argv.slice(2).join(' ');
console.log('Running command:', command);

try {
    execSync(command, { stdio: 'inherit', env: { ...process.env } });
} catch (error) {
    console.error('Build failed:', error.message);
    process.exit(1);
}
