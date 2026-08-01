const { createClient } = require('redis');
const { logSuccess, logError } = require('./lib/log');

const client = createClient({ url: process.env.REDIS_URL });

client.on('error', (err) => logError(`Redis connection error: ${err.message}`));
client.on('ready', () => logSuccess('Redis connected'));

module.exports = { client };
