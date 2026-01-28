import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runApexLogsSync } from './command.js';

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'sf-plugin-apex-log-viewer-mcp',
    version: '0.1.0'
  });

  server.tool(
    'apexLogsSync',
    {
      targetOrg: z.string().optional(),
      outputDir: z.string().optional(),
      limit: z.coerce.number().int().optional()
    },
    async (params) => runApexLogsSync(params, { cwd: process.cwd(), env: process.env })
  );

  return server;
}
