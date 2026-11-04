import { ApiError } from '../errors.mjs';

/**
 * 上送 prompt 前的协议标签清洗。
 *
 * 背景：DeepSeek 网页端会把 XML 风格的「工具协议」标记当成自动化 / 越狱信号。
 * 客户端（opencode、Claude Code、各类 agent 框架）的系统提示常常整段列举
 * `<tool_call>`、`<function_calls>`、`<antml:invoke>` 这类标签；而网页端本来就产不出
 * tool_calls，这些文字对回答毫无用处，只会放大风控面。所以拼 prompt 之前先清掉。
 *
 * 只处理**已知协议标签集合**，绝不「删掉所有 <...>」：
 *
 *   1. DSML：`<｜DSML｜calls>` / `<｜DSML｜invoke>` / `<｜DSML｜parameter>`
 *      （含闭合 / 自闭合、全角与半角竖线、标签名前的空格）；
 *   2. 通用协议标签：`tool_call(s)`、`function_call(s)`、`invoke`、`parameter`，
 *      允许命名空间前缀（`antml:` / `dsml:` / `mcp:` …），以及 `antml:*` 任意后缀。
 *
 * 为什么不会误伤普通 XML：
 *   - 只认这张名单里的标签名（外加 `antml:` 命名空间），普通示例 `<note>`、`<item>`、
 *     `<book id="1">` 完全匹配不上；
 *   - 标签必须真的闭合到 `>`（属性区长度的上限很小），半截的 `<`、比较运算符 `a < b`、
 *     普通 HTML 片段都不会被当成协议；
 *   - 清洗动作是**去掉标签本身**（连同属性），保留标签之间的正文：
 *     `<parameter name="city">Paris` 这种参数值本来就是要给模型看的上下文，
 *     删掉标签只留下 `Paris` 才是正确的。
 */

const SP = '[ \\t]*';
const PIPE = '[｜|]';
const PIPES = `(?:${PIPE}${SP}){0,2}`;
const SLASH = `(?:/${SP})?`;
/** 属性区限制长度，避免把后面大段正文当属性吞掉；不跨越 `<` / `>` */
const ATTRS = '[^<>]{0,200}?';

/** DSML 专用写法：竖线包裹的 DSML 前缀 + calls / invoke / parameter */
const DSML_TAG = new RegExp(
  `<${SP}${SLASH}${PIPES}DSML${SP}${PIPES}(?:(?:tool_)?calls?|invoke|parameter)${SP}(?=[\\s/>])${ATTRS}>`,
  'gi',
);

/** 通用协议标签：tool_call(s) / function_call(s) / invoke / parameter / antml:*（可带命名空间） */
const GENERIC_TAG = new RegExp(
  `<${SP}${SLASH}(?:antml:[\\w.-]{1,32}|(?:[a-z][\\w.-]{0,15}:)?(?:dsml|tool_calls?|function_calls?|invoke|parameter))${SP}(?=[\\s/>])${ATTRS}>`,
  'gi',
);

const PATTERNS = [DSML_TAG, GENERIC_TAG];

/** 已知协议标签名单（日志与文档里的分组维度） */
export const PROTOCOL_TAG_NAMES = [
  'dsml',
  'tool_call',
  'tool_calls',
  'function_call',
  'function_calls',
  'invoke',
  'parameter',
  'antml:*',
];

/** 从命中的标签原文里取出用于日志的标签名（不记录正文，只记名字） */
function tagNameOf(raw) {
  let text = raw.replace(/^<[ \t]*\/?[ \t]*/, '').replace(/[｜|]/g, ' ');
  text = text.split('>')[0];
  const parts = text.trim().split(/\s+/);
  const head = (parts[0] || '').toLowerCase();
  // <｜DSML｜ calls> → parts = ['', 'DSML', 'calls']，竖线换空格后会有空串
  if (/^dsml$/.test(head)) return (parts.find((p) => p && p.toLowerCase() !== 'dsml') || 'dsml').toLowerCase();
  if (/^dsml:/.test(head)) return head.slice(5) || 'dsml';
  return head || 'unknown';
}

