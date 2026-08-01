const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

function logSuccess(message) {
  console.log(`${GREEN}✔ ${message}${RESET}`);
}

function logError(message) {
  console.error(`${RED}✘ ${message}${RESET}`);
}

module.exports = { logSuccess, logError };
