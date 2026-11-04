import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findFabricatedBlock,
  findToolMarkup,
  hasFabricatedProtocol,
  hasFabricatedToolResult,
  reconcileStreamedText,
  stripToolMarkup,
  ToolMarkupStreamFilter,
} from '../src/openai/tool-text.mjs';
import { parseToolCalls } from '../src/prompt/tools.mjs';

/* ------------------------------------------------------------------ *
 * 流式收尾对齐：客户端已收到的内容 + 权威文本 → 还缺的尾巴
 * ------------------------------------------------------------------ */

test('reconcileStreamedText: 严格前缀时补出剩余尾巴', () => {
  const r = reconcileStreamedText('已发一半', '已发一半，后面还有尾巴。');
  assert.equal(r.delta, '，后面还有尾巴。');
  assert.equal(r.text, '已发一半，后面还有尾巴。');
  assert.equal(r.complete, true);
});

test('reconcileStreamedText: 已发内容覆盖权威文本时不重复发', () => {
  const r = reconcileStreamedText('完整回答**', '完整回答');
  assert.equal(r.delta, '');
  assert.equal(r.complete, true);
});

test('reconcileStreamedText: 忽略空白的序列化分叉也能补全尾部（丢流核心场景）', () => {
  // DOM 的 markdown 反向序列化会压缩空行/行尾空格，与模型原始文本不是前缀关系
  const sent = '## 小标题\n\n- 第一项';
  const target = '## 小标题\n\n\n- 第一项  \n- 第二项\n\n最后一段总结。';
  const r = reconcileStreamedText(sent, target);
  assert.ok(r.text.startsWith(sent), '必须保持已发内容为前缀');
  assert.match(r.delta, /第二项/);
  assert.match(r.delta, /最后一段总结/);
  assert.equal(r.complete, true);
  // 不能重复已经发过的「第一项」
  assert.equal((r.text.match(/第一项/g) || []).length, 1);
});

test('reconcileStreamedText: 列表符号归一化（* vs -）也能补全尾部', () => {
  const r = reconcileStreamedText('- 第一项\n- 第二项', '* 第一项\n* 第二项\n\n尾部');
  assert.match(r.delta, /尾部/);
  assert.equal(r.complete, true);
  assert.equal((r.text.match(/第一项/g) || []).length, 1);
});

test('reconcileStreamedText: 完全分叉时宁可少发也不重复（complete=false）', () => {
  const r = reconcileStreamedText('完全不同的内容', '另一段完全不相干的东西');
  assert.equal(r.delta, '');
  assert.equal(r.complete, false);
  assert.equal(r.text, '完全不同的内容');
});

test('reconcileStreamedText: 权威文本为空时不动', () => {
  assert.deepEqual(reconcileStreamedText('已发内容', ''), { text: '已发内容', delta: '', complete: true });
  assert.deepEqual(reconcileStreamedText('', ''), { text: '', delta: '', complete: true });
  assert.deepEqual(reconcileStreamedText('', '全部内容'), { text: '全部内容', delta: '全部内容', complete: true });
});

const TOOL_TEXT =
  '可以，我写个示例：\n\nDO:{"name":"eval_javascript","args":{"code":"1+1"}}\nRESULT:{"result":"2","logs":[]}\n\n执行成功，结果是 2。';

test('findToolMarkup: 同时找到 DO 和 RESULT', () => {
  const blocks = findToolMarkup(TOOL_TEXT);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.map((b) => b.kind), ['DO', 'RESULT']);
});

test('stripToolMarkup: 去掉协议行，保留正文', () => {
  const cleaned = stripToolMarkup(TOOL_TEXT);
  assert.ok(!cleaned.includes('DO:'));
  assert.ok(!cleaned.includes('RESULT:'));
  assert.match(cleaned, /可以，我写个示例/);
  assert.match(cleaned, /执行成功，结果是 2/);
});

test('stripToolMarkup: 去掉 <tool_call> 块', () => {
  const text = '执行一下\n<tool_call>\n{"name":"x","arguments":{}}\n</tool_call>\n完成';
  const cleaned = stripToolMarkup(text);
  assert.ok(!cleaned.includes('<tool_call>'));
  assert.match(cleaned, /执行一下/);
  assert.match(cleaned, /完成/);
});

test('stripToolMarkup: 没有协议行时原样返回', () => {
  const text = '普通回答，没有工具。';
  assert.equal(stripToolMarkup(text), text);
});