/**
 * 统计文本里命中的协议标签（只返回数量与标签名，绝不返回内容）。
 * @returns {{ count: number, byName: Record<string, number> }}
 */
export function scanProtocolTags(text) {
  const byName = {};
  let count = 0;
  if (typeof text !== 'string' || !text) return { count, byName };

  for (const pattern of PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const name = tagNameOf(match[0]);
      byName[name] = (byName[name] ?? 0) + 1;
      count += 1;
      if (match[0].length === 0) pattern.lastIndex += 1;
    }
  }
  return { count, byName };
}

/** 去掉协议标签本身（保留标签之间的正文） */
export function stripProtocolTags(text) {
  if (typeof text !== 'string' || !text) return typeof text === 'string' ? text : '';
  let out = text;
  for (const pattern of PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, '');
  }
  return out;
}

/** 清洗单段文本，同时返回命中统计 */
export function sanitizeText(text, { enabled = true } = {}) {
  if (typeof text !== 'string' || !text) {
    return { text: typeof text === 'string' ? text : '', hits: { count: 0, byName: {} } };
  }
  const hits = scanProtocolTags(text);
  if (!enabled || !hits.count) return { text, hits };
  return { text: stripProtocolTags(text), hits };
}

function counter() {
  const byName = {};
  let count = 0;
  return {
    add(hits) {
      count += hits.count;
      for (const [name, n] of Object.entries(hits.byName)) byName[name] = (byName[name] ?? 0) + n;
    },
    clean(value, enabled) {
      const result = sanitizeText(value, { enabled });
      this.add(result.hits);
      return result.text;
    },
    result() {
      return { count, byName };
    },
  };
}

/**
 * 清洗一轮 messages 里所有会进 prompt 的文本：
 * system / user / assistant 历史 / tool 结果 / 附件名（message.name）/ 历史工具参数。
 * 图片 url 等非文本字段原样保留。
 *
 * @returns {{ messages: object[], hits: { count: number, byName: Record<string, number> } }}
 */
export function sanitizeMessages(messages, { enabled = true } = {}) {
  const hits = counter();
  const out = (Array.isArray(messages) ? messages : []).map((message) => {
    if (!message || typeof message !== 'object') return message;
    const next = { ...message };

    if (typeof message.content === 'string') {
      next.content = hits.clean(message.content, enabled);
    } else if (Array.isArray(message.content)) {
      next.content = message.content.map((part) => {
        if (!part || typeof part !== 'object') return part;
        if (typeof part.text !== 'string') return part;
        return { ...part, text: hits.clean(part.text, enabled) };
      });
    }

    if (typeof message.name === 'string') next.name = hits.clean(message.name, enabled);

    if (Array.isArray(message.tool_calls)) {
      next.tool_calls = message.tool_calls.map((call) => {
        const fn = call?.function;
        if (!fn || typeof fn !== 'object' || typeof fn.arguments !== 'string') return call;
        return { ...call, function: { ...fn, arguments: hits.clean(fn.arguments, enabled) } };
      });
    }

    return next;
  });

  return { messages: out, hits: hits.result() };
}

/** 工具定义也会进 prompt：名称 / 描述 / 参数 schema 里的文本都清一遍 */
export function sanitizeTools(tools, { enabled = true } = {}) {
  const hits = counter();
  const out = (Array.isArray(tools) ? tools : []).map((tool) => {
    if (!tool || typeof tool !== 'object') return tool;
    const hasWrapper = Boolean(tool.function);
    const fn = tool.function ?? tool;
    if (!fn || typeof fn !== 'object') return tool;

    const nextFn = { ...fn };
    if (typeof nextFn.name === 'string') nextFn.name = hits.clean(nextFn.name, enabled).trim();
    if (typeof nextFn.description === 'string') nextFn.description = hits.clean(nextFn.description, enabled);
    if (nextFn.parameters && typeof nextFn.parameters === 'object') {
      nextFn.parameters = JSON.parse(hits.clean(JSON.stringify(nextFn.parameters), enabled));
    }
    return hasWrapper ? { ...tool, function: nextFn } : nextFn;
  });

  return { tools: out, hits: hits.result() };
}

