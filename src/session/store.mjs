import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { contentToText } from '../util.mjs';

/**
 * 网页会话映射：客户端对话 → 一个持久化的 DeepSeek `chat_session_id`。
 *
 * 之前每次请求都 `/chat_session/create` 新建会话、整段历史重压成一条 prompt；
 * 这里改成「同一段对话复用同一个网页会话」：后续轮次只提交本轮新增内容，
 * 用 `parent_message_id = 上一轮 assistant message id` 往下挂。
 *
 * 映射键的选择：
 * - 客户端显式给了 `conversation_id` / `metadata.conversation_id` / `session_id`
 *   （或请求头 `x-conversation-id`）→ 用它的哈希，最稳、可跨重启；
 * - 否则用「system 文本 + 第一条 user 文本」的稳定哈希。同一段对话每轮都会
 *   带同样的开头，因此键恒定；不同对话只要开头不同就不会串。
 *   取舍：如果两段对话的 system + 首条 user 完全相同，会被合并到同一网页会话
 *   （同一个开头本就是一种「同对话」语义），所以再叠加 TTL：超过 6 小时没动过的
 *   条目不再复用，重新建会话。
 *
 * 落盘在 `data/web-sessions.json`（`data/` 已在 .gitignore 内），进程重启后恢复。
 * 文件里含真实 chat_session_id，属于敏感凭据，日志/接口只输出哈希前缀。
 */

const STORE_VERSION = 1;
const DEFAULT_TTL_MS = 6 * 60 * 60_000;
const DEFAULT_MAX_ENTRIES = 100;

export function hashId(value, len = 12) {
  if (!value) return null;
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, len);
}

/** 单条消息的规范化哈希：角色 + 文本 + 工具调用名/参数 */
export function messageHash(message) {
  const role = message?.role || '';
  if (role === 'assistant') {
    const calls = (message.tool_calls || []).map((call) => ({
      name: call?.function?.name ?? call?.name ?? '',
      arguments: normalizeArguments(call?.function?.arguments ?? call?.arguments),
    }));
    return hashId(
      JSON.stringify({ role, content: contentToText(message.content, 'assistant'), calls }),
      32,
    );
  }
  if (role === 'tool' || role === 'function') {
    return hashId(
      JSON.stringify({
        role,
        name: message.name || '',
        content: contentToText(message.content, role),
      }),
      32,
    );
  }
  return hashId(JSON.stringify({ role, content: contentToText(message.content, role) }), 32);
}

function normalizeArguments(args) {
  if (typeof args === 'string') {
    try {
      return JSON.stringify(JSON.parse(args));
    } catch {
      return args;
    }
  }
  if (args && typeof args === 'object') {
    try {
      return JSON.stringify(args);
    } catch {
      return String(args);
    }
  }
  return '';
}

/**
 * 会话键。显式 id 优先；否则 system + 首条 user 的稳定哈希。
 * @returns {null | { key: string, source: 'client'|'prefix', prefixHash: string }}
 */
export function conversationKey(messages, conversationId) {
  if (conversationId) {
    const digest = hashId(conversationId, 32);
    return { key: `cid:${digest}`, source: 'client', prefixHash: digest };
  }
  const systemTexts = [];
  let firstUser = null;
  for (const message of messages || []) {
    if (message?.role === 'system' || message?.role === 'developer') {
      const text = contentToText(message.content, message.role).trim();
      if (text) systemTexts.push(text);
      continue;
    }
    if (!firstUser && message?.role === 'user') firstUser = message;
  }
  if (!firstUser) return null;
  const seed = `${systemTexts.join('\n')}\u0000${contentToText(firstUser.content, 'user').trim()}`;
  const digest = hashId(seed, 32);
  return { key: `auto:${digest}`, source: 'prefix', prefixHash: digest };
}

export class WebSessionStore {
  constructor({ dataDir, logger, file, ttlMs = DEFAULT_TTL_MS, maxEntries = DEFAULT_MAX_ENTRIES }) {
    this.log = logger;
    this.file = file || path.join(dataDir, 'web-sessions.json');
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.entries = new Map();
    this.reuseCount = 0;
    this.createCount = 0;
    this.rebuildCount = 0;
    this.last = null;
    this.#load();
  }

