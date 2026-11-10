import crypto from 'node:crypto';

import { PromptTooLongError } from '../errors.mjs';

/**
 * 超长上下文 → 附件注入。
 *
 * 网页版输入框单次最多 10 万字（超了接口直接报错）。但聊天接口的 `ref_file_ids`
 * 可以挂附件，而附件不占输入框长度，所以把「较早的内容」拆成一个 .txt 传上去：
 *
 *   正文 = # Messages: + 自带协议提示词（## System:）+ 附件说明 + 最近的段落
 *   附件 = 较早的对话 / 工具声明 / 客户端 system（按原顺序）
 *
 * 拆分原则：
 * - 只切在 ## System / Tool_functions / User / Assistant / Tool_calls / Tool_call_result 段落边界上，
 *   不切碎单条消息；
 * - **自带协议提示词永远留在正文**：模型要先看到工具调用格式约定；
 * - 保留**最新的**段落（真正要回答的问题在最后），较早的进附件；
 * - 空间不够时，连工具声明和客户端 system 提示也可以移进附件（先移最靠前的）；
 * - 万一最后一段自己就超长，保留它的尾部，前面部分进附件；
 * - 正文再留一点余量（reserve），给重试时的额外约束文案用。
 */

/** 段边界：## X: 前面那个换行属于上一段的结尾，切在这里 */
const BLOCK_BOUNDARY = /\n## (System|Tool_functions|User|Assistant|Tool_calls|Tool_call_result):/g;
const DIALOG_KINDS = new Set(['User', 'Assistant', 'Tool_calls', 'Tool_call_result']);

const DEFAULT_RESERVE = 1024;
/** 正文里至少给最新对话留这么多字符，不够就把 system / 工具声明往附件挪 */
const DEFAULT_MIN_DIALOG_CHARS = 1500;
const NAME_PREFIX = 'context-';
/** 固定长度的占位文件名：先按它算预算，最后换成真实 hash 名，长度不变 */
const PLACEHOLDER = `${NAME_PREFIX}00000000.txt`;

/**
 * @param {string} prompt buildPrompt 生成的完整 prompt
 * @param {{ maxChars?: number, maxAttachmentChars?: number, reserve?: number, minDialogChars?: number }} [options]
 * @returns {{ prompt: string, attachment: null | { name: string, mime: string, buffer: Buffer, chars: number, sections: number } }}
 */
