/**
 * DeepSeek 网页版补全接口的流式协议解析。
 *
 * 服务端每帧是一个 JSON「补丁」：
 *   {"v": {"response": {...}}}                       // 初始快照（含 fragments）
 *   {"p":"response/fragments","o":"APPEND","v":[..]}  // 新增片段（THINK / RESPONSE）
 *   {"p":"response/fragments/-1/content","v":"是"}    // 追加到最后一段（o 缺省 = APPEND）
 *   {"v":"声"}                                        // 同上，省略路径
 *   {"p":"response/status","o":"SET","v":"FINISHED"}  // 结束
 */

export function createStreamState() {
  return {
    fragments: [],
    status: null,
    usage: null,
    messageId: null,
  };
}

function lastFragment(state) {
  return state.fragments[state.fragments.length - 1];
}

function appendToLast(state, text) {
  if (!text) return;
  const fragment = lastFragment(state);
  if (!fragment) return;
  fragment.content = (fragment.content || '') + text;
}

export function applyPatch(state, patch) {
  if (!patch || typeof patch !== 'object') return;

  // 不带路径：要么是新快照，要么是给最后一段追加文本
  if (patch.p === undefined) {
    if (typeof patch.v === 'string') {
      appendToLast(state, patch.v);
      return;
    }
    if (patch.v && typeof patch.v === 'object') {
      const response = patch.v.response;
      if (response) {
        state.messageId = response.message_id ?? state.messageId;
        if (Array.isArray(response.fragments)) state.fragments = response.fragments;
        if (response.status) state.status = response.status;
      }
      return;
    }
    return;
  }

  const path = String(patch.p);
  const op = patch.o || 'APPEND';

  if (op === 'BATCH') {
    // BATCH 里的子补丁路径是相对于 batch 路径的，比如 response + accumulated_token_usage
    const base = path.endsWith('/') ? path : `${path}/`;
    for (const sub of patch.v || []) {
      applyPatch(state, sub && sub.p ? { ...sub, p: base + sub.p } : sub);
    }
    return;
  }

  if (path === 'response/fragments' && op === 'APPEND') {
    if (Array.isArray(patch.v)) state.fragments.push(...patch.v);
    return;
  }

  if (path === 'response/fragments/-1/content') {
    appendToLast(state, typeof patch.v === 'string' ? patch.v : '');
    return;
  }

  if (path === 'response/status') {
    state.status = patch.v;
    return;
  }

  if (path === 'response/accumulated_token_usage') {
    state.usage = patch.v;
    return;
  }

  // 其它路径（elapsed_secs、references…）对输出没影响，忽略
}

/** 按片段类型汇总文本 */
export function collectText(state, type) {
  return state.fragments
    .filter((f) => f && f.type === type)
    .map((f) => f.content || '')
    .join('');
}

export const contentOf = (state) => collectText(state, 'RESPONSE');
export const reasoningOf = (state) => collectText(state, 'THINK');

/**
 * 增量文本追踪器：direct/client.mjs 原来每个上游补丁都要把全部
 * fragments filter + map + join 一遍，再和已发文本做 startsWith。
 * 输出越长，每帧成本越高（O(总长度)），长回答后期每个 token 都要
 * 复制、拼接一遍全文，GC 和延迟一起涨。
 *
 * 追踪器只返回“相对上次的新增量”，不拼全文：
 * - 追加是常态：只有最后一段在变（对象引用相同，内容是旧内容的前缀），
 *   或新增了一段 —— 这两种情况只 join 新增的那一小段；
 * - 快照替换了整个 fragments 数组时，逐段比对字符串（快照极少出现，
 *   且字符串比较不分配新全文）；
 * - 中间某段被改短/改写（不再是追加语义）时返回 null，调用方回退到
 *   全文 join + startsWith 的旧逻辑，正确性不受影响。
 *
 * @returns {(fragments: object[], type: string) => string | null}
 *   新增量；null 表示无法增量，调用方应回退全文计算。
 */
export function createTextTracker() {
  let parts = []; // 上次见到的该类型片段对象（按顺序）
  let contents = []; // 与 parts 对应的内容字符串

  return (fragments, type) => {
    const next = [];
    for (const f of fragments) {
      if (f && f.type === type) next.push(f);
    }
    if (next.length < parts.length) return null;

    let delta = '';
    let changed = false;
    for (let i = 0; i < parts.length; i += 1) {
      const oldContent = contents[i];
      const frag = next[i];
      const newContent = frag.content || '';
      if (newContent === oldContent) continue;
      if (newContent.length < oldContent.length) return null; // 回退：无法增量
      if (frag === parts[i] && i === parts.length - 1) {
        // 常态：同一对象、最后一段，applyPatch 只做追加（content = 旧 + 新），
        // 所以旧内容一定是新内容的前缀，不必再花 O(旧长度) 做 startsWith
        // 比较 —— 这一步正是原来全文 join / startsWith 的二次开销来源。
        delta += newContent.slice(oldContent.length);
        changed = true;
        continue;
      }
      // 对象换了（快照替换）或非最后一段长了：验证一次前缀，快照极少出现。
      if (newContent.startsWith(oldContent)) {
        delta += newContent.slice(oldContent.length);
        changed = true;
        continue;
      }
      return null; // 中间改写：无法增量
    }
    for (let i = parts.length; i < next.length; i += 1) {
      delta += next[i].content || '';
      changed = true;
    }
    // 即使 delta 为空也要更新快照，否则下次会误判
    parts = next.slice();
    contents = next.map((f) => f.content || '');
    return changed ? delta : '';
  };
}

/** 把 SSE 文本流切成一个个 data JSON，逐帧回调 */
export function createSseParser(onData, onEvent) {
  let buffer = '';
  let offset = 0;

  return {
    push(chunk) {
      buffer += chunk;
      let index;
      // 原实现每解析一帧就 buffer.slice() 一次，把剩余部分整体复制：
      // 一个 chunk 里有 N 帧时是 O(N * 剩余长度) 的二次开销。
      // 改成只移动 offset，每次 push 结束时才压缩一次。
      while ((index = buffer.indexOf('\n\n', offset)) >= 0) {
        const raw = buffer.slice(offset, index);
        offset = index + 2;
        this.handleFrame(raw);
      }
      if (offset > 0) {
        buffer = buffer.slice(offset);
        offset = 0;
      }
    },
    handleFrame(raw) {
      if (!raw.trim()) return;
      let event = null;
      const dataLines = [];
      for (const line of raw.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7).trim();
        else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
        else if (line.startsWith('data:')) dataLines.push(line.slice(5));
      }
      if (event && onEvent) onEvent(event);
      if (!dataLines.length) return;
      const payload = dataLines.join('\n').trim();
      if (!payload) return;
      try {
        onData(JSON.parse(payload), event);
      } catch {
        // 非 JSON（keep-alive 之类）忽略
      }
    },
    flush() {
      const rest = buffer.slice(offset);
      if (rest.trim()) {
        this.handleFrame(rest);
      }
      buffer = '';
      offset = 0;
    },
  };
}
