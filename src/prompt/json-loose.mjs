/**
 * 模型手写 JSON 的宽松读取工具。
 *
 * 模型输出/工具参数经常是「几乎合法」的 JSON：字符串里有裸换行、对象末尾多逗号、
 * 外面裹着代码围栏。这里只做两件事：
 *   1. 从 `{` / `[` 开始按括号配平截出一段（考虑字符串与转义）；
 *   2. JSON.parse 失败后做一次最小修复再试。
 *
 * 解析失败返回 null，调用方降级为普通文本，绝不抛错。
 */

/** 从 `{` / `[` 开始读取配平的 JSON 文本；未闭合 / 起点不对返回 null */
export function readJsonContainer(text, start) {
  if (typeof text !== 'string' || start < 0 || start >= text.length) return null;
  const open = text[start];
  if (open !== '{' && open !== '[') return null;

  const stack = [];
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{' || ch === '[') {
      stack.push(ch);
      continue;
    }
    if (ch === '}' || ch === ']') {
      const expected = ch === '}' ? '{' : '[';
      if (stack.at(-1) !== expected) return null;
      stack.pop();
      if (!stack.length) return text.slice(start, i + 1);
    }
  }
  return null; // 还没输出完，或者格式坏了
}

/** 兼容旧调用：只接受 `{` 开头的对象 */
export function readJsonObject(text, start) {
  return text?.[start] === '{' ? readJsonContainer(text, start) : null;
}

/** JSON.parse 的宽松版：修掉裸换行 / 尾随逗号再试一次 */
export function parseJsonLoose(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // 继续尝试修复
  }
  try {
    return JSON.parse(repairJsonText(raw));
  } catch {
    return null;
  }
}

/** 转义字符串里的裸控制字符，并去掉对象 / 数组末尾多余的逗号 */
export function repairJsonText(text) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        out += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        out += ch;
        inString = false;
        continue;
      }
      if (ch === '\n') {
        out += '\\n';
        continue;
      }
      if (ch === '\r') {
        out += '\\r';
        continue;
      }
      if (ch === '\t') {
        out += '\\t';
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') inString = true;
    out += ch;
  }
  return out.replace(/,\s*([}\]])/g, '$1');
}
