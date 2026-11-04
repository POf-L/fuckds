import { findDsmlBlocks, findDsmlStart } from '../prompt/dsml.mjs';
import { findPendingProtocolTag, stripProtocolTags } from '../prompt/sanitize.mjs';
import { canonicalArguments, readJsonObject } from '../prompt/tools.mjs';

/**
 * 协议行识别。
 *
 * 模型输出得非常自由：`RESULT:{}`、`**RESULT:** {}`、`RESULT：{}`、`- result: {...}`、
 * 行内 `结果：RESULT:{}`、甚至包在代码块里。只认「行首 + 半角冒号」会漏掉一大半，
 * 于是模型编造的结果就顺着 content 流到了客户端。这里按两种形态识别：
 *
 *   1. 行首形态：`[装饰符] RESULT :`（装饰符 = markdown 列表/引用/加粗/代码符）
 *   2. 行内形态：任意位置 `RESULT:` 且紧跟一个 JSON 对象
 *
 * 两种形态都区分大小写、半角/全角冒号。
 */

/** 行首允许出现的「装饰符」，最多 24 个：`> `、`- `、`### `、`**`、反引号、序号 `1. ` 等 */
const LINE_LABEL = /^[^\p{L}\p{N}]{0,24}(DO|RESULT)[ \t]*[*_`~]{0,4}[ \t]*[:：=][ \t]*[*_`~]{0,4}/iu;
/** 行内形态：标签后面紧跟 JSON 对象才算协议，避免误伤正常行文 */
const INLINE_LABEL = /\b(DO|RESULT)\b[ \t]*[*_`~]{0,4}[ \t]*[:：=][ \t]*[*_`~]{0,4}(?=\{)/giu;
/** 模型把自己编造的上下文段/标题写进回答里：整行匹配，避免误伤正常行文 */
const SECTION_HEADER =
  /^[ \t]{0,3}(?:#{1,4}[ \t]*)?(?:SYSTEM|USER|ASSISTANT)_ROLE_MESSAGES[ \t]*[:：]?[ \t]*$/gimu;
const TOOL_RESULT_HEADER = /^[ \t]{0,3}(?:#{1,4}[ \t]*)?TOOL_RESULT_MESSAGES[ \t]*[:：]?[ \t]*$/gimu;
const TOOL_FUNCTIONS_HEADER = /^[ \t]{0,3}(?:#{1,4}[ \t]*)?TOOL_FUNCTIONS[ \t]*[:：]?[ \t]*$/gimu;
const CONTEXT_HEADER = /^[ \t]{0,3}(?:#{1,4}[ \t]*)?CONTEXT_ATTACHMENT[ \t]*[:：]?[ \t]*$/gimu;
const PROMPT_HEADER_LINE = /^[ \t]{0,3}#{1,4}[ \t]*MESSAGES[ \t]*[:：]?[ \t]*$/gimu;
/** 新协议的段标题：## System: / ## User: / ## Tool_calls: / ## Tool_call_result: 之类 */
const PROTOCOL_HEADER =
  /^[ \t]{0,3}#{1,4}[ \t]*(?:System|User|Assistant|Tool_calls|Tool_call_result|Tool_functions|CONTEXT_ATTACHMENT|Messages)[ \t]*[:：]?[ \t]*$/gimu;
const SECTION_PATTERNS = [
  SECTION_HEADER,
  TOOL_RESULT_HEADER,
  TOOL_FUNCTIONS_HEADER,
  CONTEXT_HEADER,
  PROMPT_HEADER_LINE,
  PROTOCOL_HEADER,
];
/** 冒号后面的装饰符（空格 / 加粗 / 反引号），payload 从这之后开始 */
const AFTER_LABEL_DECOR = /[ \t*_`~]/;
/** 协议行整行删除时，顺手把行尾的一个换行一起吃掉 */
function consumeLineBreak(text, index) {
  let i = index;
  if (text[i] === '\r') i += 1;
  if (text[i] === '\n') i += 1;
  return i;
}

/** 原生工具 token 的正则：`<|tool▁calls▁begin|>`、`<|tool▁call▁end|>`、`<|tool_calls|>` 之类 */
const NATIVE_TOOL_TOKEN = /<[ \t]*\|[^|<>\r\n]{0,64}tool[^|<>\r\n]{0,64}\|[ \t]*>/gi;

/**
 * 自带的结束标记 `<|END|>`（也认全角竖线 / 双层竖线 / 带空格的写法）。
 *
 * 提示词里要求模型「每轮完成后输出 <|END|>」，但它是完整的特殊 token，绝不能漏进正文。
 * 只删 token 本身，不删它后面的正文（正常回答/工具调用常跟在后面）。
 */
const END_TOKEN = /<[ \t]*[|｜][ \t]*(?:[|｜][ \t]*)?END[ \t]*(?:[|｜][ \t]*){1,2}[ \t]*>/gi;

/** 找出 `<|END|>` 标记，作为独立协议块（正文清洗时剔除，但不算伪造协议） */
export function findEndTokenBlocks(text) {
  if (!text) return [];
  END_TOKEN.lastIndex = 0;
  const blocks = [];
  let match;
  while ((match = END_TOKEN.exec(text)) !== null) {
    blocks.push({ kind: 'END', start: match.index, end: match.index + match[0].length });
  }
  return blocks;
}

/**
 * 半截的 `<|END` 标签（流式还没吐完）起点；没有则返回 -1。
 * 只认从 `<` 到结尾都还是合法前缀的情况，避免误扣正常正文里的 `<`。
 */
export function findPendingEndToken(text, from = 0) {
  if (!text) return -1;
  const lt = text.lastIndexOf('<');
  if (lt < Math.max(0, from)) return -1;
  const tail = text.slice(lt);
  if (tail.length > 48) return -1;
  if (!/^<[ \t]*[|｜][ \t]*(?:[|｜][ \t]*)?(?:E(?:N(?:D)?)?)?[ \t]*[|｜]?[ \t]*$/.test(tail)) return -1;
  // 已经写完的 <|END|> 交给 findEndTokenBlocks 处理，这里只扣没写完的
  if (/^<[ \t]*[|｜][ \t]*(?:[|｜][ \t]*)?END[ \t]*(?:[|｜][ \t]*){1,2}[ \t]*>$/i.test(tail)) return -1;
  return lt;
}

/**
 * 找出原生工具 token 块。
 * 一次原生调用通常是 `<|tool▁calls▁begin|><|tool▁call▁begin|>…参数 JSON…<|tool▁call▁end|><|tool▁calls▁end|>`，
 * 所以取「首个 token → 末个 token」作为协议区；若 JSON 落在末尾 token 之后，再把它一起吃掉。
 */
export function findNativeToolTokenBlocks(text) {
  if (!text) return [];
  NATIVE_TOOL_TOKEN.lastIndex = 0;
  const tokens = [];
  let match;
  while ((match = NATIVE_TOOL_TOKEN.exec(text)) !== null) {
    tokens.push({ start: match.index, end: match.index + match[0].length });
  }
  if (!tokens.length) return [];

  const start = tokens[0].start;
  let end = tokens[tokens.length - 1].end;
  let probe = end;
  while (probe < text.length && /\s/.test(text[probe])) probe += 1;
  if (text[probe] === '{') {
    const json = readJsonObject(text, probe);
    if (json) end = probe + json.length;
  }
  // 行尾换行一起吃掉，避免留下空行
  end = consumeLineBreak(text, end);
  return [{ kind: 'TOOL_CALL', start, end }];
}

/**
 * 找出文本里的 DO:/RESULT: 块。
 * 这些是「给模型看的协议行」，不应该出现在 OpenAI 的 content 里。
 */
export function findToolMarkup(text) {
  const blocks = [];
  if (!text) return blocks;

  // <tool_call>{...}</tool_call>（带属性 / <tool_calls> 也认）
  const xmlPattern = /<tool_calls?\b[^>]*>[\s\S]*?<\/tool_calls?>/gi;
  let xml;
  while ((xml = xmlPattern.exec(text)) !== null) {
    blocks.push({ kind: 'TOOL_CALL', start: xml.index, end: xml.index + xml[0].length });
  }

  // <function_calls>…</function_calls>（Anthropic 风格：外层包多个 invoke）
  const functionCalls = /<function_calls\b[^>]*>[\s\S]*?<\/function_calls>/gi;
  let fc;
  while ((fc = functionCalls.exec(text)) !== null) {
    blocks.push({ kind: 'TOOL_CALL', start: fc.index, end: fc.index + fc[0].length });
  }

  // <antml:invoke> / <invoke> / <parameter> 块（没有外层包装时单独成块）
  const invokeBlock = /<(?:antml:)?(?:invoke|parameter)\b[^>]*>[\s\S]*?<\/(?:antml:)?(?:invoke|parameter)>/gi;
  let inv;
  while ((inv = invokeBlock.exec(text)) !== null) {
    if (covered(blocks, inv.index)) continue;
    blocks.push({ kind: 'TOOL_CALL', start: inv.index, end: inv.index + inv[0].length });
  }

  // DSML：<｜DSML｜calls>…</｜DSML｜calls>（含未闭合的残段）
  for (const block of findDsmlBlocks(text)) {
    const overlapped = blocks.some((b) => b.start <= block.start && block.start < b.end);
    if (overlapped) continue;
    blocks.push({ kind: 'TOOL_CALL', start: block.start, end: block.end });
  }

  // 原生工具 token：<|tool▁calls▁begin|>…<|tool▁calls▁end|>（含中间夹的 JSON 参数体）。
  // 这些是模型的原生调用 token，绝不能漏进 content / SSE。
  for (const block of findNativeToolTokenBlocks(text)) {
    if (covered(blocks, block.start)) continue;
    blocks.push(block);
  }

  // 模型伪造的上下文段标题（## USER_ROLE_MESSAGES 之类）
  for (const block of findSectionBlocks(text)) {
    if (covered(blocks, block.start)) continue;
    blocks.push(block);
  }

  // 自带的结束标记 <|END|>：整块剔除（只删 token，不删后面的正文）
  for (const block of findEndTokenBlocks(text)) {
    if (covered(blocks, block.start)) continue;
    blocks.push(block);
  }

  // 行首形态
  let offset = 0;
  while (offset <= text.length) {
    let lineEnd = text.indexOf('\n', offset);
    if (lineEnd === -1) lineEnd = text.length;
    const line = text.slice(offset, lineEnd);
    const match = LINE_LABEL.exec(line);
    if (match && !covered(blocks, offset + match.index)) {
      const kind = match[1].toUpperCase();
      let cursor = offset + match[0].length;
      while (cursor < lineEnd && AFTER_LABEL_DECOR.test(text[cursor])) cursor += 1;

      // 模型经常把 JSON 缩进/换行写到下一行
      let probe = cursor;
      if (text[probe] === '\r') probe += 1;
      if (text[probe] === '\n') {
        probe += 1;
        while (text[probe] === ' ' || text[probe] === '\t') probe += 1;
      }

      let end;
      let hasJson = false;
      if (text[probe] === '{') {
        const json = readJsonObject(text, probe);
        if (json) {
          end = probe + json.length;
          hasJson = true;
          // JSON 后面只剩空白时一并吃掉
          while (end < lineEnd && (text[end] === ' ' || text[end] === '\t')) end += 1;
          // JSON 占满整行时，把行尾换行也删掉，免得留下空行
          if (end >= lineEnd) end = consumeLineBreak(text, end);
        }
      }
      if (!hasJson) {
        // 整行都是协议（或格式不标准）：连着行尾换行一起删，避免留下空行
        end = consumeLineBreak(text, lineEnd);
      }
      // hasJson 是「这行到底像不像协议」的关键：`RESULT:{...}` 是模型编造的工具结果（要中止生成），
      // 而正文里的散文 `Result: 已打开` 只是碰巧以 RESULT: 开头，绝不能当成编造把整轮掐掉。
      blocks.push({ kind, start: offset, end, hasJson });
    }
    offset = lineEnd + 1;
    if (lineEnd === text.length) break;
  }

  // 行内形态：`结果如下：RESULT:{...}`
  INLINE_LABEL.lastIndex = 0;
  let inline;
  while ((inline = INLINE_LABEL.exec(text)) !== null) {
    if (covered(blocks, inline.index)) continue;
    const brace = inline.index + inline[0].length;
    const json = readJsonObject(text, brace);
    if (!json) continue;
    blocks.push({ kind: inline[1].toUpperCase(), start: inline.index, end: brace + json.length, hasJson: true });
  }

  return merge(blocks);
}

function covered(blocks, index) {
  return blocks.some((block) => block.start <= index && index < block.end);
}

const KIND_RANK = { TOOL_CALL: 0, DO: 1, END: 1, SECTION: 2, RESULT: 3 };

function merge(blocks) {
  const sorted = blocks.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const block of sorted) {
    const last = merged.at(-1);
    if (last && block.start < last.end) {
      last.end = Math.max(last.end, block.end);
      if (block.hasJson) last.hasJson = true;
      // 重叠区间合并成一个，类型取更「具体」的那个（RESULT > DO > TOOL_CALL）
      if ((KIND_RANK[block.kind] ?? 0) > (KIND_RANK[last.kind] ?? 0)) last.kind = block.kind;
    } else {
      merged.push({ ...block });
    }
  }
  return merged;
}

/** 找出模型伪造的 ## ROLE 段标题（整行），用于从 content 里剔除 */
export function findSectionBlocks(text) {
  const blocks = [];
  if (!text) return blocks;
  for (const pattern of SECTION_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      let end = match.index + match[0].length;
      // 连同行尾换行一起删掉，避免留下空行
      end = consumeLineBreak(text, end);
      blocks.push({ kind: 'SECTION', start: match.index, end });
    }
  }
  return blocks;
}

/** 去掉协议行，保留正常正文 */
export function stripToolMarkup(text) {
  if (!text) return '';
  const blocks = findToolMarkup(text);

  let out = '';
  let cursor = 0;
  for (const block of blocks) {
    out += text.slice(cursor, block.start);
    cursor = block.end;
  }
  out += text.slice(cursor);

  return (
    stripProtocolTags(out)
      // 协议行被拿走后常常只剩一对空代码块
      .replace(/```[a-zA-Z0-9_+-]*[ \t]*\r?\n[ \t]*\r?\n?[ \t]*```(\r?\n)?/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/**
 * 流式收尾对齐：把「已经流给客户端的文本」和「权威最终文本」对齐，算出还缺的尾巴。
 *
 * 为什么需要它：SSE 一旦写出去就没法撤回，只能追加。而浏览器引擎的流式展示来自
 * DOM 的 markdown 反向序列化，权威文本来自页面自己请求的原始补全流，两者经常**不是
 * 严格前缀关系**（标题/列表/代码块的换行数量、行尾空格、列表符号 `*` vs `-`、加粗
 * 收尾符……）。旧实现只在「严格前缀」时补发尾巴，一旦分叉就整段跳过，客户端于是停在
 * 截断处（丢流），而最终 result.text 却是完整的。
 *
 * 对齐策略（从保守到激进）：
 *   1. 严格前缀：直接取剩余部分 —— 正常路径；
 *   2. 已流出的内容覆盖了目标：不补（客户端可能多了 markdown 收尾符，多了不能撤回）；
 *   3. 忽略空白逐字符对齐：sent 走完时把 target 剩下的全部补上 —— 空行/行尾空格/缩进
 *      这类 DOM 序列化差异走这条，能完整补出尾部；
 *   4. 尾部锚点：在忽略空白的归一化文本里找 sent 结尾片段在 target 的最后一次出现，
 *      从锚点之后补 —— 列表符号/加粗符这类 markdown 归一化差异走这条；
 *   5. 完全对不上：宁可少发也不重复（complete=false，交给调用方决定是否报错）。
 *
 * @param {string} sent 已经发给客户端的文本
 * @param {string} target 权威最终文本（应覆盖 sent 的语义内容）
 * @returns {{ text: string, delta: string, complete: boolean }}
 *   text  = 客户端最终应看到的文本（保证以 sent 为前缀）
 *   delta = 还需要补发的增量
 *   complete = 是否已经覆盖权威文本的尾巴（false 表示可能截断）
 */
export function reconcileStreamedText(sent, target) {
  const streamed = typeof sent === 'string' ? sent : '';
  const final = typeof target === 'string' ? target : '';
  if (!final) return { text: streamed, delta: '', complete: true };
  if (final === streamed) return { text: final, delta: '', complete: true };
  if (final.startsWith(streamed)) {
    return { text: final, delta: final.slice(streamed.length), complete: true };
  }
  if (streamed.startsWith(final)) {
    // 客户端已经拿到全部权威正文（多出来的只能是渲染收尾符），不需要补
    return { text: streamed, delta: '', complete: true };
  }

  // 忽略空白对齐：逐字符比较，跳过任意一侧的空白
  let i = 0;
  let j = 0;
  while (i < streamed.length && j < final.length) {
    if (streamed[i] === final[j]) {
      i += 1;
      j += 1;
    } else if (/\s/.test(streamed[i])) {
      i += 1;
    } else if (/\s/.test(final[j])) {
      j += 1;
    } else {
      break;
    }
  }
  if (i >= streamed.length) {
    const delta = final.slice(j);
    return { text: streamed + delta, delta, complete: true };
  }
  // sent 剩下的只有空白 → 已经覆盖
  let rest = i;
  while (rest < streamed.length && /\s/.test(streamed[rest])) rest += 1;
  if (rest >= streamed.length) return { text: streamed, delta: '', complete: true };

  // 尾部锚点：忽略空白后在 target 里找 sent 结尾片段，从锚点之后补齐
  const anchored = anchorTail(streamed, final);
  if (anchored !== null) return { text: streamed + anchored, delta: anchored, complete: true };

  return { text: streamed, delta: '', complete: false };
}

/** 在忽略空白的归一化文本里找 sent 尾部锚点，返回 target 锚点之后的原文（找不到返回 null） */
function anchorTail(streamed, final) {
  const sentNorm = normalizeForAnchor(streamed);
  const finalNorm = normalizeForAnchor(final);
  if (!sentNorm.text || !finalNorm.text) return null;
  const longest = Math.min(96, sentNorm.text.length);
  for (let len = longest; len >= 4; len -= 1) {
    const needle = sentNorm.text.slice(-len);
    const at = finalNorm.text.lastIndexOf(needle);
    if (at < 0) continue;
    const endNorm = at + len;
    const endOrig = endNorm < finalNorm.map.length ? finalNorm.map[endNorm] : final.length;
    return final.slice(endOrig);
  }
  return null;
}

/**
 * 去掉空白并记住每个字符在原文里的下标（用于把归一化位置映射回原文）。
 * 行首的列表符号 `-` / `*` / `+` 统一成 `•`：模型原始文本常写 `* 项`，
 * DOM 反向序列化却总是输出 `- 项`，这类差异不该妨碍尾部锚定。
 */
function normalizeForAnchor(text) {
  let out = '';
  const map = [];
  let atLineStart = true;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      if (ch === '\n') atLineStart = true;
      continue;
    }
    out += atLineStart && (ch === '-' || ch === '*' || ch === '+') ? '•' : ch;
    map.push(i);
    atLineStart = false;
  }
  return { text: out, map };
}

/** 模型这一轮是否自己写了工具结果（RESULT）——正常情况只有系统会写 */
export function hasFabricatedToolResult(text) {
  return findToolMarkup(text).some((block) => block.kind === 'RESULT');
}

/** 模型是否伪造了系统段落（RESULT / ## ROLE 段）——这些都不该由模型输出 */
export function hasFabricatedProtocol(text) {
  return findToolMarkup(text).some((block) => isFabricatedBlock(block));
}

/** 找出文本里第一个「模型伪造协议」的块（RESULT / 伪造 ## 段标题）；正常 DO / DSML / 原生工具调用 / END 不算 */
export function findFabricatedBlock(text) {
  if (!text) return null;
  return findToolMarkup(text).find((block) => isFabricatedBlock(block)) || null;
}

/**
 * 伪造协议的判定：`RESULT:{...}`（带 JSON 的假工具结果）/ 伪造段标题。
 *
 * 注意 RESULT 必须**真的跟着 JSON** 才算：正文里一句散文 `Result: 已打开 Telegram`
 * 也会被 LINE_LABEL 认成协议行（那一行仍会从 content 里剔除），但它不是编造，
 * 绝不能据此中止生成 —— 否则一整轮会被掐断，客户端只看到流断在半路。
 *
 * 自带的结束标记 `<|END|>` 用独立的 END 类型，只是格式标记（不触发重试、不提前终止），不在此列。
 */
function isFabricatedBlock(block) {
  if (block.kind === 'SECTION') return true;
  if (block.kind !== 'RESULT') return false;
  return block.hasJson === true;
}

/** 流式：提前找到伪造段标题的位置（完整行才算） */
function findSectionStart(text, from = 0) {
  if (!text) return -1;
  let best = -1;
  for (const pattern of SECTION_PATTERNS) {
    pattern.lastIndex = Math.max(0, from);
    const match = pattern.exec(text);
    if (match && (best === -1 || match.index < best)) best = match.index;
  }
  return best;
}

/** 段落标题的「可能前缀」：整行还没写完时先扣住，避免半截标题漏进正文 */
const SECTION_PHRASES = [
  'SYSTEM',
  'USER',
  'ASSISTANT',
  'TOOL_CALLS',
  'TOOL_CALL_RESULT',
  'TOOL_FUNCTIONS',
  'CONTEXT_ATTACHMENT',
  'MESSAGES',
  'SYSTEM_ROLE_MESSAGES',
  'USER_ROLE_MESSAGES',
  'ASSISTANT_ROLE_MESSAGES',
  'TOOL_RESULT_MESSAGES',
];

/**
 * DO/RESULT 后面只跟了装饰符 / 冒号（可能还有尚未闭合的 JSON）→ 说明协议正在成形。
 * 注意：这个判断只用于「还没被 findToolMarkup 认出来」的情况，完整块由 cutIndex 处理。
 */
const PENDING_LABEL_TAIL = /^(?:DO|RESULT)\b[ \t*_`~]{0,4}(?:[:：=][ \t*_`~]{0,16}(?:\{[\s\S]*)?)?$/i;
const LABEL_TOKEN = /\b(?:DO|RESULT)\b/gi;
/** 半截原生工具 token：<|tool▁calls▁begin|> 这类一定带竖线，不会误伤正常 "<" 文本 */
const PENDING_NATIVE_TOKEN = /^<[ \t]*\|[^<>]*$/;

/**
 * 找出「可能正在成形的协议」的起点（-1 表示没有）。
 *
 * 流式 chunk 边界随机时，一个 DO 块可能在 JSON 闭合前被拆成好几段；如果只靠 holdBack，
 * 超长参数会让 DO:{"... 的开头先被当正文发出去，之后再也收不回来（客户端 content 里残留协议）。
 * 所以这里把三类半截协议整段扣住，等它们要么闭合（走 cutIndex）要么被证伪（正常正文）：
 *   - 半截 DO:/RESULT:（含未闭合 JSON）
 *   - 半截段落标题（## USER_ROLE_MESSAGES 之类）
 *   - 半截原生工具 token（<|tool…）
 */
function pendingProtocolStart(text, from) {
  if (!text) return -1;
  const start = Math.max(0, from);
  const candidates = [];

  LABEL_TOKEN.lastIndex = 0;
  let match;
  while ((match = LABEL_TOKEN.exec(text)) !== null) {
    if (match.index < start) continue;
    if (PENDING_LABEL_TAIL.test(text.slice(match.index))) candidates.push(match.index);
  }

  const lt = text.lastIndexOf('<');
  if (lt >= start && PENDING_NATIVE_TOKEN.test(text.slice(lt))) candidates.push(lt);

  const lineStart = text.lastIndexOf('\n') + 1;
  if (lineStart >= start) {
    const line = text.slice(lineStart);
    // 只有 markdown 标题行（# / ## …）才可能是协议段标题，
    // 否则正文里以 "System: ..." 开头的普通句子会被整行扣住不发。
    const isHeading = /^[ \t]{0,3}#{1,4}[ \t]*\S/.test(line);
    const stripped = line
      .replace(/^[ \t]{0,3}(?:#{1,4}[ \t]*)?/, '')
      .replace(/[*_`~ \t]+/g, '');
    const upper = stripped.toUpperCase();
    const isPhrase = !upper || SECTION_PHRASES.some((phrase) => phrase.startsWith(upper) || upper.startsWith(phrase));
    if (isPhrase && (isHeading || !upper)) candidates.push(lineStart);
  }

  return candidates.length ? Math.min(...candidates) : -1;
}

/**
 * 流式过滤器：把 content 里的 RESULT / 协议段标题挡在 SSE 之外。
 * 先发正文，遇到协议行就停；最后再按「有没有解析出工具调用」决定是否把后面的正文补上。
 *
 * holdBack 必须大于最长的「协议前缀」——但只有 holdBack 还不够：DO 的 JSON 参数可能很长，
 * 在 JSON 闭合前 findToolMarkup 认不出协议块，如果这段超过 holdBack，DO:{"... 的开头
 * 就会被提前当成正文发出去（真实流式下 chunk 边界随机，偶发泄漏）。所以除了 holdBack，
 * 还要用 pendingProtocolStart() 把「可能正在成形的协议」整段扣在手里。
 */
export class ToolMarkupStreamFilter {
  constructor({ holdBack = 48 } = {}) {
    this.buffer = '';
    this.emitted = 0;
    this.cutIndex = -1;
    this.holdBack = holdBack;
    /** 触发截断的块类型：DO / TOOL_CALL / RESULT / SECTION */
    this.cutKind = null;
  }

  push(text) {
    if (text) this.buffer += text;
    this.#refreshCut();

    let limit = this.cutIndex >= 0 ? this.cutIndex : Math.max(0, this.buffer.length - this.holdBack);
    if (this.cutIndex < 0) {
      // 半截 DSML 标签也先扣在手里
      const dsml = findDsmlStart(this.buffer, this.emitted);
      if (dsml) limit = Math.min(limit, dsml.index);
      // 半截 DO:/RESULT:、半截段落标题、半截原生工具 token：同样不能先发出去
      const pending = pendingProtocolStart(this.buffer, this.emitted);
      if (pending >= 0) limit = Math.min(limit, pending);
      // 半截 <|END 也不能先发（完整 <|END|> 由 findToolMarkup 整块剔除）
      const pendingEnd = findPendingEndToken(this.buffer, this.emitted);
      if (pendingEnd >= 0) limit = Math.min(limit, pendingEnd);
      // 半截 <tool_call> / <function_calls> / <antml:invoke> 同理：闭合前扣在手里
      const pendingTag = findPendingProtocolTag(this.buffer, this.emitted);
      if (pendingTag >= 0) limit = Math.min(limit, pendingTag);
    }
    return this.#slice(limit);
  }

  /** 更新「截断点」：找到第一个协议块（工具调用 / RESULT / 伪造段标题）就停在那之前。 */
  #refreshCut() {
    if (this.cutIndex >= 0) return;
    const cut = this.#findCut();
    if (!cut) return;
    this.cutIndex = cut.index;
    this.cutKind = cut.kind;
  }

  /** 没有工具调用：把剩下的正文（含被挡住的部分，去掉协议行）补发出去 */
  flushRest() {
    const rest = this.cutIndex >= 0 ? this.buffer.slice(this.cutIndex) : this.buffer.slice(this.emitted);
    const cleaned = this.cutIndex >= 0 ? stripToolMarkup(rest) : rest;
    this.emitted = this.buffer.length;
    return cleaned;
  }

  #findCut() {
    const candidates = [];
    const blocks = findToolMarkup(this.buffer);
    if (blocks.length) candidates.push({ index: blocks[0].start, kind: blocks[0].kind });
    const dsml = findDsmlStart(this.buffer, this.emitted);
    // 只有标签已经完整时才永久截断；半截标签由 holdBack 兜住
    if (dsml?.complete) candidates.push({ index: dsml.index, kind: 'TOOL_CALL' });
    const section = findSectionStart(this.buffer, this.emitted);
    if (section >= 0) candidates.push({ index: section, kind: 'SECTION' });
    if (!candidates.length) return null;
    const first = candidates.reduce((a, b) => (b.index < a.index ? b : a));
    return { index: first.index, kind: first.kind };
  }

  #slice(limit) {
    if (limit <= this.emitted) return '';
    const out = this.buffer.slice(this.emitted, limit);
    this.emitted = limit;
    return out;
  }
}