  #load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (parsed?.version !== STORE_VERSION || !parsed.entries || typeof parsed.entries !== 'object') return;
      for (const [key, entry] of Object.entries(parsed.entries)) {
        if (!entry || typeof entry.chatSessionId !== 'string' || !Array.isArray(entry.sentHashes)) continue;
        this.entries.set(key, entry);
      }
      if (this.entries.size) this.log?.debug?.(`已恢复 ${this.entries.size} 个网页会话映射`);
    } catch {
      /* 文件不存在或损坏：从空开始 */
    }
  }

  #save() {
    const now = Date.now();
    // 过期条目与超量条目（按最后使用时间 LRU）在落盘前收敛
    for (const [key, entry] of this.entries) {
      if (now - (entry.updatedAt || 0) > this.ttlMs) this.entries.delete(key);
    }
    if (this.entries.size > this.maxEntries) {
      const sorted = [...this.entries.entries()].sort(
        (a, b) => (a[1].updatedAt || 0) - (b[1].updatedAt || 0),
      );
      for (const [key] of sorted.slice(0, this.entries.size - this.maxEntries)) this.entries.delete(key);
    }
    const payload = { version: STORE_VERSION, entries: Object.fromEntries(this.entries) };
    const tmp = `${this.file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (err) {
      this.log?.warn?.('网页会话映射落盘失败（不影响本次回复）', { reason: err.message });
    }
  }

  /**
   * 找到这段对话已经落盘的映射（不判断能否复用）。
   *
   * 键有两种形态：无账号作用域时就是 `cid:` / `auto:`；有账号作用域时是
   * `<scope>|cid:`。账号作用域 = 账号指纹的哈希前缀，用来保证「不同账号下同名
   * 映射键不会互相串」。传入 scope 时优先返回该命名空间里的条目。
   */
  lookup(messages, { conversationId, scope = null } = {}) {
    const conv = conversationKey(messages, conversationId);
    if (!conv) return null;
    const suffix = `|${conv.key}`;
    const scopedKey = scope ? `${scope}|${conv.key}` : null;
    let unscoped = null;
    let otherScope = null;
    for (const [key, entry] of this.entries) {
      // 指定了账号作用域：先认自己命名空间里的那条
      if (scopedKey && key === scopedKey) {
        return { ...conv, convKey: conv.key, key, scope, entry };
      }
      if (key === conv.key) {
        if (!unscoped) unscoped = { ...conv, convKey: conv.key, key, scope: null, entry };
        continue;
      }
      if (key.endsWith(suffix) && !otherScope) {
        otherScope = { ...conv, convKey: conv.key, key, scope: key.slice(0, -suffix.length), entry };
      }
    }
    // 兼容旧的无作用域条目；没指定 scope 时才接受「别的账号命名空间」里的条目
    // （那一条只用于发现对话已绑定的账号）；指定了 scope 就必须严格隔离。
    return unscoped || (scope ? null : otherScope) || { ...conv, convKey: conv.key, key: null, scope: null, entry: null };
  }

  /**
   * 判断本次请求能否复用已有网页会话。
   * @param {object[]} messages 归一化后的完整客户端历史（每轮都会全量带上）
   * @param {{conversationId?: string, scope?: string}} [options]
   *   scope：账号作用域哈希前缀；提供时新会话的键会写成 `<scope>|cid:...`
   * @returns {{
   *   key: string|null, source: 'client'|'prefix'|null, prefixHash: string|null,
   *   reuse: boolean, deltaFrom: number, entry: object|null, reason: string,
   *   hashes: string[],
   * }}
   */
  plan(messages, { conversationId, scope = null } = {}) {
    const hashes = (messages || []).map(messageHash);
    const found = this.lookup(messages, { conversationId, scope });
    if (!found) {
      return { key: null, source: null, prefixHash: null, reuse: false, deltaFrom: 0, entry: null, reason: 'no-key', hashes };
    }
    const { key: foundKey, entry: foundEntry } = found;
    // 已经落盘的对话沿用它原来的命名空间；新对话才按本次选中的账号生成键
    const key = foundKey || (scope ? `${scope}|${found.convKey}` : found.convKey);
    const conv = { key, source: found.source, prefixHash: found.prefixHash, scope: found.scope };
    const entry = foundEntry;
    if (!entry) {
      return { ...conv, reuse: false, deltaFrom: 0, entry: null, reason: 'new-conversation', hashes };
    }
    if (Date.now() - (entry.updatedAt || 0) > this.ttlMs) {
      this.entries.delete(key);
      return { ...conv, reuse: false, deltaFrom: 0, entry: null, reason: 'expired', hashes };
    }
    const stored = entry.sentHashes;
    if (hashes.length < stored.length) {
      return { ...conv, reuse: false, deltaFrom: 0, entry, reason: 'history-shrank', hashes };
    }
    for (let i = 0; i < stored.length; i += 1) {
      if (hashes[i] !== stored[i]) {
        return { ...conv, reuse: false, deltaFrom: 0, entry, reason: 'history-diverged', hashes };
      }
    }

    let deltaFrom = stored.length;
    // 客户端会把我们上一轮的 assistant 回复原样带回来：它已经存在于网页会话里，
    // 不能再发一遍（会重复），直接跳过。工具结果 / 新 user 消息照常作为增量发送。
    if (deltaFrom < messages.length && messages[deltaFrom]?.role === 'assistant') {
      deltaFrom += 1;
    }
    if (deltaFrom >= messages.length) {
      const last = messages.at(-1);
      // 客户端重试同一条请求：把最后一条 user/tool 再发一次，仍在同一会话里
      if (last?.role === 'user' || last?.role === 'tool' || last?.role === 'function') {
        deltaFrom = messages.length - 1;
      } else {
        return { ...conv, reuse: false, deltaFrom: 0, entry, reason: 'no-new-message', hashes };
      }
    }
    return { ...conv, reuse: true, deltaFrom, entry, reason: 'append', hashes };
  }

  /**
   * 一轮成功之后落盘：记录这轮客户端历史、网页会话、parent 链与账号归属。
   * @param {string} key
   * @param {object} data
   */
  commit(key, data) {
    if (!key || !data?.chatSessionId) return;
    const entry = {
      chatSessionId: data.chatSessionId,
      lastMessageId: data.lastMessageId || null,
      accountFingerprint: data.accountFingerprint || null,
      sentHashes: data.sentHashes || [],
      turns: (this.entries.get(key)?.turns || 0) + 1,
      updatedAt: Date.now(),
      createdAt: this.entries.get(key)?.createdAt || Date.now(),
    };
    this.entries.set(key, entry);
    if (data.reused) this.reuseCount += 1;
    if (data.created) this.createCount += 1;
    if (data.rebuilt) this.rebuildCount += 1;
    this.last = {
      keyHash: hashId(key),
      webSessionHash: hashId(entry.chatSessionId),
      parentHash: hashId(entry.lastMessageId),
      accountHash: hashId(entry.accountFingerprint),
      reused: Boolean(data.reused),
      created: Boolean(data.created),
      rebuilt: Boolean(data.rebuilt),
      reason: data.reason || null,
      promptChars: data.promptChars ?? null,
      messages: entry.sentHashes.length,
      turns: entry.turns,
      at: entry.updatedAt,
    };
    this.#save();
  }

  /** 上游返回了会话失效并已重建：只更新 parent 链，不清 sentHashes（本轮已按全量发送） */
  drop(key) {
    if (key) this.entries.delete(key);
  }

  get(key) {
    return key ? this.entries.get(key) || null : null;
  }

  status() {
    return {
      enabled: true,
      conversations: this.entries.size,
      reuseCount: this.reuseCount,
      createCount: this.createCount,
      rebuildCount: this.rebuildCount,
      last: this.last,
      file: 'data/web-sessions.json',
    };
  }
}