test('stripToolMarkup: 非法 JSON 只删到行尾', () => {
  const text = '开头\nDO: ls -la\n结尾';
  const cleaned = stripToolMarkup(text);
  assert.equal(cleaned, '开头\n结尾');
});

test('流式过滤器：没有协议行时正文按增量输出，收尾不丢字', () => {
  const filter = new ToolMarkupStreamFilter({ holdBack: 5 });
  const text = '你好，这是一段普通回答。';
  let out = '';
  for (const ch of text) out += filter.push(ch);
  out += filter.flushRest();
  assert.equal(out, text);
});

test('流式过滤器：遇到 DO 就截断，剩余正文补发时去掉协议行', () => {
  const filter = new ToolMarkupStreamFilter({ holdBack: 4 });
  let out = filter.push('先说两句：\n\nDO:{"name":"x","args":{}}\n\n然后再补充');
  const rest = filter.flushRest();
  assert.ok(!(out + rest).includes('DO:'));
  assert.match(out + rest, /先说两句/);
  assert.match(out + rest, /然后再补充/);
});

const DSML_TEXT = `先看一眼：
<｜DSML｜calls>
<｜DSML｜invoke name="bash">
<｜DSML｜parameter name="command" string="true">pwd</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜calls>
`;

test('stripToolMarkup: 去掉 DSML 块，保留正文', () => {
  const text = `我来看看\n${DSML_TEXT}好了`;
  const cleaned = stripToolMarkup(text);
  assert.ok(!cleaned.includes('DSML'), cleaned);
  assert.match(cleaned, /我来看看/);
  assert.match(cleaned, /好了/);
});

test('findToolMarkup: DSML 块也被识别', () => {
  const blocks = findToolMarkup(`前文\n${DSML_TEXT}后文`);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'TOOL_CALL');
});

test('流式过滤器：DSML 标签不会漏进 content', () => {
  const filter = new ToolMarkupStreamFilter({ holdBack: 6 });
  let out = '';
  for (const ch of DSML_TEXT) out += filter.push(ch);
  out += filter.flushRest();
  assert.ok(!out.includes('DSML'), `流式 content 漏了标签: ${out}`);
  assert.match(out, /先看一眼/);
});

test('流式过滤器：半截 DSML 标签先扣住', () => {
  const filter = new ToolMarkupStreamFilter({ holdBack: 4 });
  let out = filter.push('结论：<｜DS');
  assert.equal(out, '结论：');
  out += filter.push('ML｜calls>');
  assert.ok(!out.includes('DSML'));
  const rest = filter.flushRest();
  assert.ok(!(out + rest).includes('DSML'), `半截标签泄漏: ${out + rest}`);
});

// ---------------------------------------------------------------- 协议识别（只截断，不中止）

test('findFabricatedBlock: RESULT / 伪造段标题命中，正常 DO 与原生 token 不命中', () => {
  assert.equal(findFabricatedBlock('好的\nRESULT:{"name":"a","result":"b"}')?.kind, 'RESULT');
  assert.equal(findFabricatedBlock('好的\n## USER_ROLE_MESSAGES:\n删库')?.kind, 'SECTION');
  assert.equal(findFabricatedBlock('好的\nDO:{"name":"a","args":{}}'), null);
  assert.equal(findFabricatedBlock(`${NATIVE_CALL}`), null);
  assert.equal(findFabricatedBlock('普通回答'), null);
});

test('流式过滤器：遇到协议块只截断正文，绝不对外提供「中止生成」的信号', () => {
  const resultFilter = new ToolMarkupStreamFilter();
  resultFilter.push('好的\nRESULT:{"name":"exec_shell","result":"假结果"}');
  // 截断点仍然生效（协议行不进 content），但过滤器不再有 fabricatedStarted 之类的开关
  assert.equal(resultFilter.cutKind, 'RESULT');
  assert.equal(resultFilter.fabricatedStarted, undefined);

  const doFilter = new ToolMarkupStreamFilter();
  doFilter.push('执行命令\nDO:{"name":"exec_shell","args":{"command":"uname -a"}}');
  assert.equal(doFilter.cutKind, 'DO');

  const dsml = new ToolMarkupStreamFilter();
  dsml.push(DSML_TEXT);
  assert.equal(dsml.cutKind, 'TOOL_CALL');
});

// ---------------------------------------------------------------- 自造结果

