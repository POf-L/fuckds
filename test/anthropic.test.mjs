import test from 'node:test';
import assert from 'node:assert/strict';

import { createServer } from '../src/server.mjs';
import { createLogger } from '../src/logger.mjs';
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
  // 同上：思考增量被截断（DOM 折叠思考块）
  streamThinking = null,
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
    async uploadImages(images = []) {
      web.uploadedImages = (web.uploadedImages ?? 0) + images.length;
      return images.map((_, i) => `img_${i}`);
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
      const emittedReason = streamThinking ?? reason;
      for (const ch of emittedReason) onThinking?.(ch);
      for (let i = 0; i < emitted.length; i += 4) {
        if (onDelta?.(emitted.slice(i, i + 4)) === false) break;
      }
      return { text, reasoning: reason, streamed: emitted, streamedReasoning: reason, elapsedMs: 10 };
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

const post = (base, path, body, headers = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const simpleBody = (extra = {}) => ({
  model: 'deepseek-flash',
  max_tokens: 1024,
  messages: [{ role: 'user', content: '你好' }],
  ...extra,
});

/** 把 Anthropic SSE 文本解析成 [{ event, data }] */
function parseSse(text) {
  return text
    .split('\n\n')
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block.split('\n');
      const event = lines.find((l) => l.startsWith('event: '))?.slice(7).trim();
      const dataLine = lines.find((l) => l.startsWith('data: '))?.slice(6);
      return { event, data: dataLine ? JSON.parse(dataLine) : null };
    });
}

test('Anthropic 非流式：返回标准 message + text 块', async () => {
  await withServer({ web: fakeWeb({ answer: '这是回答。' }) }, async (base) => {
    const res = await post(base, '/v1/messages', simpleBody());
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.type, 'message');
    assert.equal(json.role, 'assistant');
    assert.equal(json.model, 'deepseek-flash');
    assert.equal(json.stop_reason, 'end_turn');
    assert.equal(json.stop_sequence, null);
    assert.ok(Array.isArray(json.content));
    const text = json.content.find((b) => b.type === 'text');
    assert.equal(text.text, '这是回答。');
    assert.ok(json.usage.input_tokens > 0);
    assert.ok(json.usage.output_tokens > 0);
    assert.ok(json.id.startsWith('msg_'));
  });
});

test('Anthropic：system 顶层字段和块数组都会进 prompt', async () => {
  const web = fakeWeb();
  await withServer({ web }, async (base) => {
    const res = await post(
      base,
      '/v1/messages',
      simpleBody({
        system: [{ type: 'text', text: '你是严谨的助手' }, { type: 'text', text: '回答简短' }],
        messages: [{ role: 'user', content: [{ type: 'text', text: '介绍一下自己' }] }],
      }),
    );
    assert.equal(res.status, 200);
    assert.match(web.lastPrompt, /你是严谨的助手/);
    assert.match(web.lastPrompt, /回答简短/);
    assert.match(web.lastPrompt, /介绍一下自己/);
  });
});

test('Anthropic：messages 里的 system 角色也接受（客户端常见写法）', async () => {
  const web = fakeWeb();
  await withServer({ web }, async (base) => {
    const res = await post(
      base,
      '/v1/messages',
      simpleBody({
        messages: [
          { role: 'system', content: '你是严谨的助手' },
          { role: 'user', content: '介绍一下自己' },
        ],
      }),
    );
    assert.equal(res.status, 200, 'system 在 messages 里不该报 400');
    const json = await res.json();
    assert.equal(json.type, 'message');
    assert.match(web.lastPrompt, /你是严谨的助手/);
    assert.match(web.lastPrompt, /介绍一下自己/);
  });
});