export function planOverflow(prompt, options = {}) {
  const {
    maxChars = 100_000,
    maxAttachmentChars = 2_000_000,
    reserve = DEFAULT_RESERVE,
    minDialogChars = DEFAULT_MIN_DIALOG_CHARS,
  } = options;

  if (prompt.length <= maxChars) return { prompt, attachment: null };

  const parsed = splitBlocks(prompt);
  if (!parsed) {
    throw new PromptTooLongError(
      `prompt 有 ${prompt.length} 字符，超过上限 ${maxChars}，但找不到可拆分的 ## 段落`,
    );
  }

  const { header, headBlocks, protocol, dialogs } = parsed;
  if (!dialogs.length) {
    throw new PromptTooLongError(
      `prompt 有 ${prompt.length} 字符，超过上限 ${maxChars}，且只有 system / 工具声明，没有可拆分的对话段落`,
    );
  }

  const noteLength = buildNote(PLACEHOLDER, dialogs.length).length;
  /** 已移进附件的块（保持原始顺序，先 head 后 dialog） */
  const removed = [];
  /** 已挪走的 head 块下标（Tool_functions 永远不会进来） */
  const removedHead = new Set();

  const inlineHeadChars = () =>
    header.length +
    protocol.text.length +
    headBlocks.reduce((sum, block, i) => (removedHead.has(i) ? sum : sum + block.text.length), 0);

  const budgetNow = () => maxChars - reserve - inlineHeadChars() - noteLength;

  // 自带协议提示词之前的 system：正文空间不够时按从前往后的顺序挪进附件。
  //
  // 工具声明（Tool_functions）**永远不挪**：挪进附件后模型在正文里看不到工具 schema，
  // 只能凭猜拼参数（实测会发出缺必填字段的调用），最后干脆停摆。
  // 真放不下就让它落到下面的 PromptTooLongError，提示改 TOOL_DECL_MODE=compact。
  for (let i = 0; i < headBlocks.length && budgetNow() < minDialogChars; i += 1) {
    if (headBlocks[i].kind === 'Tool_functions') continue;
    removed.push(headBlocks[i]);
    removedHead.add(i);
  }

  const budget = budgetNow();
  if (budget <= 0) {
    throw new PromptTooLongError(
      `工具声明/system 太长：正文可用空间只剩 ${budget} 字符（上限 ${maxChars}），无法保留任何对话内容。` +
        '工具声明不会再被挪进附件（否则模型看不到 schema 会乱调工具）；' +
        '请改用 TOOL_DECL_MODE=compact 压缩工具声明，或减少工具数量。',
    );
  }

  // 从后往前尽可能多地保留整段对话
  let keepFrom = dialogs.length;
  let keptChars = 0;
  for (let i = dialogs.length - 1; i >= 0; i -= 1) {
    if (keptChars + dialogs[i].text.length > budget) break;
    keptChars += dialogs[i].text.length;
    keepFrom = i;
  }
  removed.push(...dialogs.slice(0, keepFrom));

  let attachmentBody;
  let makeTail;
  let removedCount;

  /** 被挪进附件的段的类型与体量（诊断用） */
  const movedKinds = removed.map((block) => ({ kind: block.kind, chars: block.text.length }));

  if (keepFrom === dialogs.length) {
    // 最新一段自己就超预算：保留尾部，前面进附件
    const last = dialogs.at(-1);
    const headerEnd = last.text.indexOf('\n', 1);
    const sectionHeader = headerEnd === -1 ? '' : last.text.slice(0, headerEnd);
    const body = headerEnd === -1 ? last.text : last.text.slice(headerEnd);
    // 用最大的 cut 位数估 marker 长度，宁保守勿超限
    const markerMax = buildMarker(PLACEHOLDER, body.length).length;
    const keep = budget - sectionHeader.length - markerMax;
    if (keep < 200) {
      throw new PromptTooLongError(
        `最后一段有 ${last.text.length} 字符，超过正文可用空间 ${budget}，无法拆分`,
      );
    }
    let cut = Math.max(0, body.length - keep);
    const line = body.indexOf('\n', cut);
    if (line !== -1 && line - cut < 200) cut = line + 1;
    attachmentBody = `${removed.map((block) => block.text).join('')}${sectionHeader}${body.slice(0, cut)}`;
    removedCount = removed.length + 1;
    makeTail = (name) => `${sectionHeader}${buildMarker(name, cut)}${body.slice(cut)}`;
  } else {
    attachmentBody = removed.map((block) => block.text).join('');
    removedCount = removed.length;
    makeTail = () => dialogs.slice(keepFrom).map((block) => block.text).join('');
  }

  if (!attachmentBody.trim()) {
    throw new PromptTooLongError('没有可拆分到附件的内容');
  }
  if (attachmentBody.length > maxAttachmentChars) {
    throw new PromptTooLongError(
      `需要放进附件的上下文有 ${attachmentBody.length} 字符，超过上限 ${maxAttachmentChars}（可用 MAX_ATTACHMENT_CHARS 调整）`,
    );
  }

  // 附件正文不含文件名，文件名由内容 hash 决定
  const attachmentText = `${buildAttachmentTitle(removedCount)}${attachmentBody}`;
  const name = fileNameFor(attachmentText);
  const note = buildNote(name, removedCount);

  // 没被挪走的 head 块（客户端 system / 工具声明）必须拼回正文。
  // 历史 bug：这里只拼了 header + 协议提示词，于是「留在正文」的 head 块
  // 既不在正文、也不在附件，直接蒸发 —— 工具声明就此消失，模型只能凭猜拼参数。
  const inlineHeadText = headBlocks
    .filter((_, index) => !removedHead.has(index))
    .map((block) => block.text)
    .join('');

  const inline = `${header}${inlineHeadText}${protocol.text}${note}${makeTail(name)}`;

  if (inline.length > maxChars) {
    throw new PromptTooLongError(
      `拆分后正文仍有 ${inline.length} 字符，超过上限 ${maxChars}（可用 MAX_PROMPT_CHARS 调整）`,
    );
  }

  return {
    prompt: inline,
    attachment: {
      name,
      mime: 'text/plain',
      buffer: Buffer.from(attachmentText, 'utf8'),
      chars: attachmentText.length,
      sections: removedCount,
      // 诊断：到底把哪些段挪进了附件。工具声明被挪走时模型会失去工具格式约定，
      // 表现为乱调工具（参数结构错、漏必填字段），这里要能一眼看出来。
      moved: movedKinds,
    },
  };
}

