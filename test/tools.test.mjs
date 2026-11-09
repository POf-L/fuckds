import test from 'node:test';
import assert from 'node:assert/strict';

import {
  collectToolNames,
  normalizeArguments,
  parseToolCalls,
  readJsonObject,
  renderCompactToolDeclarations,
  renderToolDeclarations,
  renderToolResult,
} from '../src/prompt/tools.mjs';

test('parse: 基本 DO 调用', () => {
  const calls = parseToolCalls('好的，我来执行。\nDO:{"name":"exec_shell","args":"ls -la"}\n完成。');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'exec_shell');
  // 裸字符串参数不是合法 JSON，统一包成 {"input": ...}，方便客户端 JSON.parse
  assert.deepEqual(JSON.parse(calls[0].arguments), { input: 'ls -la' });
});

test('parse: args 是对象时序列化成字符串', () => {
  const calls = parseToolCalls('DO:{"name":"read_file","args":{"path":"/etc/hosts","max":10}}');
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].arguments), { path: '/etc/hosts', max: 10 });
});

test('parse: 字符串里带大括号 / 转义引号', () => {
  const text = 'DO:{"name":"exec_shell","args":{"command":"echo \\"a}b\\" && echo {x}"}}';
  const calls = parseToolCalls(text);
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].arguments).command, 'echo "a}b" && echo {x}');
});

test('parse: 忽略未完成的 JSON', () => {
  assert.deepEqual(parseToolCalls('DO:{"name":"exec_shell","args":"ls'), []);
  assert.deepEqual(parseToolCalls('DO:{"name":"exec_shell","args":"ls"'), []);
});

test('parse: 未声明的工具名不再被丢弃（丢弃会让整轮输出变空）', () => {
  const text = 'DO:{"name":"rm_rf","args":"/"} and DO:{"name":"exec_shell","args":"ls"}';
  assert.deepEqual(parseToolCalls(text).map((c) => c.name), ['rm_rf', 'exec_shell']);
  // 即使传了 knownTools 也不过滤：未知名字照实返回，交给客户端报 unknown tool
  assert.deepEqual(parseToolCalls(text, ['exec_shell']).map((c) => c.name), ['rm_rf', 'exec_shell']);
});

test('parse: 线上抓到的 observe_screen 调用（名字没在声明里）必须解析出来', () => {
  // 真实抓包：模型调了 observe_screen，但这一轮 tools 里没有这个名字。
  // 旧实现按名字丢弃 → content 和 tool_calls 双双为空 → 客户端「模型未返回正文或工具调用」。
  const text =
    '\n\n<｜DSML｜ calls>\n<｜DSML｜ invoke name="observe_screen">\n<｜DSML｜ parameter name="include_ui_tree" string="false">true</｜DSML｜ parameter>\n</｜DSML｜ invoke>\n</｜DSML｜ calls>';
  const calls = parseToolCalls(text, ['launch_app', 'tap']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'observe_screen');
  assert.deepEqual(JSON.parse(calls[0].arguments), { include_ui_tree: true });
});

test('parse: 去重 + 代码块里也能解析', () => {
  const text = '```\nDO:{"name":"exec_shell","args":"ls"}\nDO:{"name":"exec_shell","args":"ls"}\n```';
  const calls = parseToolCalls(text);
  assert.equal(calls.length, 1);
});

test('parse: <tool_call> XML 格式也支持', () => {
  const text = '我来执行\n<tool_call>\n{"name":"exec_shell","arguments":{"command":"uname -a"}}\n</tool_call>';
  const calls = parseToolCalls(text, ['exec_shell']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'exec_shell');
  assert.deepEqual(JSON.parse(calls[0].arguments), { command: 'uname -a' });
});

test('parse: 两种格式混用不会重复', () => {
  const text = '<tool_call>{"name":"exec_shell","arguments":"ls"}</tool_call>\nDO:{"name":"exec_shell","args":"ls"}';
  const calls = parseToolCalls(text, ['exec_shell']);
  assert.equal(calls.length, 1);
});

test('parse: 没有调用时返回空数组', () => {
  assert.deepEqual(parseToolCalls('普通回答，没有工具。'), []);
  assert.deepEqual(parseToolCalls(''), []);
  assert.deepEqual(parseToolCalls(undefined), []);
});

