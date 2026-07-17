import readline from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import type { WorkflowServiceApi } from './workflow-service.js';
import { parseReplWorkflowRequest } from './workflow-invocation.js';

export type ReplOptions = {
  input?: Readable;
  output?: Writable;
  terminal?: boolean;
};

const help = [
  '/workflow <description> [--yes]  generate and run a workflow',
  '/plan <description> [--yes]      generate and preview without running',
  '/last                            show the last run',
  '/runs                            list recent runs',
  '/doctor                          check provider compatibility',
  '/sandbox build                   build the Docker sandbox image',
  '/help                            show this help',
  '/exit                            leave the REPL',
].join('\n');

export async function runWorkflowRepl(service: WorkflowServiceApi, options: ReplOptions = {}): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const terminal = options.terminal ?? Boolean((input as NodeJS.ReadStream).isTTY);
  const rl = readline.createInterface({ input, output, terminal });

  output.write('Dynamic Workflow REPL. Type /help for commands.\n');
  while (true) {
    let rawLine: string;
    try {
      rawLine = await rl.question(terminal ? 'workflow> ' : '');
    } catch {
      break;
    }
    const line = rawLine.trim();
    try {
      if (!line) {
        // Keep the prompt responsive without treating an empty line as a task.
      } else if (line === '/exit') {
        break;
      } else if (line === '/help') {
        output.write(`${help}\n`);
      } else if (line === '/last') {
        output.write(`${formatValue(await service.lastRun())}\n`);
      } else if (line === '/runs') {
        output.write(`${formatValue(await service.listRuns())}\n`);
      } else if (line === '/doctor') {
        output.write(`${formatValue(await service.doctor())}\n`);
      } else if (line === '/sandbox build') {
        output.write(`${formatValue(await service.buildSandbox())}\n`);
      } else {
        const request = parseReplWorkflowRequest(line);
        if (!request) throw new Error('Tasks must start with /workflow or /plan. Type /help for commands.');
        const result = await service.execute(request, {
          approve: async (permission) => {
            const answer = await rl.question(
              `Approve ${permission.risk} action ${permission.capabilityId}/${permission.action} (${permission.details})? [y/N] `,
            );
            return /^(y|yes)$/i.test(answer.trim());
          },
          onPreview: (source, runId) => {
            output.write(`--- workflow preview (${runId}) ---\n${source}\n--- end preview ---\n`);
          },
        });
        output.write(`${formatValue({
          runId: result.runId,
          runDir: result.runDir,
          status: result.status,
          result: result.result,
          metrics: result.metrics,
          error: result.error,
        })}\n`);
      }
    } catch (error) {
      output.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  rl.close();
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}
