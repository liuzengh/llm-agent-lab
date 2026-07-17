import * as AjvModule from 'ajv';
import type { JSONSchemaType } from 'ajv';
import { jsonrepair } from 'jsonrepair';

type AjvConstructor = new (options?: { allErrors?: boolean; strict?: boolean }) => {
  compile: (schema: unknown) => ValidateFunction;
  errorsText: (errors?: unknown[] | null) => string;
};

type ValidateFunction = ((value: unknown) => boolean) & {
  errors?: unknown[] | null;
};

const Ajv = ((AjvModule as any).default ?? AjvModule) as AjvConstructor;
const ajv = new Ajv({ allErrors: true, strict: false });

export type JsonSchema = Record<string, unknown>;

export function parseJsonFromText<T>(text: unknown, schema?: JsonSchema): T {
  const raw = typeof text === 'string' ? text : JSON.stringify(text);
  const extracted = extractJson(raw);
  let parsed: T;
  try {
    parsed = JSON.parse(extracted) as T;
  } catch {
    parsed = JSON.parse(jsonrepair(extracted)) as T;
  }

  if (schema) {
    const validate = ajv.compile(schema);
    if (!validate(parsed)) {
      throw new Error(`JSON does not match schema: ${ajv.errorsText(validate.errors)}`);
    }
  }

  return parsed;
}

export function validateJson<T>(value: unknown, schema: JSONSchemaType<T> | JsonSchema): T {
  const validate = ajv.compile(schema);
  if (!validate(value)) {
    throw new Error(`JSON does not match schema: ${ajv.errorsText(validate.errors)}`);
  }
  return value as T;
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return trimmed;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();

  const objectStart = trimmed.indexOf('{');
  const objectEnd = trimmed.lastIndexOf('}');
  if (objectStart >= 0 && objectEnd > objectStart) {
    return trimmed.slice(objectStart, objectEnd + 1);
  }

  const arrayStart = trimmed.indexOf('[');
  const arrayEnd = trimmed.lastIndexOf(']');
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    return trimmed.slice(arrayStart, arrayEnd + 1);
  }

  throw new Error('No JSON object or array found in model output.');
}