test('readJsonObject: 找到配平的右括号', () => {
  const text = 'xx{"a":{"b":[1,2]},"c":"}"}yy';
  assert.equal(readJsonObject(text, 2), '{"a":{"b":[1,2]},"c":"}"}');
});

test('render: 工具声明忽略没有名字的项', () => {
  const lines = renderToolDeclarations([
    { type: 'function', function: { name: 'a', description: 'A' } },
    { type: 'function', function: {} },
    { function: { name: 'b' } },
  ]);
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).name, 'a');
  assert.equal(JSON.parse(lines[1]).name, 'b');
});

test('render: Tool_call_result 段的一行 JSON', () => {
  const line = renderToolResult('exec_shell', 'Linux');
  const parsed = JSON.parse(line);
  assert.deepEqual(parsed, { name: 'exec_shell', result: 'Linux' });
});

test('normalizeArguments: 非 JSON 字符串会被包一层', () => {
  assert.deepEqual(JSON.parse(normalizeArguments('not json')), { input: 'not json' });
  assert.equal(normalizeArguments(''), '{}');
  assert.deepEqual(JSON.parse(normalizeArguments({ a: 1 })), { a: 1 });
});

test('parse: 被包成 {name,args} 的参数会自动拆开', () => {
  // DO 里再套一层包装对象
  const doCalls = parseToolCalls(
    'DO:{"name":"bash","args":{"name":"bash","args":{"description":"show cwd","command":"pwd"}}}',
    ['bash'],
  );
  assert.equal(doCalls.length, 1);
  assert.deepEqual(JSON.parse(doCalls[0].arguments), { description: 'show cwd', command: 'pwd' });

  // DO 里包装对象的 args 是 JSON 字符串
  const doString = parseToolCalls(
    'DO:{"name":"bash","args":{"name":"bash","args":"{\\"description\\":\\"show cwd\\",\\"command\\":\\"pwd\\"}"}}',
    ['bash'],
  );
  assert.deepEqual(JSON.parse(doString[0].arguments), { description: 'show cwd', command: 'pwd' });
});

test('parse: DSML 参数被命名成 name/args 时也能解析', () => {
  const text = `<｜DSML｜calls>
<｜DSML｜invoke name="bash">
<｜DSML｜parameter name="name" string="true">bash</｜DSML｜parameter>
<｜DSML｜parameter name="args" string="true">{"description":"show cwd","command":"pwd"}</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜calls>`;
  const calls = parseToolCalls(text, ['bash']);
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].arguments), { description: 'show cwd', command: 'pwd' });
});

test('collectToolNames: 去空去重入参', () => {
  assert.deepEqual(
    collectToolNames([{ function: { name: 'a' } }, { function: { name: 'a' } }, { function: {} }, null]),
    ['a', 'a'],
  );
});

// ---------------------------------------------------------------- DSML

const DSML_FULLWIDTH = `<｜DSML｜calls>
<｜DSML｜invoke name="bash">
<｜DSML｜parameter name="description" string="true">Show working directory</｜DSML｜parameter>
<｜DSML｜parameter name="command" string="true">pwd; ls -la</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜calls>`;

test('parse: DSML 全角竖线格式', () => {
  const calls = parseToolCalls(`我来看看\n${DSML_FULLWIDTH}`, ['bash']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'bash');
  assert.deepEqual(JSON.parse(calls[0].arguments), {
    description: 'Show working directory',
    command: 'pwd; ls -la',
  });
});

test('parse: DSML ASCII 竖线 / tool_calls / 双层竖线', () => {
  const text = `<||DSML||tool_calls>
<||DSML||invoke name='exec_shell'>
<||DSML||parameter name="command" string="true">uname -a</||DSML||parameter>
<||DSML||parameter name="timeout" string="false">15</||DSML||parameter>
</||DSML||invoke>
</||DSML||tool_calls>`;
  const calls = parseToolCalls(text, ['exec_shell']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'exec_shell');
  assert.deepEqual(JSON.parse(calls[0].arguments), { command: 'uname -a', timeout: 15 });
});

