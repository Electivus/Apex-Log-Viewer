import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runApexLogsSync } from './command.js';

export type CreateServerOptions = {
  runApexLogsSync?: typeof runApexLogsSync;
};

export function createServer(options: CreateServerOptions = {}): McpServer {
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
    async (params) => {
      const runSync = options.runApexLogsSync ?? runApexLogsSync;
      const result = await runSync(params, { cwd: process.cwd(), env: process.env });
      const structuredContent =
        result && typeof result === 'object' ? (result as Record<string, unknown>) : { value: result };
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent
      };
    }
  );

  return server;
}