test('Anthropic tools：tool_use 块 + input 是对象，stop_reason=tool_use', async () => {
  const web = fakeWeb({
    toolText: '先看内核：\n<｜DSML｜ calls>\n<｜DSML｜ invoke name="exec_shell">\n<｜DSML｜ parameter name="command" string="true">uname -a</｜DSML｜ parameter>\n</｜DSML｜ invoke>\n</｜DSML｜ calls>',
  });
  await withServer({ web, env: { STRIP_CLIENT_TOOLS: 'false' } }, async (base) => {
    const res = await post(
      base,
      '/v1/messages',
      simpleBody({
        tools: [
          {
            name: 'exec_shell',
            description: 'Exec shell command',
            input_schema: { type: 'object', properties: { command: { type: 'string' } } },
          },
        ],
        messages: [{ role: 'user', content: '内核是什么版本' }],
      }),
    );
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.stop_reason, 'tool_use');
    const call = json.content.find((b) => b.type === 'tool_use');
    assert.equal(call.name, 'exec_shell');
    assert.deepEqual(call.input, { command: 'uname -a' });
    assert.ok(call.id.startsWith('toolu_'));

    // 工具声明要进 prompt，且是 input_schema 转换后的 JSON Schema
    assert.match(web.lastPrompt, /exec_shell/);
    assert.match(web.lastPrompt, /"command"/);

    // 正文块里不能出现 DSML 调用语法
    const text = json.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    assert.ok(!text.includes('DSML'), `正文漏了 DSML: ${text}`);
  });
});

test('Anthropic：tool_use / tool_result 历史转换成 Tool_calls + Tool_call_result 段', async () => {
  const web = fakeWeb({ answer: '内核是 6.1。' });
  await withServer({ web, env: { STRIP_CLIENT_TOOLS: 'false' } }, async (base) => {
    const res = await post(
      base,
      '/v1/messages',
      simpleBody({
        tools: [
          {
            name: 'exec_shell',
            description: 'Exec shell command',
            input_schema: { type: 'object', properties: { command: { type: 'string' } } },
          },
        ],
        messages: [
          { role: 'user', content: '内核是什么版本' },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: '先查一下。' },
              { type: 'tool_use', id: 'toolu_abc', name: 'exec_shell', input: { command: 'uname -r' } },
            ],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_abc', content: '6.1.0' }],
          },
        ],
      }),
    );
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.stop_reason, 'end_turn');

    // 历史里的 tool_use 渲染成 ## Tool_calls 段里的 JSON 行（绝不写 DSML / DO）
    assert.match(web.lastPrompt, /## Tool_calls:\n\{"name":"exec_shell","args":\{"command":"uname -r"\}\}/);
    const history = web.lastPrompt.slice(web.lastPrompt.indexOf('## User:'));
    assert.ok(!history.includes('DSML'), '历史里不该出现 DSML');
    assert.ok(!history.includes('DO:{'), '历史里不该出现 DO');
    assert.match(web.lastPrompt, /## Tool_call_result:/);
    assert.match(web.lastPrompt, /6\.1\.0/);
    // 工具结果不能混进 assistant 段
    const assistantSection = web.lastPrompt.split('## Assistant:')[1]?.split('## Tool_calls:')[0] ?? '';
    assert.ok(!/6\.1\.0/.test(assistantSection), '工具结果被写进了 assistant 段');
  });
});

test('Anthropic 图片：base64 source 转成 image_url 并上传', async () => {
  const web = fakeWeb();
  await withServer({ web }, async (base) => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
    const res = await post(
      base,
      '/v1/messages',
      simpleBody({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: '这张图是什么' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
            ],
          },
        ],
      }),
    );
    assert.equal(res.status, 200);
    // 图片走 uploadImages，附件才走 uploadAttachments
    assert.equal(web.uploadedImages, 1);
    assert.equal(web.lastFileIds.length, 1);
    assert.deepEqual(web.lastFileIds, ['img_0']);
  });
});

test('Anthropic 流式：事件序列完整，文本增量正确', async () => {
  const web = fakeWeb({ answer: '流式回答内容', thinking: '思考中' });
  await withServer({ web }, async (base) => {
    const res = await post(base, '/v1/messages', simpleBody({ stream: true }));
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const events = parseSse(await res.text());
    const names = events.map((e) => e.event);

    assert.equal(names[0], 'message_start');
    assert.equal(names.at(-1), 'message_stop');
    assert.ok(names.includes('content_block_start'));
    assert.ok(names.includes('content_block_delta'));
    assert.ok(names.includes('content_block_stop'));
    assert.ok(names.includes('message_delta'));

    const start = events.find((e) => e.event === 'message_start');
    assert.equal(start.data.message.type, 'message');
    assert.equal(start.data.message.role, 'assistant');

    const text = events
      .filter((e) => e.event === 'content_block_delta' && e.data.delta?.type === 'text_delta')
      .map((e) => e.data.delta.text)
      .join('');
    assert.equal(text, '流式回答内容');

    const thinking = events
      .filter((e) => e.event === 'content_block_delta' && e.data.delta?.type === 'thinking_delta')
      .map((e) => e.data.delta.thinking)
      .join('');
    assert.equal(thinking, '思考中');

    const delta = events.find((e) => e.event === 'message_delta');
    assert.equal(delta.data.delta.stop_reason, 'end_turn');
    assert.ok(delta.data.usage.output_tokens > 0);
  });
});

