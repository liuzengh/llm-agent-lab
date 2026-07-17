import { describe, expect, it } from 'vitest';
import {
  parseCliInvocation,
  parseReplWorkflowRequest,
  parseWorkflowRequest,
  tokenize,
} from '../src/workflow-invocation.js';

describe('workflow invocation parser', () => {
  it('uses the REPL only when npm start has no arguments', () => {
    expect(parseCliInvocation([])).toEqual({ mode: 'repl' });
  });

  it('parses one-shot workflow and plan requests', () => {
    expect(parseCliInvocation(['/workflow', 'Research', 'this repo', '--yes'])).toEqual({
      mode: 'one-shot',
      request: { action: 'run', description: 'Research this repo', yes: true },
    });
    expect(parseWorkflowRequest(['/plan', 'Research this repo'])).toEqual({
      action: 'plan',
      description: 'Research this repo',
      yes: false,
    });
  });

  it('handles quoted REPL descriptions', () => {
    expect(tokenize('/workflow "compare two APIs" --yes')).toEqual([
      '/workflow',
      'compare two APIs',
      '--yes',
    ]);
    expect(parseReplWorkflowRequest("/plan 'inspect tests'")).toEqual({
      action: 'plan',
      description: 'inspect tests',
      yes: false,
    });
  });

  it('rejects legacy commands, unknown flags, and missing descriptions', () => {
    expect(() => parseCliInvocation(['run', '--goal', 'old'])).toThrow(/removed/i);
    expect(() => parseCliInvocation(['doctor'])).toThrow(/removed/i);
    expect(() => parseCliInvocation(['/workflow', 'task', '--repo'])).toThrow(/unknown option/i);
    expect(() => parseCliInvocation(['/workflow'])).toThrow(/requires a description/i);
    expect(parseCliInvocation(['/plan', 'task', '--yes'])).toEqual({
      mode: 'one-shot',
      request: { action: 'plan', description: 'task', yes: true },
    });
  });
});
