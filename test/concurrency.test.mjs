import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createChatRunner } from '../src/chat-runner.mjs';
import { WebSessionStore } from '../src/session/store.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeRunner({ dataDir, delayMs = 60 }) {
  const events = { calls: [], maxInflight: 0, inflight: 0, queued: 0 };
  const log = {
    info(message, info) {
      if (message === '同一会话已有请求在跑，本次排队等待') events.queued += 1;
      void info;
    },
    warn() {},
    debug() {},
    error() {},
  };
  const web = {
    status: () => ({ layer: 'direct' }),
    async chat({ prompt, session }) {
      events.inflight += 1;
      events.maxInflight = Math.max(events.maxInflight, events.inflight);
      const call = {
        promptChars: prompt.length,
        reuse: Boolean(session?.reuse),
        chatSessionId: session?.chatSessionId ?? null,
        parent: session?.parentMessageId ?? null,
      };
      events.calls.push(call);
      await sleep(delayMs);
      // 会话 id 按调用顺序分配：新建会话返回新 id，复用则沿用传入的 id
      const chatSessionId = call.chatSessionId || `sess-${events.calls.length}`;
      events.inflight -= 1;
      return {
        text: 'ANSWER',
        reasoning: '',
        chatSessionId,
        messageId: `msg-${events.calls.length}`,
        sessionReused: call.reuse,
        sessionCreated: !call.reuse,
        sessionRebuilt: false,
        accountFingerprint: 'acc-1',
        elapsedMs: delayMs,
      };
    },
  };
  const sessions = new WebSessionStore({ dataDir, logger: log });
  const config = {
    runtime: {
      maxPromptChars: 100_000,
      maxAttachmentChars: 300_000,
      overflowToAttachment: true,
      sessionReuse: true,
    },
  };
  const runChat = createChatRunner({ config, log, web, sessions });
  return { runChat, events, sessions };
}

function request(conversationId, text = '相同的第一条消息') {
  return {
    messages: [
      { role: 'system', content: 'sys-SAME' },
      { role: 'user', content: text },
    ],
    tools: [],
    stream: false,
    conversationId,
  };
}

test('同一对话的两个并发请求串行：parent 依次为 null → 第一条 messageId', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuckds-conc-'));
  try {
    const { runChat, events } = makeRunner({ dataDir });
    const [a, b] = await Promise.all([runChat(request('conv-same')), runChat(request('conv-same'))]);

    assert.equal(events.maxInflight, 1, '同一会话的请求不能被并发打到上游');
    assert.equal(events.queued, 1, '第二个请求必须进入排队');
    assert.equal(events.calls.length, 2);
    // 第一条：新建会话，没有 parent
    assert.equal(events.calls[0].chatSessionId, null);
    assert.equal(events.calls[0].parent, null);
    // 第二条：排在第一条之后，复用同一网页会话，parent 指向第一条的 assistant message
    assert.equal(events.calls[1].reuse, true);
    assert.equal(events.calls[1].chatSessionId, events.calls[0].chatSessionId || 'sess-1');
    assert.equal(events.calls[1].parent, 'msg-1');
    assert.equal(a.session.created, true);
    assert.equal(b.session.reused, true);
    assert.equal(b.session.parentHash !== a.session.parentHash, true);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('同一对话的三个并发请求严格排序，parent 链不断', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuckds-conc3-'));
  try {
    const { runChat, events } = makeRunner({ dataDir, delayMs: 40 });
    const results = await Promise.all([
      runChat(request('conv-3')),
      runChat(request('conv-3')),
      runChat(request('conv-3')),
    ]);

    assert.equal(events.maxInflight, 1);
    assert.equal(events.queued, 2);
    assert.deepEqual(
      events.calls.map((call) => call.parent),
      [null, 'msg-1', 'msg-2'],
    );
    assert.equal(events.calls[1].chatSessionId, 'sess-1');
    assert.equal(events.calls[2].chatSessionId, 'sess-1');
    assert.deepEqual(
      results.map((r) => (r.session.created ? 'create' : 'reuse')),
      ['create', 'reuse', 'reuse'],
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('不同对话仍然并行（maxInflight=2），会话与 parent 互不影响', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuckds-conc2-'));
  try {
    const { runChat, events } = makeRunner({ dataDir, delayMs: 120 });
    const [a, b] = await Promise.all([runChat(request('conv-A')), runChat(request('conv-B'))]);

    assert.equal(events.maxInflight, 2, '不同会话键必须保持并行');
    assert.equal(events.queued, 0);
    assert.equal(events.calls[0].parent, null);
    assert.equal(events.calls[1].parent, null);
    assert.equal(events.calls[0].chatSessionId, null);
    assert.equal(events.calls[1].chatSessionId, null);
    assert.equal(a.session.created && b.session.created, true);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
