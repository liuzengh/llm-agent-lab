#!/usr/bin/env node
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { createDefaultWorkflowService } from './workflow-service.js';
import { parseCliInvocation } from './workflow-invocation.js';
import { runWorkflowRepl } from './repl.js';

async function main(): Promise<void> {
  const invocation = parseCliInvocation(process.argv.slice(2));
  const service = await createDefaultWorkflowService();
  try {
    if (invocation.mode === 'repl') {
      await runWorkflowRepl(service);
      return;
    }

    const terminal = Boolean(stdin.isTTY && stdout.isTTY);
    const approvalReadline = terminal ? readline.createInterface({ input: stdin, output: stdout }) : undefined;
    try {
      const result = await service.execute(invocation.request, {
        approve: approvalReadline
          ? async (permission) => {
              const answer = await approvalReadline.question(
                `Approve ${permission.risk} action ${permission.capabilityId}/${permission.action} (${permission.details})? [y/N] `,
              );
              return /^(y|yes)$/i.test(answer.trim());
            }
          : undefined,
        onPreview: (source, runId) => {
          stdout.write(`--- workflow preview (${runId}) ---\n${source}\n--- end preview ---\n`);
        },
      });
      stdout.write(
        `${JSON.stringify(
          {
            runId: result.runId,
            runDir: result.runDir,
            status: result.status,
            result: result.result,
            metrics: result.metrics,
            error: result.error,
          },
          null,
          2,
        )}\n`,
      );
      if (result.status === 'failed' || result.status === 'denied') process.exitCode = 1;
    } finally {
      approvalReadline?.close();
    }
  } finally {
    await service.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
