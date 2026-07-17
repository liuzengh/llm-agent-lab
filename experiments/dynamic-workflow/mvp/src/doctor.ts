import { Agent, tool } from '@openai/agents';
import { z } from 'zod';
import type { Runner } from '@openai/agents';
import { parseJsonFromText } from './json.js';

type DoctorCheck = {
  name: string;
  ok: boolean;
  detail: string;
};

export async function runDoctor(runner: Runner, model: string): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  checks.push(await capture('text', async () => {
    const agent = new Agent({
      name: 'doctor_text',
      model,
      instructions: 'Reply with exactly: dynamic-workflow-ok',
    });
    const result = await runner.run(agent, 'Run the text connectivity check.');
    const output = String(result.finalOutput ?? '').trim();
    if (!output.includes('dynamic-workflow-ok')) {
      throw new Error(`Unexpected output: ${output}`);
    }
    return output;
  }));

  checks.push(await capture('tool-calling', async () => {
    const echo = tool({
      name: 'doctor_echo',
      description: 'Echo a short string for provider compatibility testing.',
      parameters: z.object({ text: z.string() }),
      execute: async ({ text }) => `echo:${text}`,
    });
    const agent = new Agent({
      name: 'doctor_tool',
      model,
      instructions: 'Call doctor_echo with text "tool-ok", then summarize the exact tool result.',
      tools: [echo],
    });
    const result = await runner.run(agent, 'Check function tool support.');
    const output = String(result.finalOutput ?? '').trim();
    if (!output.includes('echo:tool-ok')) {
      throw new Error(`Tool result not observed in output: ${output}`);
    }
    return output;
  }));

  checks.push(await capture('structured-json', async () => {
    const schema = z.object({
      ok: z.boolean(),
      message: z.string(),
    });
    const agent = new Agent({
      name: 'doctor_structured_json',
      model,
      instructions: 'Return JSON with ok=true and message="json-ok". Do not include extra text.',
      outputType: schema,
    });
    const result = await runner.run(agent, 'Check structured JSON support.');
    const output = result.finalOutput;
    const parsed = typeof output === 'string'
      ? parseJsonFromText<{ ok: boolean; message: string }>(output)
      : schema.parse(output);
    if (!parsed.ok || parsed.message !== 'json-ok') {
      throw new Error(`Unexpected structured output: ${JSON.stringify(parsed)}`);
    }
    return JSON.stringify(parsed);
  }));

  return checks;
}

async function capture(name: string, fn: () => Promise<string>): Promise<DoctorCheck> {
  try {
    const detail = await fn();
    return { name, ok: true, detail };
  } catch (error) {
    return {
      name,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