test('Anthropic 流式 tools：tool_use 块 + input_json_delta', async () => {
  const web = fakeWeb({
    toolText: '<｜DSML｜ calls>\n<｜DSML｜ invoke name="exec_shell"><｜DSML｜ parameter name="command" string="true">ls</｜DSML｜ parameter></｜DSML｜ invoke>\n</｜DSML｜ calls>',
  });
  await withServer({ web }, async (base) => {
    const res = await post(
      base,
      '/v1/messages',
      simpleBody({
        stream: true,
        tools: [{ name: 'exec_shell', description: 'shell', input_schema: { type: 'object' } }],
      }),
    );
    const events = parseSse(await res.text());
    const toolStart = events.find((e) => e.event === 'content_block_start' && e.data.content_block?.type === 'tool_use');
    assert.ok(toolStart, '没有 tool_use 的 content_block_start');
    assert.equal(toolStart.data.content_block.name, 'exec_shell');

    const jsonDelta = events.find((e) => e.data?.delta?.type === 'input_json_delta');
    assert.ok(jsonDelta, '没有 input_json_delta');
    assert.deepEqual(JSON.parse(jsonDelta.data.delta.partial_json), { command: 'ls' });

    const delta = events.find((e) => e.event === 'message_delta');
    assert.equal(delta.data.delta.stop_reason, 'tool_use');
  });
});

test('Anthropic 流式：协议行（RESULT / 段标题）不会漏进 text_delta', async () => {
  const web = fakeWeb({
    toolText: '先确认：\n**RESULT：**{"name":"exec_shell","result":"Linux Fake"}\n结论：Linux。',
  });
  await withServer({ web }, async (base) => {
    const res = await post(base, '/v1/messages', simpleBody({ stream: true }));
    const events = parseSse(await res.text());
    const text = events
      .filter((e) => e.event === 'content_block_delta' && e.data.delta?.type === 'text_delta')
      .map((e) => e.data.delta.text)
      .join('');
    assert.ok(!/RESULT/i.test(text), `text_delta 漏了协议标记: ${text}`);
    assert.match(text, /先确认/);
    // 不再早停：RESULT 之后的正文照常发出去
    assert.match(text, /结论：Linux/);
  });
});

test('Anthropic 非流式：自造 RESULT 只从正文剔除，不中断、不重试', async () => {
  const web = fakeWeb({
    texts: [
      '先执行一下：\n**RESULT:**{"name":"exec_shell","result":"Linux Fake 9.9"}\n所以内核是 9.9。',
      '我还没有拿到内核信息，需要先执行 uname -a。',
    ],
  });
  await withServer({ web }, async (base) => {
    const res = await post(
      base,
      '/v1/messages',
      simpleBody({
        tools: [{ name: 'exec_shell', description: 'shell', input_schema: { type: 'object' } }],
      }),
    );
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(web.calls, 1, '不再有「编造重试」');
    const text = json.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    assert.ok(!/RESULT/i.test(text));
    assert.equal(text, '先执行一下：\n所以内核是 9.9。');
  });
});

test('Anthropic 流式一致性：driver 增量被截断时 text_delta 仍补齐到与非流式一致', async () => {
  const fullText = '第一段\n\n第二段是流式里没发出去的尾巴。';
  const web = fakeWeb({ toolText: fullText, streamText: '第一段' });
  await withServer({ web }, async (base) => {
    const finalRes = await post(base, '/v1/messages', simpleBody());
    const finalJson = await finalRes.json();
    const finalText = finalJson.content.filter((b) => b.type === 'text').map((b) => b.text).join('');

    const streamRes = await post(base, '/v1/messages', simpleBody({ stream: true }));
    const events = parseSse(await streamRes.text());
    const streamText = events
      .filter((e) => e.event === 'content_block_delta' && e.data.delta?.type === 'text_delta')
      .map((e) => e.data.delta.text)
      .join('');

    assert.equal(streamText, finalText, '流式 text_delta 必须补齐到与非流式 text 块一致');
    assert.match(streamText, /第二段是流式里没发出去的尾巴/);
    assert.equal((streamText.match(/第一段/g) || []).length, 1);
  });
});

