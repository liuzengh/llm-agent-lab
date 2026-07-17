import fs from 'node:fs/promises';
import readline from 'node:readline';

const workflowPath = process.argv[2];
if (!workflowPath) {
  throw new Error('Usage: node /runner.mjs /workflow.js [args.json]');
}
const argsPath = process.argv[3];

const responses = new Map();
const responseWaiters = new Map();
let nextId = 1;
let currentPhase;

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof message.id !== 'number') return;
  const waiter = responseWaiters.get(message.id);
  if (waiter) {
    responseWaiters.delete(message.id);
    waiter(message);
  } else {
    responses.set(message.id, message);
  }
});

globalThis.console = {
  ...console,
  log: (...args) => process.stderr.write(`${args.map(String).join(' ')}\n`),
  warn: (...args) => process.stderr.write(`${args.map(String).join(' ')}\n`),
  error: (...args) => process.stderr.write(`${args.map(String).join(' ')}\n`),
};

async function agent(prompt, options = {}) {
  if (typeof prompt !== 'string') {
    throw new Error('agent(prompt, options) requires a string prompt.');
  }
  return await rpc('agent', { prompt, options, phase: currentPhase });
}

async function parallel(thunks) {
  if (!Array.isArray(thunks)) {
    throw new Error('parallel(thunks) requires an array.');
  }
  if (thunks.some((thunk) => typeof thunk !== 'function')) {
    throw new Error('Every parallel task must be a thunk function.');
  }
  return await Promise.all(thunks.map((thunk) => thunk()));
}

async function pipeline(items, ...stages) {
  if (!Array.isArray(items)) {
    throw new Error('pipeline(items, ...stages) requires an array.');
  }
  if (stages.length === 0 || stages.some((stage) => typeof stage !== 'function')) {
    throw new Error('pipeline(items, ...stages) requires at least one stage function.');
  }
  return await Promise.all(items.map(async (item, index) => {
    let value = item;
    for (const stage of stages) {
      value = await stage(value, index);
    }
    return value;
  }));
}

async function workflow(nameOrRef, args) {
  if (typeof nameOrRef !== 'string' || !nameOrRef.trim()) {
    throw new Error('workflow(nameOrRef, args) requires a non-empty workflow name or reference.');
  }
  return await rpc('workflow', {
    nameOrRef,
    args,
    phase: currentPhase,
  });
}

function phase(title) {
  if (typeof title !== 'string' || !title.trim()) {
    throw new Error('phase(title) requires a non-empty title.');
  }
  currentPhase = title;
  emit({ event: 'phase', title });
}

function log(message) {
  if (typeof message !== 'string') {
    throw new Error('log(message) requires a string.');
  }
  emit({ event: 'log', message, phase: currentPhase });
}

async function rpc(method, params) {
  const id = nextId++;
  const message = { id, method, params };
  process.stdout.write(`${JSON.stringify(message)}\n`);

  const response = responses.get(id) ?? await new Promise((resolve) => {
    responseWaiters.set(id, resolve);
  });
  responses.delete(id);

  if (response.error) {
    throw new Error(response.error);
  }
  return response.result;
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

try {
  const source = await fs.readFile(workflowPath, 'utf8');
  const args = argsPath
    ? JSON.parse(await fs.readFile(argsPath, 'utf8'))
    : undefined;
  const run = new Function(
    'agent',
    'parallel',
    'pipeline',
    'workflow',
    'phase',
    'log',
    'args',
    `'use strict';\nreturn (async () => {\n${source}\n})();`,
  );
  const result = await run(agent, parallel, pipeline, workflow, phase, log, args);
  emit({ event: 'result', result });
  rl.close();
} catch (error) {
  emit({
    event: 'error',
    error: error instanceof Error ? error.message : String(error),
  });
  rl.close();
  process.exitCode = 1;
}
