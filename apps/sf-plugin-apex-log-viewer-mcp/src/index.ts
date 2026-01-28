import process from 'node:process';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

const server = createServer();
const transport = new StdioServerTransport();
const keepAlive = setInterval(() => {}, 60_000);
transport.onclose = () => clearInterval(keepAlive);
process.stdin.resume();
await server.connect(transport);