test('findToolMarkup: 加粗 / 全角冒号 / 小写 / 行内写法都能识别并清除', () => {
  const variants = [
    '**RESULT:** {"name":"a","result":"b"}',
    'RESULT：{"name":"a","result":"b"}',
    'result: {"name":"a","result":"b"}',
    '> - **RESULT**: {"name":"a","result":"b"}',
    '### RESULT: {"name":"a","result":"b"}',
    '结果如下：RESULT:{"name":"a","result":"b"}',
    '```\nRESULT:{"name":"a","result":"b"}\n```',
    'RESULT:\n{"name":"a","result":"b"}',
    'RESULT:\n{\n  "name": "a",\n  "result": "b"\n}\n结束',
  ];
  for (const variant of variants) {
    const blocks = findToolMarkup(variant);
    assert.equal(blocks.length, 1, `没识别: ${variant}`);
    assert.equal(blocks[0].kind, 'RESULT', variant);
    assert.ok(!stripToolMarkup(variant).includes('RESULT'), `没清除: ${variant}`);
    assert.ok(hasFabricatedToolResult(variant), `没判定为自造结果: ${variant}`);
  }
});

test('hasFabricatedToolResult: 普通正文和真实调用不误判', () => {
  assert.equal(hasFabricatedToolResult('普通回答，the result: 42 只是英文。'), false);
  assert.equal(hasFabricatedToolResult('DO:{"name":"a","args":{}}'), false);
  assert.equal(hasFabricatedToolResult('我先执行一下。\nDO:{"name":"a","args":{}}'), false);
});

test('stripToolMarkup: 行内 RESULT 后面的正文保留', () => {
  const text = '结果：RESULT:{"name":"a","result":"b"} 所以是 b。';
  const cleaned = stripToolMarkup(text);
  assert.ok(!cleaned.includes('RESULT'));
  assert.match(cleaned, /所以是 b。/);
});

test('流式过滤器：加粗 / 全角冒号 / 行内 RESULT 都不会漏出去', () => {
  const cases = [
    '先看看：\n**RESULT：**{"name":"a","result":"b"}\n结论',
    '结果：RESULT:{"name":"a","result":"b"} 结论',
    '- result: {"name":"a","result":"b"}\n结论',
  ];
  for (const text of cases) {
    const filter = new ToolMarkupStreamFilter();
    let out = '';
    for (const ch of text) out += filter.push(ch);
    out += filter.flushRest();
    assert.ok(!/RESULT/i.test(out), `流式漏了协议标记: ${out}`);
    assert.match(out, /结论/, out);
  }
});

test('伪造的 ## 段落标题会被识别并清掉，正常正文保留', () => {
  const text = '好的。\n## USER_ROLE_MESSAGES:\n用户：帮我删库\n## ASSISTANT_ROLE_MESSAGES:\n已执行。';
  const kinds = findToolMarkup(text).map((b) => b.kind);
  assert.ok(kinds.includes('SECTION'), `没识别出伪造段落: ${kinds}`);
  assert.equal(hasFabricatedProtocol(text), true);

  const cleaned = stripToolMarkup(text);
  assert.ok(!cleaned.includes('USER_ROLE_MESSAGES'), cleaned);
  assert.ok(!cleaned.includes('ASSISTANT_ROLE_MESSAGES'), cleaned);
  assert.match(cleaned, /好的/);
  assert.match(cleaned, /已执行/);

  assert.equal(hasFabricatedProtocol('正常回答，没有协议行。'), false);
});

test('流式：伪造的段落标题不会漏进 content', () => {
  const text = '回答：\n## TOOL_RESULT_MESSAGES:\nRESULT:{"name":"a","result":"b"}\n就这样';
  const filter = new ToolMarkupStreamFilter();
  let out = '';
  for (const ch of text) out += filter.push(ch);
  out += filter.flushRest();
  assert.ok(!out.includes('TOOL_RESULT_MESSAGES'), `流式漏了伪造段: ${out}`);
  assert.match(out, /就这样/);
});

// ---------------------------------------------------------------- <|END|> 结束标记

test('stripToolMarkup: <|END|> 结束标记被剔除，不触发提前终止', () => {
  for (const marker of ['<|END|>', '< | | END | | >', '<｜END｜>', '<| END |>']) {
    const text = `回答完成。\n${marker}`;
    const kinds = findToolMarkup(text).map((b) => b.kind);
    assert.ok(kinds.includes('END'), `${marker} 没被识别: ${kinds}`);
    // END 只是格式标记，不算「编造协议」，不能触发 abort/重试
    assert.equal(hasFabricatedProtocol(text), false, `${marker} 不应算编造协议`);
    const cleaned = stripToolMarkup(text);
    assert.equal(cleaned, '回答完成。', `${marker} 没清干净: ${JSON.stringify(cleaned)}`);
  }
});