test('Anthropic 流式一致性：DOM 折叠思考块时 thinking_delta 也会补尾', async () => {
  // driver 只流出一部分思考，但权威 reasoning 是完整的
  const web = fakeWeb({ answer: '回答', thinking: '完整思考内容', streamThinking: '完整' });
  await withServer({ web }, async (base) => {
    const streamRes = await post(base, '/v1/messages', simpleBody({ stream: true }));
    const events = parseSse(await streamRes.text());
    const thinking = events
      .filter((e) => e.event === 'content_block_delta' && e.data.delta?.type === 'thinking_delta')
      .map((e) => e.data.delta.thinking)
      .join('');
    assert.equal(thinking, '完整思考内容', 'thinking_delta 应补齐到权威 reasoning');
  });
});

test('Anthropic count_tokens：返回 input_tokens', async () => {
  await withServer({}, async (base) => {
    const res = await post(base, '/v1/messages/count_tokens', {
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: '你好，帮我写一个快速排序' }],
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.ok(Number.isInteger(json.input_tokens));
    assert.ok(json.input_tokens > 0);
  });
});

test('Anthropic 鉴权：x-api-key 生效，错误体是 Anthropic 格式', async () => {
  await withServer({ apiKey: 'sk-test' }, async (base) => {
    const ok = await post(base, '/v1/messages', simpleBody(), { 'x-api-key': 'sk-test' });
    assert.equal(ok.status, 200);

    const bad = await post(base, '/v1/messages', simpleBody(), { 'x-api-key': 'wrong' });
    assert.equal(bad.status, 401);
    const json = await bad.json();
    assert.equal(json.type, 'error');
    assert.equal(json.error.type, 'authentication_error');

    // Bearer 也要认，方便非官方 SDK
    const bearer = await post(base, '/v1/messages', simpleBody(), { Authorization: 'Bearer sk-test' });
    assert.equal(bearer.status, 200);
  });
});

test('Anthropic 参数校验：空 messages / 坏角色返回 invalid_request_error', async () => {
  await withServer({}, async (base) => {
    const empty = await post(base, '/v1/messages', { model: 'deepseek-flash', messages: [] });
    assert.equal(empty.status, 400);
    const emptyJson = await empty.json();
    assert.equal(emptyJson.type, 'error');
    assert.equal(emptyJson.error.type, 'invalid_request_error');

    const badRole = await post(base, '/v1/messages', {
      model: 'deepseek-flash',
      messages: [{ role: 'tool', content: 'x' }],
    });
    assert.equal(badRole.status, 400);
    assert.equal((await badRole.json()).error.type, 'invalid_request_error');
  });
});

test('Anthropic 超长上下文：较早内容拆成附件注入', async () => {
  const web = fakeWeb();
  const messages = [];
  for (let i = 0; i < 30; i += 1) {
    messages.push({ role: 'user', content: `第${i}步：${'a'.repeat(3000)}` });
    messages.push({ role: 'assistant', content: [{ type: 'text', text: `收到${i}：${'b'.repeat(3000)}` }] });
  }
  messages.push({ role: 'user', content: '最后的请求：用一句话总结' });

  await withServer({ web }, async (base) => {
    const res = await post(base, '/v1/messages', simpleBody({ messages }));
    assert.equal(res.status, 200);
    assert.equal(web.uploads.length, 1, '应该只上传一个附件');
    assert.match(web.uploads[0], /^context-[0-9a-f]{8}\.txt$/);
    assert.deepEqual(web.lastFileIds, ['file_0']);
    assert.ok(web.lastPrompt.length <= 100_000, `正文超限: ${web.lastPrompt.length}`);
    assert.match(web.lastPrompt, /## CONTEXT_ATTACHMENT:/);
    assert.match(web.lastPrompt, /最后的请求：用一句话总结/);
  });
});

test('Anthropic 上游失败：返回 Anthropic 风格错误', async () => {
  const web = fakeWeb({ failWith: new Error('upstream exploded') });
  await withServer({ web }, async (base) => {
    const res = await post(base, '/v1/messages', simpleBody());
    assert.equal(res.status, 500);
    const json = await res.json();
    assert.equal(json.type, 'error');
    assert.equal(json.error.type, 'api_error');
  });
});