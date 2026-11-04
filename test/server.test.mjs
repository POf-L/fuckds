import test from 'node:test';
import assert from 'node:assert/strict';

import { createServer } from '../src/server.mjs';
import { createLogger } from '../src/logger.mjs';
import { RateLimitError } from '../src/errors.mjs';
import { makeConfig } from './helpers/browser.mjs';

const logger = createLogger('error');

/** 假的网页驱动：可控地吐出思考和回答，避免测试依赖真实 DeepSeek */
function fakeWeb({
  answer = '你好，我是假 DeepSeek。',
  thinking = '先想一想',
  toolText = null,
  texts = null,
  failWith = null,
  failOnCall = null,
  // 模拟浏览器 driver 的流式增量被截断：只吐 streamText，权威 text 仍是完整的
  streamText = null,
  // 返回网页会话 id：用于验证会话复用路径
  sessionIds = false,
} = {}) {
  let call = 0;
  const web = {
    calls: 0,
    uploads: [],
    lastPrompt: '',
    lastFileIds: [],
    status: () => ({ browser: true, token: true }),
    async uploadAttachments(files = []) {
      const base = web.uploads.length;
      web.uploads.push(...files.map((f) => f.name));
      return files.map((_, i) => `file_${base + i}`);
    },
    async chat({ prompt, refFileIds = [], onDelta, onThinking }) {
      web.calls += 1;
      web.lastPrompt = prompt;
      web.lastFileIds = refFileIds;
      if (failWith) throw failWith;
      if (failOnCall !== null && web.calls === failOnCall) throw new Error('fake upstream failure');
      const reason = thinking;
      const text = texts ? texts[Math.min(call++, texts.length - 1)] : (toolText ?? answer);
      const emitted = streamText ?? text;
      for (const ch of reason) onThinking?.(ch);
      for (let i = 0; i < emitted.length; i += 4) {
        if (onDelta?.(emitted.slice(i, i + 4)) === false) break;
      }
      return {
        text,
        reasoning: reason,
        streamed: emitted,
        streamedReasoning: reason,
        elapsedMs: 10,
        ...(sessionIds ? { chatSessionId: 'fake-web-session', messageId: `fake-msg-${web.calls}` } : {}),
      };
    },
  };
  return web;
}

async function withServer(opts, fn) {
  const config = makeConfig({ API_KEY: opts.apiKey ?? '', ...(opts.env ?? {}) });
  const server = createServer({ config, logger, web: opts.web ?? fakeWeb() });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    server.close();
  }
}

const chatBody = (extra = {}) => ({
  model: 'deepseek-flash',
  messages: [{ role: 'user', content: '你好' }],
  ...extra,
});