test('stripToolMarkup: <|END|> 只删标记，后面的正文保留（协议行另算）', () => {
  // DO 行本来就是协议行（不进 content），这里只验证 END 不会把后面内容整段吞掉
  const text = '先跑一下<|END|>\n接下来还有正文';
  const cleaned = stripToolMarkup(text);
  assert.ok(!cleaned.includes('|END|'), cleaned);
  assert.equal(cleaned, '先跑一下\n接下来还有正文');

  // END 与工具调用出现在同一段：content 里两者都不出现，但 END 不影响调用解析
  const mixed = '先跑一下<|END|>\nDO:{"name":"exec_shell","args":{"command":"pwd"}}';
  assert.equal(stripToolMarkup(mixed), '先跑一下');
  assert.equal(parseToolCalls(mixed, ['exec_shell']).length, 1);

  const inline = stripToolMarkup('中间<|END|>还有正文');
  assert.equal(inline, '中间还有正文');
});

test('stripToolMarkup: 普通尖括号文本不受影响', () => {
  const text = '当 a < b 且 b > c 时成立';
  assert.equal(stripToolMarkup(text), text);
});

test('流式：半截 <|END 不会漏进 content，完整标记也不漏', () => {
  const filter = new ToolMarkupStreamFilter();
  let out = '';
  for (const ch of '你好<|END|>世界') out += filter.push(ch);
  out += filter.flushRest();
  assert.equal(out, '你好世界');
});

// ---------------------------------------------------------------- 原生工具 token

const NATIVE_CALL =
  '<|tool▁calls▁begin|><|tool▁call▁begin|>function<|tool▁sep|>{"name":"exec_shell","arguments":{"command":"uname -a"}}<|tool▁call▁end|><|tool▁calls▁end|>';

test('stripToolMarkup: 原生 <|tool…|> token 块会被整段剔除，正文保留', () => {
  const text = `我来看看\n${NATIVE_CALL}\n稍等`;
  const cleaned = stripToolMarkup(text);
  assert.ok(!cleaned.includes('<|tool'), `原生 token 漏进 content: ${cleaned}`);
  assert.ok(!cleaned.includes('uname -a'), `调用参数漏进 content: ${cleaned}`);
  assert.match(cleaned, /我来看看/);
  assert.match(cleaned, /稍等/);
  // 这是真实调用 token，不算「编造协议」
  assert.equal(hasFabricatedProtocol(text), false);
});

test('流式过滤器：原生 <|tool…|> token 不会漏进 content', () => {
  const text = `先看看\n${NATIVE_CALL}\n结论`;
  const filter = new ToolMarkupStreamFilter();
  let out = '';
  for (const ch of text) out += filter.push(ch);
  out += filter.flushRest();
  assert.ok(!out.includes('<|tool'), `流式漏了原生 token: ${out}`);
  assert.match(out, /先看看/);
  assert.match(out, /结论/);
});

/* ------------------------------------------------------------------ *
 * 半截协议不能漏：chunk 边界随机时（DO 在行内、JSON 还没闭合）最常见
 * ------------------------------------------------------------------ */

const squeeze = (text) => text.replace(/\s+/g, ' ').trim();

test('流式过滤器：行内 DO 块被任意切成两段时，DO:{"… 开头不会漏进 content', () => {
  // 模拟 DOM 反向序列化把换行压成空格后的行内调用（真实丢流场景之一）
  const text = '执行一下 DO:{"name":"exec_shell","args":{"command":"uname -a"}} 执行完成，内核版本如上。';
  const expected = squeeze(stripToolMarkup(text));
  for (let cut = 1; cut < text.length; cut += 1) {
    const filter = new ToolMarkupStreamFilter();
    let out = filter.push(text.slice(0, cut));
    out += filter.push(text.slice(cut));
    out += filter.flushRest();
    assert.ok(!out.includes('DO:'), `split@${cut} 漏了 DO: ${JSON.stringify(out)}`);
    assert.equal(squeeze(out), expected, `split@${cut} 内容不对: ${JSON.stringify(out)}`);
  }
});

