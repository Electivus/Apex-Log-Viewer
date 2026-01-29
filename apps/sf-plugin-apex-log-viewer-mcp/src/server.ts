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

  server.registerTool(
    'apexLogsSync',
    {
      title: 'Apex Log Viewer: Sync Logs',
      description:
        'Syncs Apex log files from a Salesforce org to a local folder using the sf plugin (apex-log-viewer logs sync --json). ' +
        'Use this to retrieve logs for debugging; it does not modify org data. Creates outputDir if missing and returns JSON in structuredContent.',
      inputSchema: {
        targetOrg: z.string().optional(),
        outputDir: z.string().optional(),
        limit: z.coerce.number().int().optional()
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: false,
        openWorldHint: true
      }
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