test('parse: DSML 多个 invoke 且能按工具名过滤', () => {
  const text = `<｜DSML｜calls>
<｜DSML｜invoke name="exec_shell"><｜DSML｜parameter name="command">ls</｜DSML｜parameter></｜DSML｜invoke>
<｜DSML｜invoke name="read_file"><｜DSML｜parameter name="path">/etc/hosts</｜DSML｜parameter></｜DSML｜invoke>
</｜DSML｜calls>`;
  const all = parseToolCalls(text);
  assert.deepEqual(all.map((c) => c.name), ['exec_shell', 'read_file']);
  // 传 knownTools 也不再过滤（回归：未声明的名字曾让整轮输出变空）
  assert.deepEqual(parseToolCalls(text, ['read_file']).map((c) => c.name), ['exec_shell', 'read_file']);
});

test('parse: DSML 里的参数原样保留（含换行 / 引号）', () => {
  const text = `<｜DSML｜calls>
<｜DSML｜invoke name="bash">
<｜DSML｜parameter name="command" string="true">printf '%s\\n' "a b" && echo done</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜calls>`;
  const calls = parseToolCalls(text);
  assert.equal(JSON.parse(calls[0].arguments).command, `printf '%s\\n' "a b" && echo done`);
});

test('parse: DSML 和 DO 混用不会重复', () => {
  const text = `${DSML_FULLWIDTH}\nDO:{"name":"bash","args":{"command":"pwd; ls -la","description":"Show working directory"}}`;
  const calls = parseToolCalls(text, ['bash']);
  assert.equal(calls.length, 1);
});

test('parse: DSML 被截断（缺少闭合标签）也能解析出完整参数', () => {
  const text = `<｜DSML｜calls>
<｜DSML｜invoke name="bash">
<｜DSML｜parameter name="command" string="true">pwd</｜DSML｜parameter>
`;
  const calls = parseToolCalls(text, ['bash']);
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].arguments), { command: 'pwd' });
});

// ---------------------------------------------------------------- DO 容错

test('parse: DO 的各种写法都认识（空格 / 全角冒号 / markdown 装饰 / 反引号）', () => {
  const variants = [
    'DO :{"name":"exec_shell","args":"ls"}',
    'DO：{"name":"exec_shell","args":"ls"}',
    '**DO:** {"name":"exec_shell","args":"ls"}',
    '> DO: `{"name":"exec_shell","args":"ls"}`',
    '`DO:{"name":"exec_shell","args":"ls"}`',
  ];
  for (const text of variants) {
    const calls = parseToolCalls(text, ['exec_shell']);
    assert.equal(calls.length, 1, `没解析出来: ${text}`);
    assert.equal(calls[0].name, 'exec_shell');
    assert.deepEqual(JSON.parse(calls[0].arguments), { input: 'ls' });
  }
});

test('parse: 冒号后换行的 pretty JSON 也能解析', () => {
  const text = `我来执行
DO:
{
  "name": "exec_shell",
  "args": {
    "command": "uname -a"
  }
}
执行完再说话。`;
  const calls = parseToolCalls(text, ['exec_shell']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'exec_shell');
  assert.deepEqual(JSON.parse(calls[0].arguments), { command: 'uname -a' });
});

test('parse: 调用夹在行内、JSON 后面还有正文也认', () => {
  const calls = parseToolCalls('我先执行 DO:{"name":"exec_shell","args":{"command":"pwd"}} 然后看输出', [
    'exec_shell',
  ]);
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].arguments), { command: 'pwd' });
});

test('parse: 字符串里带裸换行的 JSON 会被修复（模型常见手写错误）', () => {
  const calls = parseToolCalls('DO:{"name":"exec_shell","args":{"command":"line1\nline2"}}', ['exec_shell']);
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].arguments).command, 'line1\nline2');
});

test('parse: 尾随逗号的 JSON 会被修复', () => {
  const calls = parseToolCalls('DO:{"name":"exec_shell","args":{"command":"pwd",}}', ['exec_shell']);
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].arguments), { command: 'pwd' });
});

test('parse: 一次回复里的多个 DO 调用按出现顺序返回', () => {
  const text = 'DO:{"name":"a","args":"1"}\n先说一句\nDO:{"name":"b","args":"2"}';
  const calls = parseToolCalls(text);
  assert.deepEqual(
    calls.map((c) => c.name),
    ['a', 'b'],
  );
  assert.ok(calls[0].index < calls[1].index);
});

// ---------------------------------------------------------------- XML / 原生 token