/**
 * 把 prompt 切成「头部 + system/工具声明块 + 自带协议块 + 对话段」。
 * 自带协议块 = 第一个对话段之前、最后一个 ## System:（buildPrompt 固定把它放在这个位置）。
 */
function splitBlocks(prompt) {
  const starts = [];
  BLOCK_BOUNDARY.lastIndex = 0;
  let match;
  while ((match = BLOCK_BOUNDARY.exec(prompt)) !== null) {
    starts.push({ index: match.index, kind: match[1] });
  }
  if (!starts.length) return null;

  const header = prompt.slice(0, starts[0].index);
  const blocks = starts.map((item, i) => ({
    kind: item.kind,
    text: prompt.slice(item.index, i + 1 < starts.length ? starts[i + 1].index : prompt.length),
  }));

  const firstDialog = blocks.findIndex((block) => DIALOG_KINDS.has(block.kind));
  const headEnd = firstDialog === -1 ? blocks.length : firstDialog;

  let protocolIndex = -1;
  for (let i = headEnd - 1; i >= 0; i -= 1) {
    if (blocks[i].kind === 'System') {
      protocolIndex = i;
      break;
    }
  }
  if (protocolIndex === -1) return null;

  return {
    header,
    // 协议块之前的 system / 工具声明（按原顺序；空块丢掉）
    headBlocks: blocks.slice(0, protocolIndex).filter((block) => block.text.trim()),
    protocol: blocks[protocolIndex],
    dialogs: firstDialog === -1 ? [] : blocks.slice(firstDialog),
  };
}

function fileNameFor(text) {
  const hash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 8);
  return `${NAME_PREFIX}${hash}.txt`;
}

function buildNote(name, sections) {
  return [
    '',
    '## CONTEXT_ATTACHMENT:',
    `This context is long: the earlier ${sections} sections have been uploaded as attachment "${name}" (they may contain system prompts, tool declarations, or earlier conversation).`,
    'The attachment uses the same ## section format as the main text (## System: / ## User: / ## Assistant: / ## Tool_calls: / ## Tool_call_result:).',
    'Read the attachment first, treat it as the earlier history of this conversation, then continue with the sections below. Do not mention the attachment or this note to the user.',
    '',
  ].join('\n');
}

function buildMarker(name, cut) {
  return `\n(This section is long; its first ${cut} characters are in attachment ${name}, continued below)\n`;
}

function buildAttachmentTitle(sections) {
  return [
    '# Conversation history (earlier part)',
    '',
    `These are the earlier ${sections} sections of this conversation, moved to this file because they exceeded the web input length limit.`,
    'Section format matches the main text: ## System: / ## Tool_functions: / ## User: / ## Assistant: / ## Tool_calls: / ## Tool_call_result:.',
    '',
  ].join('\n');
}
