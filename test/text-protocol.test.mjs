import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TOOL_CALL_CLOSE,
  TOOL_CALL_OPEN,
  TOOL_RESULT_CLOSE,
  TOOL_RESULT_OPEN,
  countTextToolCallBlocks,
  findPendingTextSentinel,
  parseTextToolCalls,
} from '../src/prompt/text-protocol.mjs';
import { buildPrompt } from '../src/prompt/build.mjs';
import { parseToolCalls } from '../src/prompt/tools.mjs';
import { scanProtocolTags } from '../src/prompt/sanitize.mjs';
import {
  findToolMarkup,
  hasFabricatedProtocol,
  hasFabricatedToolResult,
  stripToolMarkup,
  ToolMarkupStreamFilter,
} from '../src/openai/tool-text.mjs';

const block = (name, args) => `${TOOL_CALL_OPEN}${JSON.stringify({ name, arguments: args })}${TOOL_CALL_CLOSE}`;

test('协议本身不含 XML 协议标签（上送守卫不会误拦）', () => {
  const sample = `${block('bash', { command: 'dir' })}\n${TOOL_RESULT_OPEN}{"name":"bash","result":"ok"}${TOOL_RESULT_CLOSE}`;
  assert.equal(scanProtocolTags(sample).count, 0);
});

test('parse: 单块 + 前后废话都能容忍', () => {
  const text = `我先看下目录。\n${block('bash', { command: 'dir' })}\n稍等。`;
  const calls = parseTextToolCalls(text);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'bash');
  assert.deepEqual(calls[0].args, { command: 'dir' });
  assert.equal(calls[0].index, text.indexOf(TOOL_CALL_OPEN));
});

test('parse: JSON 换行/缩进、中文与引号参数', () => {
  const text = [
    TOOL_CALL_OPEN,
    '{\n  "name": "write_file",\n  "arguments": {\n    "path": "笔记/说明.md",\n    "content": "他说：\\"你好\\"\\n第二行"\n  }\n}',
    TOOL_CALL_CLOSE,
  ].join('\n');
  const calls = parseTextToolCalls(text);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'write_file');
  assert.equal(calls[0].args.path, '笔记/说明.md');
  assert.equal(calls[0].args.content, '他说："你好"\n第二行');
});

test('parse: 一次多块 + 数组写法都支持', () => {
  const text = [
    block('bash', { command: 'dir' }),
    block('read', { path: 'README.md' }),
  ].join('\n');
  const calls = parseTextToolCalls(text);
  assert.deepEqual(calls.map((c) => c.name), ['bash', 'read']);

  const arrayText = `${TOOL_CALL_OPEN}[{"name":"bash","arguments":{"command":"pwd"}},{"name":"read","arguments":{"path":"a.txt"}}]${TOOL_CALL_CLOSE}`;
  const arrayCalls = parseTextToolCalls(arrayText);
  assert.deepEqual(arrayCalls.map((c) => c.name), ['bash', 'read']);
  assert.equal(countTextToolCallBlocks(text), 2);
});

test('parse: 坏 JSON / 空块降级为空数组，不抛错', () => {
  const broken = `${TOOL_CALL_OPEN}{"name":"bash", "arguments":{"command": "dir"${TOOL_CALL_CLOSE}`;
  assert.deepEqual(parseTextToolCalls(broken), []);
  assert.deepEqual(parseTextToolCalls(`${TOOL_CALL_OPEN}${TOOL_CALL_CLOSE}`), []);
  // 进入统一解析入口时也只是「没有调用」，正文照旧保留（不抛错）
  assert.deepEqual(parseToolCalls(broken, ['bash']), []);
});

test('parseToolCalls：文本协议排在兜底格式之前，且同签名去重', () => {
  const text = block('bash', { command: 'dir' });
  const calls = parseToolCalls(text, ['bash']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'bash');
  assert.equal(calls[0].arguments, '{"command":"dir"}');
});

test('strip: 调用块与结果块从 content 里剔除，正文保留', () => {
  const text = `开始\n${block('bash', { command: 'dir' })}\n结束`;
  assert.equal(stripToolMarkup(text), '开始\n\n结束');

  const fabricated = `${TOOL_RESULT_OPEN}{"name":"bash","result":"假的"}${TOOL_RESULT_CLOSE}`;
  assert.ok(hasFabricatedToolResult(fabricated), '模型自写结果应判定为伪造');
  assert.ok(hasFabricatedProtocol(fabricated));
  assert.ok(findToolMarkup(fabricated).some((b) => b.kind === 'RESULT'));
  assert.equal(stripToolMarkup(fabricated), '');
});

test('流式：正文先吐，哨兵开始处截断，不泄漏模型写出的调用块', () => {
  const filter = new ToolMarkupStreamFilter({ holdBack: 0 });
  assert.equal(filter.push('目录如下：\n'), '目录如下：\n');

  const incoming = block('bash', { command: 'dir' });
  assert.equal(filter.push(incoming), '', '哨兵之后不能再往 content 里发');
  assert.equal(filter.flushRest(), '');
  assert.equal(filter.cutKind, 'TOOL_CALL');

  // 半截哨兵同样扣住，闭合后才判定
  const partial = new ToolMarkupStreamFilter({ holdBack: 0 });
  assert.equal(partial.push('好的 [[TO'), '好的 ');
  assert.equal(partial.push('OL_CALL]]{"name":"bash","arguments":{}}[[/TOOL_CALL]]'), '');
});

test('findPendingTextSentinel：只认哨兵前缀，不扣普通方括号', () => {
  assert.equal(findPendingTextSentinel('x [[TO'), 2);
  assert.equal(findPendingTextSentinel('x [[TOOL_CALL]]'), -1);
  assert.equal(findPendingTextSentinel('arr[0] = 1'), -1);
});

test('多轮闭环：历史里的调用与结果回写同格式，且不重复', () => {
  const messages = [
    { role: 'user', content: '先列目录，再读 README，再总结' },
    {
      role: 'assistant',
      content: '先列目录。',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{"command":"dir"}' } }],
    },
    { role: 'tool', tool_call_id: 'c1', name: 'bash', content: 'README.md\nsrc' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c2', type: 'function', function: { name: 'read', arguments: '{"path":"README.md"}' } }],
    },
    { role: 'tool', tool_call_id: 'c2', name: 'read', content: '# fuckds' },
  ];
  const { prompt } = buildPrompt({ messages, tools: [toolDecl()] });

  // 两次调用各出现一次（不重复塞旧调用块）；协议示例在 system 段，容易混淆，所以只看历史部分
  const history = prompt.slice(prompt.indexOf('## User:'));
  assert.equal((history.match(/\[\[TOOL_CALL\]\]/g) ?? []).length, 2);
  assert.equal((history.match(/\[\[TOOL_RESULT\]\]/g) ?? []).length, 2);
  assert.match(prompt, /\[\[TOOL_CALL\]\]\{"name":"bash","arguments":\{"command":"dir"\}\}\[\[\/TOOL_CALL\]\]/);
  assert.match(prompt, /\[\[TOOL_RESULT\]\]\{"name":"read","result":"# fuckds"\}\[\[\/TOOL_RESULT\]\]/);

  // 全程无 XML 协议标签；历史里也没有 DO / DSML 可供模型模仿
  assert.equal(scanProtocolTags(prompt).count, 0);
  assert.ok(!history.includes('DSML'));
  assert.ok(!history.includes('DO:{'));
});

function toolDecl() {
  return {
    type: 'function',
    function: {
      name: 'bash',
      description: 'run shell',
      parameters: { type: 'object', properties: { command: { type: 'string' } } },
    },
  };
}