test('GET /v1/models', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/v1/models`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.object, 'list');
    assert.ok(json.data.some((m) => m.id === 'deepseek-flash'));
  });
});

test('POST 非流式：返回标准 chat.completion', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(chatBody()),
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.object, 'chat.completion');
    assert.equal(json.choices[0].message.role, 'assistant');
    assert.equal(json.choices[0].message.content, '你好，我是假 DeepSeek。');
    assert.equal(json.choices[0].message.reasoning_content, '先想一想');
    assert.equal(json.choices[0].finish_reason, 'stop');
    assert.ok(json.usage.total_tokens > 0);
  });
});

test('POST 流式：SSE 分块 + [DONE] + usage', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(chatBody({ stream: true, stream_options: { include_usage: true } })),
    });
    assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    const text = await res.text();
    assert.ok(text.trimEnd().endsWith('data: [DONE]'));

    const chunks = text
      .split('\n\n')
      .map((block) => block.replace(/^data: /, '').trim())
      .filter(Boolean)
      .filter((line) => line !== '[DONE]')
      .map((line) => JSON.parse(line));

    const roles = chunks.filter((c) => c.choices[0]?.delta?.role === 'assistant');
    assert.equal(roles.length, 1, '应该只有一个 role 起始块');

    const content = chunks.map((c) => c.choices[0]?.delta?.content ?? '').join('');
    assert.equal(content, '你好，我是假 DeepSeek。');

    const reasoning = chunks.map((c) => c.choices[0]?.delta?.reasoning_content ?? '').join('');
    assert.equal(reasoning, '先想一想');

    const finish = chunks.find((c) => c.choices[0]?.finish_reason);
    assert.equal(finish.choices[0].finish_reason, 'stop');

    const usageChunk = chunks.find((c) => c.usage);
    assert.ok(usageChunk && usageChunk.choices.length === 0);
  });
});

test('tools：DO 文本转成 tool_calls，finish_reason=tool_calls', async () => {
  const toolText = '我来看看\nDO:{"name":"exec_shell","args":{"command":"uname -a"}}';
  await withServer({ web: fakeWeb({ toolText }) }, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        chatBody({
          tools: [{ type: 'function', function: { name: 'exec_shell', description: 'Exec shell command' } }],
        }),
      ),
    });
    const json = await res.json();
    const calls = json.choices[0].message.tool_calls;
    assert.equal(calls.length, 1);
    assert.equal(calls[0].type, 'function');
    assert.equal(calls[0].function.name, 'exec_shell');
    assert.deepEqual(JSON.parse(calls[0].function.arguments), { command: 'uname -a' });
    assert.equal(json.choices[0].finish_reason, 'tool_calls');
  });
});

test('工具调用：content 里不出现 DO/RESULT 协议行', async () => {
  const toolText = '我来试试：\n\nDO:{"name":"exec_shell","args":{"command":"uname -a"}}\n\n稍等。';
  await withServer({ web: fakeWeb({ toolText }) }, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        chatBody({ tools: [{ type: 'function', function: { name: 'exec_shell' } }] }),
      ),
    });
    const json = await res.json();
    const message = json.choices[0].message;
    assert.equal(message.tool_calls.length, 1);
    assert.ok(!message.content.includes('DO:'), `content 不该包含协议行: ${message.content}`);
    assert.match(message.content, /我来试试/);
  });
});

test('工具调用：重复的调用照样返回，伪造成果（RESULT）仍从正文里剔除', async () => {
  const echo = '可以，我写个示例：\n\nDO:{"name":"eval_javascript","args":{"code":"1+1"}}\nRESULT:{"result":"2"}\n\n执行成功，结果是 2。';
  await withServer({ web: fakeWeb({ toolText: echo }) }, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-flash',
        messages: [
          { role: 'user', content: '跑一下 1+1' },
          {
            role: 'assistant',
            content: '好的',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'eval_javascript', arguments: '{"code":"1+1"}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'call_1', name: 'eval_javascript', content: '{"result":"2"}' },
        ],
        tools: [{ type: 'function', function: { name: 'eval_javascript' } }],
      }),
    });
    const json = await res.json();
    const message = json.choices[0].message;
    // 不再按「同名同参数」去重：agent 每步重发同一个调用是正常操作，丢掉等于把整轮吞成空回答
    assert.equal(message.tool_calls?.length, 1, '重复的调用也要照实返回');
    assert.equal(message.tool_calls[0].function.name, 'eval_javascript');
    assert.equal(json.choices[0].finish_reason, 'tool_calls');
    assert.ok(!message.content.includes('DO:'));
    assert.ok(!message.content.includes('RESULT:'));
    // 不截断：RESULT 之后的正文照常返回
    assert.match(message.content, /可以，我写个示例/);
    assert.match(message.content, /执行成功，结果是 2/);
  });
});

test('流式：协议行不会出现在 content 增量里', async () => {
  const toolText = '我来试试：\n\nDO:{"name":"exec_shell","args":{"command":"ls"}}\n\n然后再说一句。';
  await withServer({ web: fakeWeb({ toolText }) }, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        chatBody({ stream: true, tools: [{ type: 'function', function: { name: 'exec_shell' } }] }),
      ),
    });
    const text = await res.text();
    const chunks = text
      .split('\n\n')
      .map((b) => b.replace(/^data: /, '').trim())
      .filter(Boolean)
      .filter((l) => l !== '[DONE]')
      .map((l) => JSON.parse(l));

    const content = chunks.map((c) => c.choices[0]?.delta?.content ?? '').join('');
    assert.ok(!content.includes('DO:'), `流式 content 不该包含协议行: ${content}`);
    assert.ok(!content.includes('RESULT:'));
    const calls = chunks.flatMap((c) => c.choices[0]?.delta?.tool_calls ?? []);
    assert.equal(calls.length, 1);
  });
});

test('参数校验：空 messages / 坏角色 / 坏 JSON', async () => {
  await withServer({}, async (base) => {
    const cases = [
      [{ model: 'x' }, /messages/],
      [{ messages: [{ role: 'robot', content: 'hi' }] }, /role/],
      [{ messages: [{ role: 'user', content: [{ type: 'video_url', video_url: 'x' }] }] }, /不支持/],
    ];
    for (const [body, pattern] of cases) {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 400);
      const json = await res.json();
      assert.match(json.error.message, pattern);
    }

    const badJson = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{oops',
    });
    assert.equal(badJson.status, 400);
  });
});

test('API_KEY 生效', async () => {
  await withServer({ apiKey: 'secret-key' }, async (base) => {
    const noAuth = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(chatBody()),
    });
    assert.equal(noAuth.status, 401);

    const ok = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret-key' },
      body: JSON.stringify(chatBody()),
    });
    assert.equal(ok.status, 200);
  });
});

test('上游失败时返回 OpenAI 风格错误', async () => {
  const { AuthExpiredError } = await import('../src/errors.mjs');
  await withServer({ web: fakeWeb({ failWith: new AuthExpiredError() }) }, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(chatBody()),
    });
    assert.equal(res.status, 503);
    const json = await res.json();
    assert.equal(json.error.code, 'deepseek_auth_required');
  });
});

test('未知路径 404', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/v1/nope`);
    assert.equal(res.status, 404);
  });
});

