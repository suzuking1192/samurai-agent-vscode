const { getDefaultConfig } = require('./config');

function processUser(name) {
  const config = getDefaultConfig();
  return `${name} handled with ${config.timeout}`;
}

module.exports = { processUser };








