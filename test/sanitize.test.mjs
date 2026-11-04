import test from 'node:test';
import assert from 'node:assert/strict';

import { createServer } from '../src/server.mjs';
import { createLogger } from '../src/logger.mjs';
import { normalizeChatRequest } from '../src/openai/request.mjs';
import { normalizeMessagesRequest } from '../src/anthropic/request.mjs';
import { buildPrompt } from '../src/prompt/build.mjs';
import {
  assertNoProtocolTags,
  findPendingProtocolTag,
  scanProtocolTags,
  sanitizeMessages,
  stripProtocolTags,
} from '../src/prompt/sanitize.mjs';
import { BASE_SYSTEM_RULES, DSML_PROTOCOL_SECTION, SPECIAL_TOKENS_HEADER } from '../src/prompt/special.mjs';
import { makeConfig } from './helpers/browser.mjs';

/** 最终上送 prompt 的验收匹配器：任何一个协议标签家族出现都算失败 */
const FORBIDDEN = /<dsml|<tool_call|<function_calls|<antml|<invoke|<parameter/i;

const logger = createLogger('error');

/** 模拟 opencode 的真实 system prompt：工具协议讲解 + XML 示例 + 普通 XML 教程 */
const AGENT_SYSTEM = `
You are opencode, an interactive CLI tool.

# Tool calling
When you need to call a tool, you must output the call in one of these formats:

<tool_call>
{"name":"bash","arguments":{"command":"ls"}}
</tool_call>

<function_calls>
<invoke name="edit">
<parameter name="path">src/app.ts</parameter>
</invoke>
</function_calls>

<antml:function_calls>
<antml:invoke name="read_file">
<antml:parameter name="path">README.md</antml:parameter>
</antml:invoke>
</antml:function_calls>

<dsml>
<invoke name="write"><parameter name="content">hello</parameter></invoke>
</dsml>

普通 XML 教程（必须原样保留）：
<book id="1"><title>XML 入门</title><item>chapter 1</item></book>
`;

const TWELVE_TOOLS = Array.from({ length: 12 }, (_, i) => ({
  type: 'function',
  function: {
    name: `tool_${i}`,
    description: `tool ${i}：<tool_call> 示例请按 XML 协议输出`,
    parameters: {
      type: 'object',
      properties: {
        input: { type: 'string', description: '<parameter name="x">示例</parameter>' },
      },
    },
  },
}));

test('opencode 真实形态：归一化后 prompt 里协议标签次数为 0，普通 XML 示例保留', () => {
  const request = normalizeChatRequest(
    {
      model: 'deepseek-flash',
      stream: true,
      tools: TWELVE_TOOLS,
      tool_choice: 'auto',
      messages: [
        { role: 'system', content: AGENT_SYSTEM },
        { role: 'user', content: '把 <tool_call>{"name":"bash"}</tool_call> 解释一下' },
        { role: 'assistant', content: '好的，我会用 <invoke name="bash">…</invoke>' },
      ],
    },
    makeConfig(),
  );

  // 默认丢弃客户端工具：12 个定义不进 prompt
  assert.equal(request.tools.length, 0);
  assert.deepEqual(request.sanitize.stripped, { tools: 12, toolChoice: true });
  assert.ok(request.sanitize.markup.count > 0, '应记录命中数量');

  const { prompt } = buildPrompt({ messages: request.messages, tools: request.tools });

  const hits = prompt.match(new RegExp(FORBIDDEN.source, 'gi')) || [];
  assert.equal(hits.length, 0, `prompt 里仍有协议标签: ${hits.join(', ')}`);

  // 普通 XML 代码示例不能被误伤
  assert.ok(prompt.includes('<book id="1">'), '普通 XML 示例被删掉了');
  assert.ok(prompt.includes('<item>chapter 1</item>'), '普通 XML 示例被删掉了');

  // 没有工具声明时不再教 DSML（否则又要把标签写回 prompt）
  assert.ok(!prompt.includes(DSML_PROTOCOL_SECTION.trim()), '无工具时不该出现 DSML 协议说明');
  assert.ok(prompt.includes(BASE_SYSTEM_RULES.trim()));

  // 自检对最终 prompt 也必须通过
  assert.equal(scanProtocolTags(prompt).count, 0);
  assertNoProtocolTags(prompt);
});