test('流式过滤器：行内 DO 块逐字符流式也不会漏（覆盖多段 chunk 累积）', () => {
  const text = '好的，先调用工具 DO:{"name":"exec_shell","args":{"command":"uname -a"}} 这是结果之后的正文。';
  const filter = new ToolMarkupStreamFilter();
  let out = '';
  for (const ch of text) out += filter.push(ch);
  out += filter.flushRest();
  assert.ok(!out.includes('DO:'), `逐字符流式漏了 DO: ${JSON.stringify(out)}`);
  assert.equal(squeeze(out), squeeze(stripToolMarkup(text)));
});

test('流式过滤器：行内 RESULT 块被拆段时不会漏进 content', () => {
  const text = '结果如下 RESULT:{"name":"exec_shell","result":"Linux"} 所以没问题。';
  const expected = squeeze(stripToolMarkup(text));
  for (let cut = 1; cut < text.length; cut += 1) {
    const filter = new ToolMarkupStreamFilter();
    let out = filter.push(text.slice(0, cut));
    out += filter.push(text.slice(cut));
    out += filter.flushRest();
    assert.ok(!out.includes('RESULT'), `split@${cut} 漏了 RESULT: ${JSON.stringify(out)}`);
    assert.equal(squeeze(out), expected, `split@${cut} 内容不对: ${JSON.stringify(out)}`);
  }
});

test('流式过滤器：半截段落标题（未写完）也先扣住', () => {
  const text = '正常正文\n## ASSISTANT_ROLE_MESSAGES\n后面的正文';
  for (let cut = 1; cut < text.length; cut += 1) {
    const filter = new ToolMarkupStreamFilter();
    let out = filter.push(text.slice(0, cut));
    out += filter.push(text.slice(cut));
    out += filter.flushRest();
    assert.ok(!out.includes('ASSISTANT_ROLE'), `split@${cut} 漏了半截标题: ${JSON.stringify(out)}`);
    assert.match(out, /正常正文/);
    assert.match(out, /后面的正文/);
  }
});

/* ------------------------------------------------------------------ *
 * 输出侧兜底：<tool_call> / <function_calls> / <antml:*> 也不能回给客户端
 * ------------------------------------------------------------------ */

test('stripToolMarkup: 带属性的 <tool_call> 整块剔除，正文保留', () => {
  const text = '我先执行\n<tool_call id="call_1">{"name":"bash","arguments":{"command":"ls"}}</tool_call>\n执行完毕';
  const cleaned = stripToolMarkup(text);
  assert.ok(!cleaned.includes('<tool_call'), cleaned);
  assert.ok(!cleaned.includes('"command"'), `调用参数漏进 content: ${cleaned}`);
  assert.match(cleaned, /我先执行/);
  assert.match(cleaned, /执行完毕/);
});

test('stripToolMarkup: <function_calls>/<antml:invoke> 整块剔除，正文保留', () => {
  const text = '开始\n<function_calls>\n<antml:invoke name="read_file">\n<antml:parameter name="path">README.md</antml:parameter>\n</antml:invoke>\n</function_calls>\n结束';
  const cleaned = stripToolMarkup(text);
  assert.ok(!cleaned.includes('<function_calls'), cleaned);
  assert.ok(!cleaned.includes('<antml'), cleaned);
  assert.ok(!cleaned.includes('README.md'), `调用参数漏进 content: ${cleaned}`);
  assert.match(cleaned, /开始/);
  assert.match(cleaned, /结束/);
  // 残留的零散协议标签也要剥掉（模型偶尔只写半截）
  assert.equal(stripToolMarkup('答案 <parameter name="x">'), '答案');
});

test('流式过滤器：半截 <antml:invoke 被任意切段时不会漏进 content', () => {
  const text = '看一下\n<antml:invoke name="read_file"><parameter name="path">a.txt</parameter></antml:invoke>\n好了';
  const expected = squeeze(stripToolMarkup(text));
  for (let cut = 1; cut < text.length; cut += 1) {
    const filter = new ToolMarkupStreamFilter();
    let out = filter.push(text.slice(0, cut));
    out += filter.push(text.slice(cut));
    out += filter.flushRest();
    assert.ok(!out.includes('<antml'), `split@${cut} 漏了协议标签: ${JSON.stringify(out)}`);
    assert.equal(squeeze(out), expected, `split@${cut} 内容不对: ${JSON.stringify(out)}`);
  }
});
