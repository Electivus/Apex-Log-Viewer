import {
  CUSTOM_LOG_LEVELS,
  CUSTOM_LOG_LIMITS,
  type CustomLogCaptureResult,
  type PrintsAsJson
} from '@alv/core/contracts';
import { Flags } from '@salesforce/sf-plugins-core';
import { AlvCommand } from '../../../command.js';
import { core } from '../../../core.js';
import { finishLines, updatePrinter, withInterrupt, withNextSteps } from '../../../customLogCapture.js';
import { targetOrgFlag } from '../../../flags.js';

export default class CustomLogCapture extends AlvCommand<PrintsAsJson<CustomLogCaptureResult>> {
  public static override readonly summary =
    'Capture a platform event log source into the local event store, so "custom-log list" can read it offline.';
  public static override readonly description =
    'Salesforce keeps platform events for about 72 hours, and every event delivered counts against the org-wide daily allocation. ' +
    'This command subscribes, stores each event whole under apexlogs/, and resumes from the stored position on the next run.\n\n' +
    'By default it drains: it stops when the stream goes quiet, when this run has spent about half of the remaining daily allocation, or after --max-time. ' +
    'A quiet stream does not prove the backlog was complete. The stored position is exact, so an early stop costs one more run; ' +
    'if that run starts after the oldest event left behind has expired, the result lists the interval as a gap. ' +
    'A drain that hears nothing over a stored position older than one hour, or on a first run that replays retained events, waits the whole --max-time before it stops, ' +
    'because the first event of a backlog can take that long. Lower --max-time for a stream you know is quiet.\n\n' +
    'With --follow it keeps capturing, prints each stored row to stdout and state changes to stderr, and stops on Ctrl-C with exit code 0. A second Ctrl-C quits at once.\n\n' +
    'Events published while nothing captured and older than 72 hours are lost; the result lists the interval as a gap.';
  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %> --source app-events --target-org dev --json',
    '<%= config.bin %> <%= command.id %> --source app-events --target-org dev --max-time 20 --json',
    '<%= config.bin %> <%= command.id %> --source app-events --target-org dev --follow --min-level WARN'
  ];
  public static override readonly flags = {
    follow: Flags.boolean({
      summary: 'Keep capturing and print each stored row until you press Ctrl-C.'
    }),
    initial: Flags.option({
      options: ['retained', 'new'] as const,
      default: 'retained',
      summary:
        'For an org this project never captured: "retained" replays the events Salesforce still keeps (each counts against the daily allocation), "new" starts with events published from now on.'
    })(),
    'max-time': Flags.integer({
      min: 1,
      max: CUSTOM_LOG_LIMITS.drainMs.max / 1000,
      exclusive: ['follow'],
      summary: `Stop after this many seconds even while events keep arriving (default ${CUSTOM_LOG_LIMITS.drainMs.default / 1000}).`
    }),
    'min-level': Flags.option({
      options: CUSTOM_LOG_LEVELS,
      dependsOn: ['follow'],
      summary: 'Print only rows at or above this level. Everything is stored either way.'
    })(),
    source: Flags.string({
      required: true,
      summary:
        'Event source id from "sf electivus custom-log sources". Never chosen for you, because capturing spends the org delivery allocation.'
    }),
    'target-org': targetOrgFlag,
    user: Flags.string({
      dependsOn: ['follow'],
      summary: 'Print only rows logged by this username. Everything is stored either way.'
    })
  };

  public override async run(): Promise<PrintsAsJson<CustomLogCaptureResult>> {
    const { flags } = await this.parse(CustomLogCapture);
    // No flag default: oclif counts a default as the flag being present, which would void dependsOn and exclusive.
    const follow = flags.follow === true;
    const printsRows = follow && !this.jsonEnabled();

    try {
      const result = await withInterrupt(
        signal =>
          core.customLog.capture(
            {
              targetOrg: flags['target-org'],
              projectDir: process.cwd(),
              source: flags.source,
              follow,
              initial: flags.initial,
              maxDurationMs: flags['max-time'] === undefined ? undefined : flags['max-time'] * 1000,
              filter: { minLevel: flags['min-level'], user: flags.user }
            },
            {
              signal,
              onUpdate: printsRows
                ? updatePrinter({ out: line => this.log(line), err: line => this.logToStderr(line) })
                : undefined
            }
          ),
        { onInterrupt: printsRows ? () => this.logToStderr('Stopping. Press Ctrl-C again to quit now.') : undefined }
      );
      if (!printsRows) return this.printResult(result);
      for (const line of finishLines(result)) this.logToStderr(line);
      return result;
    } catch (error) {
      throw withNextSteps(error);
    }
  }
}
