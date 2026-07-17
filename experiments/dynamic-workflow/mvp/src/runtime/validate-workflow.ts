import * as acorn from 'acorn';
import * as walk from 'acorn-walk';

export type WorkflowValidationResult = {
  ok: boolean;
  normalizedSource: string;
  errors: string[];
};

const bannedIdentifiers = new Set([
  'Buffer',
  'Bun',
  'Deno',
  'Function',
  'WebSocket',
  'XMLHttpRequest',
  'eval',
  'fetch',
  'global',
  'globalThis',
  'module',
  'process',
  'require',
]);

const bannedProperties = new Set([
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
  '__proto__',
  'constructor',
  'prototype',
]);

export function validateWorkflowSource(source: string, maxScriptChars = 32_000): WorkflowValidationResult {
  const errors: string[] = [];
  if (source.length > maxScriptChars) {
    errors.push(`Script is too large: ${source.length} > ${maxScriptChars} chars.`);
  }

  const normalizedSource = normalizeWorkflowSource(source);

  let ast: acorn.Node;
  try {
    ast = acorn.parse(normalizedSource, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      locations: true,
    });
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    return { ok: false, normalizedSource, errors };
  }

  walk.fullAncestor(ast, (node: any, _state, ancestors) => {
    const location = node.loc?.start ? `${node.loc.start.line}:${node.loc.start.column}` : 'unknown';

    if (
      node.type === 'ImportDeclaration' ||
      node.type === 'ExportNamedDeclaration' ||
      node.type === 'ExportDefaultDeclaration' ||
      node.type === 'ExportAllDeclaration'
    ) {
      errors.push(`Import/export syntax is not allowed at ${location}.`);
    }

    if (node.type === 'WhileStatement' || node.type === 'DoWhileStatement') {
      errors.push(`Unbounded loop type ${node.type} is not allowed at ${location}; use pipeline() or for...of.`);
    }

    if (node.type === 'ForStatement' && !node.test) {
      errors.push(`for(;;) is not allowed at ${location}.`);
    }

    if (node.type === 'WithStatement') {
      errors.push(`with statements are not allowed at ${location}.`);
    }

    if (node.type === 'Identifier' && bannedIdentifiers.has(node.name)) {
      if (isSafePropertyKey(node, ancestors)) return;
      errors.push(`Identifier "${node.name}" is not allowed at ${location}.`);
    }

    if (node.type === 'CallExpression') {
      const callee = node.callee;
      if (callee?.type === 'Identifier' && (callee.name === 'eval' || callee.name === 'Function')) {
        errors.push(`Dynamic code execution is not allowed at ${location}.`);
      }
    }

    if (node.type === 'NewExpression') {
      const callee = node.callee;
      if (callee?.type === 'Identifier' && callee.name === 'Function') {
        errors.push(`new Function() is not allowed at ${location}.`);
      }
    }

    if (node.type === 'MemberExpression') {
      const propertyName = memberPropertyName(node);
      if (propertyName && bannedProperties.has(propertyName)) {
        errors.push(`Property "${propertyName}" is not allowed at ${location}.`);
      }
    }
  });

  return {
    ok: errors.length === 0,
    normalizedSource,
    errors: [...new Set(errors)],
  };
}

export function normalizeWorkflowSource(source: string): string {
  return source.replace(/\bexport\s+const\s+meta\s*=/, 'const meta =');
}

function memberPropertyName(node: any): string | undefined {
  if (!node.computed && node.property?.type === 'Identifier') return node.property.name;
  if (node.computed && node.property?.type === 'Literal' && typeof node.property.value === 'string') {
    return node.property.value;
  }
  return undefined;
}

function isSafePropertyKey(node: any, ancestors: any[]): boolean {
  const parent = ancestors[ancestors.length - 2];
  if (!parent) return false;

  if (parent.type === 'Property' && parent.key === node && !parent.computed) return true;
  if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) return true;
  if (parent.type === 'MethodDefinition' && parent.key === node && !parent.computed) return true;

  return false;
}