test('parse: <tool_call> 缺闭合标签（流式截断）也能解析', () => {
  const calls = parseToolCalls('<tool_call>{"name":"exec_shell","arguments":{"command":"ls"}}', ['exec_shell']);
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].arguments), { command: 'ls' });
});

test('parse: <tool_call> 里的 JSON 后面跟着解释文字也认', () => {
  const text = '<tool_call>\n{"name":"exec_shell","arguments":{"command":"ls"}}\n先这样\n</tool_call>';
  const calls = parseToolCalls(text, ['exec_shell']);
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].arguments), { command: 'ls' });
});

test('parse: <tool_calls> 复数标签 + OpenAI 风格 function 包裹也能认', () => {
  const text =
    '<tool_calls>{"type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"/etc/hosts\\"}"}}</tool_calls>';
  const calls = parseToolCalls(text, ['read_file']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'read_file');
  assert.deepEqual(JSON.parse(calls[0].arguments), { path: '/etc/hosts' });
});

test('parse: 原生 <|tool...|> token 包裹的 JSON 也能解析', () => {
  const text =
    '<|tool▁calls▁begin|><|tool▁call▁begin|>{"name":"exec_shell","arguments":{"command":"uname -a"}}<|tool▁call▁end|><|tool▁calls▁end|>';
  const calls = parseToolCalls(text, ['exec_shell']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'exec_shell');
  assert.deepEqual(JSON.parse(calls[0].arguments), { command: 'uname -a' });
  // 没有任何残留的 <|tool...|> 被当成工具名
  assert.ok(!calls[0].name.includes('<|'));
});

test('parse: 真·原生格式 function<sep>工具名 + JSON 参数也能解析', () => {
  const text =
    '<|tool▁calls▁begin|><|tool▁call▁begin|>function<|tool▁sep|>get_weather\n```json\n{"location":"Hangzhou"}\n```<|tool▁call▁end|><|tool▁calls▁end|>';
  const calls = parseToolCalls(text, ['get_weather']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'get_weather');
  assert.deepEqual(JSON.parse(calls[0].arguments), { location: 'Hangzhou' });
});

test('parse: 原生 token / DSML / DO 混用不会重复', () => {
  const text = [
    '<|tool▁calls▁begin|>{"name":"exec_shell","arguments":{"command":"ls"}}<|tool▁calls▁end|>',
    DSML_FULLWIDTH,
    'DO:{"name":"bash","args":{"command":"pwd; ls -la","description":"Show working directory"}}',
  ].join('\n');
  const calls = parseToolCalls(text, ['exec_shell', 'bash']);
  assert.deepEqual(
    calls.map((c) => c.name),
    ['exec_shell', 'bash'],
  );
});

test('compact: 一行一个工具，标出必填与类型', () => {
  const lines = renderCompactToolDeclarations([
    {
      type: 'function',
      function: {
        name: 'bash',
        description: '执行 shell 命令',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string' }, timeout: { type: 'number' } },
          required: ['command'],
        },
      },
    },
  ]);
  assert.deepEqual(lines, ['bash(command:string*, timeout:number) — 执行 shell 命令']);
});

test('compact: 没有参数也能渲染', () => {
  const lines = renderCompactToolDeclarations([{ function: { name: 'browser_status', description: '查看浏览器' } }]);
  assert.deepEqual(lines, ['browser_status() — 查看浏览器']);
});

test('compact: 长描述被截断，且拒绝没有名字的工具', () => {
  const lines = renderCompactToolDeclarations([
    { function: { name: 'x', description: '长'.repeat(500) } },
    { function: { description: '没有名字' } },
  ]);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].length < 120, `压缩后应显著变短，实际 ${lines[0].length}`);
});

test('compact: 体积远小于完整 JSON 声明', () => {
  const tools = Array.from({ length: 60 }, (_, i) => ({
    type: 'function',
    function: {
      name: `tool_${i}`,
      description: `工具 ${i} ${'说明文字'.repeat(200)}`,
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' }, cwd: { type: 'string' } },
        required: ['command'],
      },
    },
  }));
  const full = renderToolDeclarations(tools).join('\n').length;
  const compact = renderCompactToolDeclarations(tools).join('\n').length;
  assert.ok(compact * 5 < full, `压缩应至少省 80%，实际 ${compact}/${full}`);
});
