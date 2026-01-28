import { Flags, SfCommand } from '@salesforce/sf-plugins-core';
import { Messages, SfProject } from '@salesforce/core';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { formatStartTimeUtc } from '../../../lib/time.js';
import { buildLogFilename } from '../../../lib/filename.js';
import { clampLimit } from '../../../lib/limits.js';
import { runWithConcurrency } from '../../../lib/concurrency.js';
import { fetchApexLogBody, queryApexLogs } from '../../../lib/api.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@electivus/sf-plugin-apex-log-viewer', 'apex-log-viewer.logs.sync');

type JsonResult = {
  status: 0;
  result: {
    org: { username?: string; instanceUrl: string };
    apiVersion: string;
    limit: number;
    outputDir: string;
    logsSaved: Array<{ id: string; file: string; size: number }>;
    logsSkipped: Array<{ id: string; reason: string }>;
    errors: Array<{ id?: string; message: string }>;
  };
};

export default class LogsSync extends SfCommand<JsonResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly flags = {
    'target-org': Flags.optionalOrg({ summary: messages.getMessage('flags.target-org.summary'), char: 'o' }),
    'output-dir': Flags.directory({ summary: messages.getMessage('flags.output-dir.summary'), char: 'd' }),
    limit: Flags.integer({ summary: messages.getMessage('flags.limit.summary'), char: 'l', min: 1, max: 200, default: 100 }),
  };
  public static readonly requiresProject = true;

  public async run(): Promise<JsonResult> {
    const { flags } = await this.parse(LogsSync);

    const project = this.project ?? (await SfProject.resolve());
    const projectConfig = await project.resolveProjectConfig();
    const apiVersion = typeof projectConfig.sourceApiVersion === 'string' ? projectConfig.sourceApiVersion : undefined;
    if (!apiVersion) {
      throw messages.createError('error.NoSourceApiVersion');
    }

    const org = flags['target-org'];
    if (!org) {
      throw messages.createError('error.NoDefaultOrg');
    }

    const conn = org.getConnection();
    const limit = clampLimit(flags.limit ?? 100);
    const outputDir = flags['output-dir'] ?? 'apexlogs';

    await fs.mkdir(outputDir, { recursive: true });

    const logs = await queryApexLogs(conn, limit);
    const logsSaved: JsonResult['result']['logsSaved'] = [];
    const logsSkipped: JsonResult['result']['logsSkipped'] = [];
    const errors: JsonResult['result']['errors'] = [];

    await runWithConcurrency(logs, 5, async (log) => {
      try {
        const startTime = formatStartTimeUtc(log.startTime);
        const filename = buildLogFilename(startTime, log.username, log.id);
        const body = await fetchApexLogBody(conn, log.id);
        const filePath = path.join(outputDir, filename);
        await fs.writeFile(filePath, body, 'utf8');
        logsSaved.push({ id: log.id, file: filePath, size: body.length });
      } catch (err: any) {
        errors.push({ id: log.id, message: String(err?.message ?? err) });
      }
    });

    if (!flags.json) {
      const tableData = logs.map((log) => ({
        StartTime: log.startTime,
        User: log.username,
        LogId: log.id,
        Size: log.logLength,
        File: logsSaved.find((saved) => saved.id === log.id)?.file ?? '',
      }));
      this.table({ data: tableData, columns: ['StartTime', 'User', 'LogId', 'Size', 'File'] });
      this.log(`Saved: ${logsSaved.length}, Skipped: ${logsSkipped.length}, Errors: ${errors.length}`);
    }

    return {
      status: 0,
      result: {
        org: { username: org.getUsername(), instanceUrl: conn.instanceUrl },
        apiVersion,
        limit,
        outputDir,
        logsSaved,
        logsSkipped,
        errors,
      },
    };
  }
}