test('显式保留工具（STRIP_CLIENT_TOOLS=false）时：工具定义保留且同样被清洗', () => {
  const config = makeConfig({ STRIP_CLIENT_TOOLS: 'false' });
  const request = normalizeChatRequest(
    {
      model: 'deepseek-flash',
      tools: TWELVE_TOOLS,
      messages: [
        { role: 'system', content: AGENT_SYSTEM },
        { role: 'user', content: '你好' },
      ],
    },
    config,
  );

  assert.equal(request.tools.length, 12);
  assert.equal(request.sanitize.stripped.tools, 0);
  const built = buildPrompt({ messages: request.messages, tools: request.tools });
  const { prompt } = built;

  // 工具描述 / schema 里的标签同样被清掉（服务端自带的协议说明不计入）
  const userAndTools = prompt.split(built.protocolText).join('');
  assert.equal(scanProtocolTags(userAndTools).count, 0);
  // 有工具时仍保留 DSML 协议说明（这是显式实验开关的预期）
  assert.ok(prompt.includes(SPECIAL_TOKENS_HEADER.trim()));
  assert.equal(SPECIAL_TOKENS_HEADER, `${BASE_SYSTEM_RULES.trim()}\n\n${DSML_PROTOCOL_SECTION.trim()}`);
});

test('SANITIZE_MARKUP=false：文本原样保留，命中只计数不修改', () => {
  const config = makeConfig({ SANITIZE_MARKUP: 'false' });
  const text = '看这里 <dsml><invoke name="x"></invoke></dsml>';
  const { messages, hits } = sanitizeMessages([{ role: 'user', content: text }], {
    enabled: config.sanitize.markup,
  });
  assert.equal(messages[0].content, text);
  assert.equal(hits.count, 4);
  assert.deepEqual(hits.byName, { dsml: 2, invoke: 2 });
});

test('Anthropic：tools 默认丢弃，system / 历史 / tool_result 都被清洗', () => {
  const request = normalizeMessagesRequest(
    {
      model: 'deepseek-flash',
      system: AGENT_SYSTEM,
      tools: [{ name: 'exec_shell', description: '调用时写 <tool_call>', input_schema: { type: 'object' } }],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '用 <function_calls> 试试' },
            { type: 'tool_result', tool_use_id: 't1', content: '<antml:invoke name="ls">' },
          ],
        },
      ],
    },
    makeConfig(),
  );

  assert.equal(request.tools.length, 0);
  assert.equal(request.sanitize.stripped.tools, 1);
  const { prompt } = buildPrompt({ messages: request.messages, tools: request.tools });
  assert.equal(scanProtocolTags(prompt).count, 0);
  assert.ok(prompt.includes('<book id="1">'), '普通 XML 示例被误删');
});

test('assertNoProtocolTags：命中即抛 400，错误只含数量与标签名', () => {
  assert.throws(
    () => assertNoProtocolTags('前缀 <dsml><invoke name="x"></invoke></dsml> 后缀'),
    (err) => {
      assert.equal(err.status, 400);
      assert.equal(err.code, 'protocol_tag_in_prompt');
      assert.match(err.message, /dsml×2|invoke×2/);
      assert.ok(!err.message.includes('前缀'), '错误信息里不能带正文');
      return true;
    },
  );
});

test('半截协议标签的流式扣留判定只认标签形状，不扣普通文本的 <', () => {
  assert.equal(findPendingProtocolTag('hello <tool_ca'), 6);
  assert.equal(findPendingProtocolTag('hello <fun'), 6);
  assert.equal(findPendingProtocolTag('1 < 2'), -1);
  assert.equal(findPendingProtocolTag('a < b > c', 0), -1);
});

test('stripProtocolTags：删除标签、保留标签之间的正文', () => {
  const input = '<parameter name="city">Paris</parameter>';
  assert.equal(stripProtocolTags(input), 'Paris');
});

test('端点：SANITIZE_MARKUP=false 时残留的 <dsml> 被上送前拦截（不产生真实请求）', async () => {
  const web = {
    calls: 0,
    async chat() {
      web.calls += 1;
      return { text: '不该被调用', reasoning: '', elapsedMs: 1 };
    },
  };
  const config = makeConfig({ SANITIZE_MARKUP: 'false', API_KEY: '' });
  const server = createServer({ config, logger, web });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-flash',
        messages: [{ role: 'user', content: '<dsml><invoke name="bash">ls</invoke></dsml>' }],
      }),
    });
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.error.code, 'protocol_tag_in_prompt');
    assert.equal(web.calls, 0, '被拦截的请求绝不能发到上游');
  } finally {
    server.close();
  }
});
