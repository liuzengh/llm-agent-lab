export type WorkflowAction = 'run' | 'plan';

export type WorkflowRequest = {
  action: WorkflowAction;
  description: string;
  yes: boolean;
};

export type CliInvocation =
  | { mode: 'repl' }
  | { mode: 'one-shot'; request: WorkflowRequest };

const legacyCommands = new Set(['run', 'doctor', 'build-sandbox', 'plan']);

export function parseCliInvocation(args: string[]): CliInvocation {
  if (args.length === 0) return { mode: 'repl' };
  return { mode: 'one-shot', request: parseWorkflowRequest(args) };
}

export function parseReplWorkflowRequest(line: string): WorkflowRequest | undefined {
  const tokens = tokenize(line.trim());
  if (tokens.length === 0) return undefined;
  if (tokens[0] !== '/workflow' && tokens[0] !== '/plan') return undefined;
  return parseWorkflowRequest(tokens);
}

export function parseWorkflowRequest(args: string[]): WorkflowRequest {
  const [command, ...rest] = args;
  if (legacyCommands.has(command ?? '')) {
    throw new Error(`Legacy command "${command}" was removed. Use /workflow <description> or /plan <description>.`);
  }
  if (command !== '/workflow' && command !== '/plan') {
    throw new Error(`Unknown command "${command ?? ''}". Use /workflow <description>.`);
  }

  let yes = false;
  const words: string[] = [];
  for (const token of rest) {
    if (token === '--yes') {
      yes = true;
      continue;
    }
    if (token.startsWith('--')) throw new Error(`Unknown option "${token}".`);
    words.push(token);
  }

  const description = words.join(' ').trim();
  if (!description) throw new Error(`${command} requires a description.`);

  return {
    action: command === '/plan' ? 'plan' : 'run',
    description,
    yes,
  };
}

export function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let token = '';
  let quote: '"' | "'" | undefined;
  let escaping = false;

  const push = () => {
    if (token.length > 0) tokens.push(token);
    token = '';
  };

  for (const char of line) {
    if (escaping) {
      token += char;
      escaping = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else token += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      push();
      continue;
    }
    token += char;
  }

  if (escaping) token += '\\';
  if (quote) throw new Error('Unterminated quote.');
  push();
  return tokens;
}
