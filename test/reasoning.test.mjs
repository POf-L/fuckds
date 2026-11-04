import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeChatRequest } from '../src/openai/request.mjs';

const config = {
  deepseek: {
    thinking: 'always',
    modelAliases: {},
    defaultModel: 'deepseek-flash',
    search: false,
  },
};

const build = (extra) =>
  normalizeChatRequest(
    {
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
      ...extra,
    },
    config,
  );

test('reasoning_effort=none → thinking=false（variant「关」真实生效）', () => {
  const request = build({ reasoning_effort: 'none' });
  assert.equal(request.thinking, false);
});

test('reasoning_effort=off → thinking=false', () => {
  assert.equal(build({ reasoning_effort: 'off' }).thinking, false);
});

test('reasoning_effort=high/low/medium 都只映射为「开」，不伪造分档', () => {
  for (const effort of ['low', 'medium', 'high']) {
    assert.equal(build({ reasoning_effort: effort }).thinking, true, effort);
  }
});

test('显式 thinking 优先于 reasoning_effort', () => {
  assert.equal(build({ thinking: false, reasoning_effort: 'high' }).thinking, false);
  assert.equal(build({ thinking: true, reasoning_effort: 'none' }).thinking, true);
});
