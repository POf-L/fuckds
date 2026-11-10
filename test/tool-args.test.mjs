import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPrompt } from '../src/prompt/build.mjs';
import { SPECIAL_TOKENS_HEADER } from '../src/prompt/special.mjs';
import { coerceToolCallArguments, getToolSchemas, renderToolDeclarations } from '../src/prompt/tools.mjs';

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Search files',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'integer' },
          recursive: { type: 'boolean' },
          extensions: { type: 'array', items: { type: 'string' } },
          options: { type: 'object', properties: { case_sensitive: { type: 'boolean' } } },
        },
        required: ['query'],
      },
    },
  },
];

const schemas = getToolSchemas(TOOLS);

test('prompt teaches the sentinel protocol and strict parameter types', () => {
  assert.ok(SPECIAL_TOKENS_HEADER.includes('[[TOOL_CALL]]'));
  assert.ok(SPECIAL_TOKENS_HEADER.includes('[[/TOOL_CALL]]'));
  assert.ok(SPECIAL_TOKENS_HEADER.includes('NEVER omit'));
  assert.ok(SPECIAL_TOKENS_HEADER.includes('args / arguments / parameters'));
  const { prompt } = buildPrompt({
    messages: [{ role: 'user', content: 'hi' }],
    tools: TOOLS,
  });
  assert.ok(prompt.includes('[[TOOL_CALL]]'));
  // required is surfaced at the top level of the declaration, not only nested
  const decl = JSON.parse(renderToolDeclarations(TOOLS)[0]);
  assert.deepEqual(decl.required, ['query']);
});

test('coerce: stringified number/boolean/array/object are restored to their declared types', () => {
  const { arguments: args, warnings } = coerceToolCallArguments(
    {
      name: 'search_files',
      arguments: JSON.stringify({
        query: 'report',
        limit: '10',
        recursive: 'true',
        extensions: '["md","txt"]',
        options: '{"case_sensitive":"false"}',
      }),
    },
    schemas,
  );
  assert.deepEqual(JSON.parse(args), {
    query: 'report',
    limit: 10,
    recursive: true,
    extensions: ['md', 'txt'],
    options: { case_sensitive: false },
  });
  assert.ok(warnings.length === 0, 'coercible values should not warn');
});

test('coerce: single args wrapper is unwrapped, case typo is renamed, missing required only warns', () => {
  const wrapped = coerceToolCallArguments(
    { name: 'search_files', arguments: JSON.stringify({ args: { query: 'x', limit: 3 } }) },
    schemas,
  );
  assert.deepEqual(JSON.parse(wrapped.arguments), { query: 'x', limit: 3 });
  assert.ok(wrapped.warnings.some((w) => w.includes('unwrapped')));

  const renamed = coerceToolCallArguments(
    { name: 'search_files', arguments: JSON.stringify({ Query: 'x' }) },
    schemas,
  );
  assert.deepEqual(JSON.parse(renamed.arguments), { query: 'x' });

  const missing = coerceToolCallArguments(
    { name: 'search_files', arguments: JSON.stringify({ limit: 3 }) },
    schemas,
  );
  // Missing values are never invented.
  assert.deepEqual(JSON.parse(missing.arguments), { limit: 3 });
  assert.ok(missing.warnings.some((w) => w.includes('missing required')));
});

test('coerce: unknown tool is returned untouched', () => {
  const call = { name: 'not_declared', arguments: '{"limit":"10"}' };
  const { arguments: args, warnings } = coerceToolCallArguments(call, schemas);
  assert.equal(args, call.arguments);
  assert.deepEqual(warnings, []);
});
