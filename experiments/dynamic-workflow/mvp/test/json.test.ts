import { describe, expect, it } from 'vitest';
import { parseJsonFromText } from '../src/json.js';

describe('parseJsonFromText', () => {
  it('extracts fenced JSON and validates schema', () => {
    const parsed = parseJsonFromText<{ ok: boolean }>('```json\n{"ok":true}\n```', {
      type: 'object',
      required: ['ok'],
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
      },
    });

    expect(parsed.ok).toBe(true);
  });

  it('throws on schema mismatch', () => {
    expect(() =>
      parseJsonFromText('{"ok":"yes"}', {
        type: 'object',
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
        },
      }),
    ).toThrow(/schema/i);
  });

  it('repairs common malformed model JSON before schema validation', () => {
    const parsed = parseJsonFromText<{ status: string; rationale: string }>(
      `{status: 'supported', rationale: 'missing admin check',}`,
      {
        type: 'object',
        required: ['status', 'rationale'],
        properties: {
          status: { type: 'string' },
          rationale: { type: 'string' },
        },
      },
    );

    expect(parsed).toEqual({
      status: 'supported',
      rationale: 'missing admin check',
    });
  });
});
