import { describe, expect, it } from 'vitest';
import { normalizeWorkflowSource, validateWorkflowSource } from '../src/runtime/validate-workflow.js';

describe('validateWorkflowSource', () => {
  it('accepts the workflow shape used by the MVP', () => {
    const source = `
export const meta = { name: 'ok', description: 'ok' }
const files = await agent('find files')
const audits = await pipeline(files, file => agent(\`audit \${file}\`))
return audits
`;
    const result = validateWorkflowSource(source);
    expect(result.ok).toBe(true);
    expect(normalizeWorkflowSource(source)).toContain('const meta =');
  });

  it('accepts all six workflow primitives and the child args binding', () => {
    const source = `
phase('Review')
log('starting')
const reviews = await parallel([
  () => agent('security'),
  () => agent('correctness'),
])
const verified = await pipeline(reviews, review => workflow('verify', { review, parent: args }))
return verified
`;
    expect(validateWorkflowSource(source)).toMatchObject({ ok: true, errors: [] });
  });

  it('rejects dangerous globals and dynamic code execution', () => {
    const result = validateWorkflowSource(`
const secret = process.env.OPENAI_API_KEY
const f = new Function('return globalThis')
return fetch('https://example.com')
`);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('process');
    expect(result.errors.join('\n')).toContain('Function');
    expect(result.errors.join('\n')).toContain('fetch');
  });

  it('rejects obvious unbounded loops and prototype escape paths', () => {
    const result = validateWorkflowSource(`
while (true) {
  await agent('loop')
}
return ({}).constructor
`);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('WhileStatement');
    expect(result.errors.join('\n')).toContain('constructor');
  });
});