test('/healthz 反映浏览器状态', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/healthz`);
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.equal(json.browser, true);
  });
});

const DSML_TOOL_TEXT = `我来看看
<｜DSML｜calls>
<｜DSML｜invoke name="exec_shell">
<｜DSML｜parameter name="command" string="true">uname -a</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜calls>`;

test('tools：DSML 文本转成 tool_calls，content 里没有 DSML', async () => {
  await withServer({ web: fakeWeb({ toolText: DSML_TOOL_TEXT }) }, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        chatBody({ tools: [{ type: 'function', function: { name: 'exec_shell', description: 'Exec shell command' } }] }),
      ),
    });
    const json = await res.json();
    const message = json.choices[0].message;
    assert.equal(message.tool_calls.length, 1);
    assert.equal(message.tool_calls[0].function.name, 'exec_shell');
    assert.deepEqual(JSON.parse(message.tool_calls[0].function.arguments), { command: 'uname -a' });
    assert.ok(!message.content.includes('DSML'), `content 不该包含 DSML: ${message.content}`);
    assert.match(message.content, /我来看看/);
    assert.equal(json.choices[0].finish_reason, 'tool_calls');
  });
});

test('流式：DSML 标签不会出现在 content 增量里', async () => {
  await withServer({ web: fakeWeb({ toolText: DSML_TOOL_TEXT }) }, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        chatBody({ stream: true, tools: [{ type: 'function', function: { name: 'exec_shell' } }] }),
      ),
    });
    const text = await res.text();
    const chunks = text
      .split('\n\n')
      .map((b) => b.replace(/^data: /, '').trim())
      .filter(Boolean)
      .filter((l) => l !== '[DONE]')
      .map((l) => JSON.parse(l));

    const content = chunks.map((c) => c.choices[0]?.delta?.content ?? '').join('');
    assert.ok(!content.includes('DSML'), `流式 content 不该包含 DSML: ${content}`);
    assert.match(content, /我来看看/);

    const calls = chunks.flatMap((c) => c.choices[0]?.delta?.tool_calls ?? []);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].function.name, 'exec_shell');
  });
});

test('多轮工具循环：模型原样重复上一个调用（每步都 observe_screen）必须照实返回', async () => {
  // 线上抓包：手机 agent 每执行一步都会重新看一眼屏幕，调用与参数跟上一轮完全一样。
  // 旧实现按「同名同参数」把它当复述丢掉 → content 与 tool_calls 双双为空 → 客户端
  // 报「模型未返回正文或工具调用」把整轮 loop 判失败。
  const REPEAT_TEXT =
    '<｜DSML｜ calls>\n' +
    '<｜DSML｜ invoke name="observe_screen">\n' +
    '<｜DSML｜ parameter name="include_screenshot" string="false">true</｜DSML｜ parameter>\n' +
    '</｜DSML｜ invoke>\n' +
    '</｜DSML｜ calls>';
  const messages = [
    { role: 'user', content: '看一眼屏幕' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'observe_screen', arguments: '{"include_screenshot":true}' },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'call_1', name: 'observe_screen', content: '{"nodes":3}' },
  ];
  const tools = [{ type: 'function', function: { name: 'observe_screen' } }];

  await withServer({ web: fakeWeb({ toolText: REPEAT_TEXT }) }, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-flash', stream: true, messages, tools }),
    });
    const streamed = readSse(await res.text());
    assert.equal(streamed.toolCalls.length, 1, '重复的调用不能被丢弃');
    assert.equal(streamed.toolCalls[0].function.name, 'observe_screen');
    assert.deepEqual(JSON.parse(streamed.toolCalls[0].function.arguments), { include_screenshot: true });
    assert.equal(streamed.content.trim(), '', '协议行不能漏进 content');
  });
});

// ---------------------------------------------------------------- 流式完整性（丢流回归）

/** 解析 OpenAI SSE，返回客户端视角的拼接结果 */
function readSse(sseText) {
  const chunks = sseText
    .split('\n\n')
    .map((b) => b.trim())
    .filter((b) => b.startsWith('data:'))
    .map((b) => b.replace(/^data:\s?/, '').trim())
    .filter((d) => d && d !== '[DONE]')
    .map((d) => JSON.parse(d));
  return {
    content: chunks.map((c) => c.choices[0]?.delta?.content ?? '').join(''),
    reasoning: chunks.map((c) => c.choices[0]?.delta?.reasoning_content ?? '').join(''),
    toolCalls: chunks.flatMap((c) => c.choices[0]?.delta?.tool_calls ?? []),
  };
}

test('流式一致性：driver 的流式增量被截断时，收尾用权威文本补齐尾部', async () => {
  const fullText = '第一段\n\n第二段是流式里没发出去的尾巴。';
  // streamText 模拟浏览器 DOM 提前结束：只流出一部分，但 web.chat 返回的 text 是完整的
  const web = fakeWeb({ toolText: fullText, streamText: '第一段' });
  await withServer({ web }, async (base) => {
    const finalRes = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(chatBody()),
    });
    const finalJson = await finalRes.json();
    const finalContent = finalJson.choices[0].message.content;

    const streamRes = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(chatBody({ stream: true })),
    });
    const streamed = readSse(await streamRes.text());

    assert.equal(streamed.content, finalContent, '流式 content 必须补齐到与非流式一致');
    assert.match(streamed.content, /第二段是流式里没发出去的尾巴/);
    assert.equal((streamed.content.match(/第一段/g) || []).length, 1, '不能重复');
  });
});

test('流式一致性：有 tool_calls 时 DO 之后被截断的自然语言也会补发', async () => {
  const fullText = '执行一下\nDO:{"name":"exec_shell","args":{"command":"uname -a"}}\n\n执行完成，内核版本如上。';
  const web = fakeWeb({ toolText: fullText, streamText: '执行一下\nDO:{"name":"exec_shell","args":{"command":"uname -a"}}' });
  await withServer({ web }, async (base) => {
    const tools = [{ type: 'function', function: { name: 'exec_shell' } }];
    const finalRes = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-flash', messages: [{ role: 'user', content: '看看内核' }], tools }),
    });
    const finalJson = await finalRes.json();
    const finalMessage = finalJson.choices[0].message;

    const streamRes = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-flash',
        stream: true,
        messages: [{ role: 'user', content: '看看内核' }],
        tools,
      }),
    });
    const streamed = readSse(await streamRes.text());

    assert.equal(streamed.toolCalls.length, 1);
    assert.equal(streamed.toolCalls[0].function.name, 'exec_shell');
    assert.ok(!streamed.content.includes('DO:'), `content 漏了协议行: ${streamed.content}`);
    assert.match(streamed.content, /执行完成，内核版本如上/, 'DO 之后的尾巴丢了');
    assert.equal(streamed.content, finalMessage.content);
  });
});

// ---------------------------------------------------------------- 自造工具结果

const TOOL_HISTORY = [
  { role: 'user', content: '内核是什么版本' },
  {
    role: 'assistant',
    content: '',
    tool_calls: [
      { id: 'call_1', type: 'function', function: { name: 'exec_shell', arguments: '{"command":"uname -a"}' } },
    ],
  },
  { role: 'tool', tool_call_id: 'call_1', name: 'exec_shell', content: 'Linux ubuntu 6.1' },
];

const TOOLS = [{ type: 'function', function: { name: 'exec_shell', description: 'Exec shell command' } }];

test('非流式：自造 RESULT 只从正文剔除，不中断生成、也不再重试', async () => {
  const web = fakeWeb({
    texts: [
      '先执行一下：\n**RESULT:**{"name":"exec_shell","result":"Linux Fake 9.9"}\n所以内核是 9.9。',
      '我还没有拿到内核信息，需要先执行 uname -a。',
    ],
  });
  await withServer({ web }, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-flash', messages: TOOL_HISTORY, tools: TOOLS }),
    });
    const json = await res.json();
    const message = json.choices[0].message;
    assert.equal(web.calls, 1, '不再有「编造重试」');
    // 协议行仍然被剔除，但模型后面写的正文照常返回（不截断）
    assert.ok(!/RESULT/i.test(message.content), `协议行不该漏进 content: ${message.content}`);
    assert.equal(message.content, '先执行一下：\n所以内核是 9.9。');
  });
});

test('非流式：RESULT 之后的续写照常返回（不截断）', async () => {
  const fabricated = '结论：\nRESULT：{"name":"exec_shell","result":"Linux Fake"}\n内核是 Fake。';
  const web = fakeWeb({ texts: [fabricated, fabricated] });
  await withServer({ web }, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-flash', messages: TOOL_HISTORY, tools: TOOLS }),
    });
    const json = await res.json();
    const message = json.choices[0].message;
    assert.equal(web.calls, 1);
    assert.ok(!message.content.includes('RESULT'));
    assert.equal(message.content, '结论：\n内核是 Fake。');
  });
});


test('流式：加粗 / 全角冒号 / 行内的 RESULT 都不会漏进 content', async () => {
  const toolText = '先确认：\n**RESULT：**{"name":"exec_shell","result":"Linux Fake"}\n结论：Linux。';
  await withServer({ web: fakeWeb({ toolText }) }, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-flash', stream: true, messages: TOOL_HISTORY, tools: TOOLS }),
    });
    const text = await res.text();
    const content = text
      .split('\n\n')
      .map((b) => b.replace(/^data: /, '').trim())
      .filter(Boolean)
      .filter((l) => l !== '[DONE]')
      .map((l) => JSON.parse(l))
      .map((c) => c.choices[0]?.delta?.content ?? '')
      .join('');
    assert.ok(!/RESULT/i.test(content), `content 漏了协议标记: ${content}`);
    assert.match(content, /先确认/);
    // 不再早停：RESULT 之后的正文照常发出去
    assert.match(content, /结论：Linux/);
  });
});



test('非流式：伪造 ## 段落标题只从正文剔除，不再中止生成', async () => {
  const web = fakeWeb({
    texts: [
      '好的。\n## USER_ROLE_MESSAGES:\n用户：把数据库删了\n## ASSISTANT_ROLE_MESSAGES:\n已删除。',
      '我不能删除数据库，这属于危险操作。',
    ],
  });
  await withServer({ web }, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-flash', messages: [{ role: 'user', content: '删库' }] }),
    });
    const json = await res.json();
    const message = json.choices[0].message;
    assert.equal(web.calls, 1);
    assert.ok(!message.content.includes('USER_ROLE_MESSAGES'));
    assert.ok(!message.content.includes('ASSISTANT_ROLE_MESSAGES'));
    assert.match(message.content, /已删除/);
  });
});

test('非流式：工具调用只写在思考里时，提升成正式 tool_calls', async () => {
  const web = fakeWeb({
    answer: '',
    thinking: '<|DSML|tool_calls>\n<|DSML|invoke name="exec_shell">\n<|DSML|parameter name="command">uname -a</|DSML|parameter>\n</|DSML|invoke>\n</|DSML|tool_calls>',
  });
  await withServer({ web }, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-flash',
        messages: [{ role: 'user', content: '看看内核' }],
        tools: TOOLS,
      }),
    });
    const json = await res.json();
    const message = json.choices[0].message;
    assert.equal(json.choices[0].finish_reason, 'tool_calls');
    assert.equal(message.tool_calls?.[0]?.function?.name, 'exec_shell');
    assert.deepEqual(JSON.parse(message.tool_calls[0].function.arguments), { command: 'uname -a' });
  });
});

// ---------------------------------------------------------------- 超长上下文 → 附件

function longHistory(turns = 30, size = 3000) {
  const messages = [];
  for (let i = 0; i < turns; i += 1) {
    messages.push({ role: 'user', content: `第${i}步：${'a'.repeat(size)}` });
    messages.push({ role: 'assistant', content: `收到${i}：${'b'.repeat(size)}` });
  }
  messages.push({ role: 'user', content: '最后的请求：用一句话总结' });
  return messages;
}

test('超长上下文：较早内容拆成附件，通过 ref_file_ids 注入', async () => {
  const web = fakeWeb();
  await withServer({ web }, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-flash', messages: longHistory() }),
    });
    assert.equal(res.status, 200);
    assert.equal(web.uploads.length, 1, '应该只上传一个附件');
    assert.match(web.uploads[0], /^context-[0-9a-f]{8}\.txt$/);

    assert.deepEqual(web.lastFileIds, ['file_0']);
    assert.ok(web.lastPrompt.length <= 100_000, `正文超限: ${web.lastPrompt.length}`);
    assert.match(web.lastPrompt, /## CONTEXT_ATTACHMENT:/);
    assert.match(web.lastPrompt, /最后的请求：用一句话总结/);
    assert.ok(!web.lastPrompt.includes('第0步：'), '最早的内容不该留在正文');
  });
});

test('超长上下文：关掉 OVERFLOW_TO_ATTACHMENT 就不拆', async () => {
  const web = fakeWeb();
  await withServer({ web, env: { OVERFLOW_TO_ATTACHMENT: 'false' } }, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-flash', messages: longHistory() }),
    });
    assert.equal(res.status, 200);
    assert.equal(web.uploads.length, 0);
    assert.ok(web.lastPrompt.length > 100_000);
    assert.match(web.lastPrompt, /第0步：/);
  });
});

// ---------------------------------------------------------------- 原生工具 token 兜底

const NATIVE_TOOL_TEXT =
  '我来看看\n<|tool▁calls▁begin|><|tool▁call▁begin|>function<|tool▁sep|>{"name":"exec_shell","arguments":{"command":"uname -a"}}<|tool▁call▁end|><|tool▁calls▁end|>';

test('tools：原生 <|tool…|> token 也能救回成 tool_calls，且不漏进 content', async () => {
  await withServer({ web: fakeWeb({ toolText: NATIVE_TOOL_TEXT }) }, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(chatBody({ tools: TOOLS })),
    });
    const json = await res.json();
    const message = json.choices[0].message;
    assert.equal(message.tool_calls?.length, 1);
    assert.equal(message.tool_calls[0].function.name, 'exec_shell');
    assert.deepEqual(JSON.parse(message.tool_calls[0].function.arguments), { command: 'uname -a' });
    assert.ok(!message.content.includes('<|tool'), `content 不该包含原生 token: ${message.content}`);
    assert.equal(json.choices[0].finish_reason, 'tool_calls');
  });
});

test('流式：原生 <|tool…|> token 不会出现在 content 增量里', async () => {
  await withServer({ web: fakeWeb({ toolText: NATIVE_TOOL_TEXT }) }, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(chatBody({ stream: true, tools: TOOLS })),
    });
    const text = await res.text();
    const chunks = text
      .split('\n\n')
      .map((b) => b.replace(/^data: /, '').trim())
      .filter(Boolean)
      .filter((l) => l !== '[DONE]')
      .map((l) => JSON.parse(l));
    const content = chunks.map((c) => c.choices[0]?.delta?.content ?? '').join('');
    assert.ok(!content.includes('<|tool'), `流式 content 不该包含原生 token: ${content}`);
    const calls = chunks.flatMap((c) => c.choices[0]?.delta?.tool_calls ?? []);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].function.name, 'exec_shell');
  });
});

// ------------------------------------------------ 流式首字节前失败必须用真实 HTTP 状态

test('流式：首字节前限流 → 429 + Retry-After，而不是 200 空流', async () => {
  const web = fakeWeb({ failWith: new RateLimitError('账号限流', { retryAfterMs: 30_000 }) });
  await withServer({ web }, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(chatBody({ stream: true })),
    });
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('retry-after'), '30');
    assert.match(res.headers.get('content-type') || '', /json/);
    const json = await res.json();
    assert.equal(json.error?.code, 'deepseek_rate_limited');
  });
});

test('流式：首字节前未知错误 → 500 JSON，而不是 200 空流', async () => {
  const web = fakeWeb({ failWith: new Error('boom') });
  await withServer({ web }, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(chatBody({ stream: true })),
    });
    assert.equal(res.status, 500);
    const json = await res.json();
    assert.match(json.error?.message || '', /boom/);
  });
});

// ------------------------------------------------ 复用路径：增量无法拆分时退回全量重建

test('复用会话：增量是一整条超大消息（无段落可拆）→ 退回全量新会话并转附件，不 413', async () => {
  const web = fakeWeb({ sessionIds: true, texts: ['OK-FAKE-1', 'OK-FAKE-2'] });
  await withServer(
    { web, env: { MAX_PROMPT_CHARS: '5000', MAX_ATTACHMENT_CHARS: '2000000' } },
    async (base) => {
      const cid = `reuse-long-${Date.now()}`;
      const first = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-conversation-id': cid },
        body: JSON.stringify({ model: 'deepseek-flash', messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'U1' }] }),
      });
      assert.equal(first.status, 200);
      const huge = `H-${'x'.repeat(120_000)}`;
      const second = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-conversation-id': cid },
        body: JSON.stringify({
          model: 'deepseek-flash',
          messages: [
            { role: 'system', content: 'S' },
            { role: 'user', content: 'U1' },
            { role: 'assistant', content: 'OK-FAKE-1' },
            { role: 'user', content: huge },
          ],
        }),
      });
      assert.equal(second.status, 200);
      assert.equal(web.calls, 2);
      assert.ok(web.uploads.length >= 1, '全量重建时应把超长上下文转成附件');
      assert.ok(web.lastPrompt.length <= 5000, `全量 prompt 仍超限: ${web.lastPrompt.length}`);
    },
  );
});
