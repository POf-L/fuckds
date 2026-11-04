import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildDeltaPrompt, collectToolNamesById } from '../src/prompt/build.mjs';
import {
  WebSessionStore,
  conversationKey,
  messageHash,
} from '../src/session/store.mjs';

const SYSTEM = { role: 'system', content: '你是助手。' };
const USER1 = { role: 'user', content: '记住词：雨伞' };
const ASSISTANT1 = { role: 'assistant', content: '好的，记住了。' };

function tmpStore(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuckds-session-'));
  return { store: new WebSessionStore({ dataDir: dir, ...options }), dir, file: path.join(dir, 'web-sessions.json') };
}

test('会话键：同一开头稳定，不同开头不同', () => {
  const a = conversationKey([SYSTEM, USER1]);
  const b = conversationKey([SYSTEM, { role: 'user', content: '记住词：雨伞' }]);
  const c = conversationKey([SYSTEM, { role: 'user', content: '另一个话题' }]);
  assert.equal(a.key, b.key);
  assert.equal(a.source, 'prefix');
  assert.notEqual(a.key, c.key);
});

test('会话键：客户端显式 id 优先', () => {
  const a = conversationKey([SYSTEM, USER1], 'conv-123');
  assert.equal(a.source, 'client');
  assert.equal(a.key, conversationKey([{ role: 'user', content: '别的' }], 'conv-123').key);
});

test('messageHash：同样内容稳定，工具参数顺序不影响语义', () => {
  assert.equal(messageHash(USER1), messageHash({ ...USER1 }));
  const callA = { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read', arguments: '{"path":"a"}' } }] };
  const callB = { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read', arguments: '{"path":"a"}' } }] };
  assert.equal(messageHash(callA), messageHash(callB));
});

test('plan/commit：首轮 new，次轮复用且只发新增 user', () => {
  const { store } = tmpStore();
  const first = store.plan([SYSTEM, USER1]);
  assert.equal(first.reuse, false);
  assert.equal(first.reason, 'new-conversation');
  assert.ok(first.key);

  store.commit(first.key, {
    chatSessionId: 'sess-1',
    lastMessageId: 'msg-1',
    sentHashes: first.hashes,
  });
  assert.equal(store.entries.get(first.key).turns, 1);

  const second = store.plan([SYSTEM, USER1, ASSISTANT1, { role: 'user', content: '下一问' }]);
  assert.equal(second.reuse, true);
  // stored 2 条 + 跳过我方 assistant → 从 index 3 开始
  assert.equal(second.deltaFrom, 3);
  assert.equal(second.entry.chatSessionId, 'sess-1');
});

test('plan：工具结果那轮跳过 assistant，只发 tool 消息', () => {
  const { store } = tmpStore();
  const first = store.plan([SYSTEM, USER1]);
  store.commit(first.key, { chatSessionId: 'sess-2', lastMessageId: 'msg-2', sentHashes: first.hashes });

  const assistantWithCall = {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"a.txt"}' } }],
  };
  const toolResult = { role: 'tool', tool_call_id: 'call_1', content: 'ok' };
  const second = store.plan([SYSTEM, USER1, assistantWithCall, toolResult]);
  assert.equal(second.reuse, true);
  assert.equal(second.deltaFrom, 3);
  assert.equal(store.plan([SYSTEM, USER1, assistantWithCall, toolResult]).entry.chatSessionId, 'sess-2');
});

test('plan：历史分叉不再复用（同开头、中间消息被改）', () => {
  const { store } = tmpStore();
  const user2 = { role: 'user', content: '第二问' };
  const first = store.plan([SYSTEM, USER1, ASSISTANT1, user2]);
  store.commit(first.key, { chatSessionId: 'sess-3', lastMessageId: 'msg-3', sentHashes: first.hashes });

  const editedAssistant = { role: 'assistant', content: '（被客户端改写）' };
  const second = store.plan([SYSTEM, USER1, editedAssistant, user2, { role: 'user', content: '继续' }]);
  assert.equal(second.reuse, false);
  assert.equal(second.reason, 'history-diverged');
});

test('plan：TTL 过期与重启后恢复', () => {
  const { store, dir } = tmpStore({ ttlMs: 10 });
  const first = store.plan([SYSTEM, USER1]);
  store.commit(first.key, { chatSessionId: 'sess-4', lastMessageId: 'msg-4', sentHashes: first.hashes });
  assert.equal(fs.existsSync(path.join(dir, 'web-sessions.json')), true);

  const reloaded = new WebSessionStore({ dataDir: dir, ttlMs: 60 * 60_000 });
  const again = reloaded.plan([SYSTEM, USER1, ASSISTANT1, { role: 'user', content: '继续' }]);
  assert.equal(again.reuse, true);
  assert.equal(again.entry.chatSessionId, 'sess-4');
});

test('buildDeltaPrompt：只渲染增量，不重放 system/工具声明', () => {
  const messages = [SYSTEM, USER1, ASSISTANT1, { role: 'user', content: '继续' }];
  const delta = buildDeltaPrompt({ messages, from: 3 });
  assert.equal(delta.prompt, '## User:\n继续');
  assert.ok(!delta.prompt.includes('你是助手'));
  assert.ok(!delta.prompt.includes('Tool_functions'));
});

test('buildDeltaPrompt：tool 结果用 tool_call_id 找回工具名并附最终答案提示', () => {
  const assistantWithCall = {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'shell', arguments: '{"command":"node -v"}' } }],
  };
  const toolResult = { role: 'tool', tool_call_id: 'call_9', content: 'v24.18.0' };
  const messages = [SYSTEM, USER1, assistantWithCall, toolResult];
  const names = collectToolNamesById(messages);
  assert.equal(names.call_9, 'shell');

  const delta = buildDeltaPrompt({ messages, from: 3, toolNameById: names });
  assert.ok(delta.prompt.includes('[[TOOL_RESULT]]{"name":"shell"'));
  assert.ok(delta.prompt.includes('v24.18.0'));
  assert.ok(!delta.prompt.includes('[[TOOL_CALL]]'));
});