/**
 * 上送前自检：只要还有协议标签，就拒绝发送（而不是静默带出去）。
 * 错误信息只给数量和标签名，不给正文。
 */
export function assertNoProtocolTags(text, where = 'prompt', { allow = [] } = {}) {
  // allow = 服务端自己写的、有意保留的协议说明（仅显式保留客户端 tools 时才存在）
  let body = typeof text === 'string' ? text : '';
  for (const chunk of allow) {
    if (typeof chunk === 'string' && chunk) body = body.split(chunk).join('');
  }
  const hits = scanProtocolTags(body);
  if (!hits.count) return hits;
  const names = Object.entries(hits.byName)
    .map(([name, n]) => `${name}×${n}`)
    .join(', ');
  throw new ApiError(
    400,
    `${where} 里仍有 XML 协议标签（${hits.count} 处：${names}），已在上送前拦截，未发送到 DeepSeek`,
    { code: 'protocol_tag_in_prompt' },
  );
}

/** 末尾可能正在成形的短标签（`<` 后直接跟标签名字符，或竖线包裹的 DSML 前缀） */
const PENDING_TAIL = /^<\/?(?:[｜|][ \t]*[a-z0-9_.:-]*|[a-z0-9_.:-]*)$/i;

/** 协议开标签（不要求闭合到 `>`，用于流式扣留判断） */
const OPEN_TAG = new RegExp(
  `<${SP}${PIPES}(?:DSML${SP}${PIPES})?(?:antml:[\\w.-]{1,32}|(?:[a-z][\\w.-]{0,15}:)?(?:dsml|tool_calls?|function_calls?|invoke|parameter))`,
  'gi',
);

/** 从开标签原文取标签名（去掉竖线、DSML 前缀与命名空间） */
function protocolNameOf(raw) {
  let name = raw.replace(/^<[ \t]*/, '').replace(/[｜|]/g, ' ').trim().toLowerCase();
  name = name.replace(/^dsml[ \t]+/, '');
  if (name.includes(':')) name = name.split(':').pop();
  return name || 'unknown';
}

/**
 * 流式输出用：找到「可能正在成形的协议标签」起点（-1 表示没有）。
 *
 * 两类情况要扣住：
 *   1. 已经出现协议开标签，但对应的闭合标签还没到（块还没成形）；
 *   2. 末尾 `</` 后面还只有标签名字符（如 `<tool_ca`）。
 *
 * `a < b`、`< 2` 这类正文比较符不会被扣住：只有 `<` 后紧跟标签名字符、
 * 或匹配已知协议标签名才成立。
 */
export function findPendingProtocolTag(text, from = 0) {
  if (!text) return -1;
  const start = Math.max(0, from);

  OPEN_TAG.lastIndex = 0;
  let match;
  while ((match = OPEN_TAG.exec(text)) !== null) {
    if (match.index < start) continue;
    const rest = text.slice(match.index);
    const gt = rest.indexOf('>');
    if (gt === -1) return match.index;
    const name = protocolNameOf(match[0]);
    const closeRe = new RegExp(`</[ \\t]*(?:[a-z][\\w.-]{0,15}:)?${name}[ \\t]*>`, 'i');
    if (!closeRe.test(rest.slice(gt + 1))) return match.index;
  }

  const lt = text.lastIndexOf('<');
  if (lt >= start && lt > text.lastIndexOf('>')) {
    const tail = text.slice(lt);
    if (tail.length <= 48 && PENDING_TAIL.test(tail)) return lt;
  }
  return -1;
}
