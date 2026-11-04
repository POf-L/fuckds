import { PromptTooLongError } from './errors.mjs';
import { loadImage } from './openai/images.mjs';
import {
  findToolMarkup,
  hasFabricatedProtocol,
  reconcileStreamedText,
  stripToolMarkup,
  ToolMarkupStreamFilter,
} from './openai/tool-text.mjs';
import { buildDeltaPrompt, buildPrompt, collectToolNamesById } from './prompt/build.mjs';
import { planOverflow } from './prompt/overflow.mjs';
import { assertNoProtocolTags } from './prompt/sanitize.mjs';
import { parseTextToolCalls, scanTextToolCallBlocks } from './prompt/text-protocol.mjs';
import { parseToolCalls } from './prompt/tools.mjs';
import { conversationKey, hashId } from './session/store.mjs';

/**
 * 引擎调用的公共部分：拼 prompt → 图片/超长附件上传 → 调 web.chat → 解析工具调用。
 *
 * OpenAI 和 Anthropic 两个协议层只负责请求归一化和响应格式，执行逻辑都在这里，
 * 保证两条链路在「防自造结果」「超长转附件」上的行为完全一致。
 */
export function createChatRunner({ config, log, web, sessions = null }) {
  /*
   * 同一会话键串行，不同会话键并行。
   *
   * 为什么必须在锁内重新 plan：两个并发请求如果都在锁外 plan，会读到同一个
   * lastMessageId，于是两条都带同样的 parent_message_id 提交，网页会话分叉，
   * 之后的历史校验永远对不上。锁覆盖「plan → 上传 → web.chat → commit」整段，
   * 第二条请求进来时看到的一定是第一条提交后的链。
   */
  const lockSlots = new Map();

  async function withSessionLock(key, fn) {
    let slot = lockSlots.get(key);
    if (!slot) {
      slot = { tail: Promise.resolve(), waiting: 0 };
      lockSlots.set(key, slot);
    }
    const waitFor = slot.tail;
    slot.waiting += 1;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    slot.tail = waitFor.then(() => gate, () => gate);
    if (slot.waiting > 1) {
      log?.info?.('同一会话已有请求在跑，本次排队等待', { keyHash: hashId(key), waiting: slot.waiting });
    }
    await waitFor.catch(() => {});
    try {
      return await fn();
    } finally {
      slot.waiting -= 1;
      release();
      if (slot.waiting === 0) lockSlots.delete(key);
    }
  }

  /** 会话键：能算出来就串行化；没有会话复用 / 算不出键时保持原有并发 */
  const sessionLockKey = (request) => {
    if (config.runtime.sessionReuse === false || !sessions) return null;
    return conversationKey(request.messages, request.conversationId)?.key || null;
  };

  return async function runChat(request, hooks = {}) {
    const key = sessionLockKey(request);
    if (!key) return runChatCore(request, hooks);
    return withSessionLock(key, () => runChatCore(request, hooks));
  };

  /**
   * @param {object} request 归一化后的内部请求（messages 为 OpenAI 语义）
   * @param {object} [hooks]
   * @param {AbortSignal} [hooks.signal]
   * @param {object} [hooks.meta] 透传给 web.chat 的元信息（请求 id 等）
   * @param {(prompt: string, info: object) => void} [hooks.onPrompt] prompt 拼好后、真正发送前回调
   * @param {(text: string) => void} [hooks.onContent] 流式正文增量（已过滤协议行）
   * @param {(text: string) => void} [hooks.onReasoning] 流式思考增量
   */
  async function runChatCore(request, { signal, meta = {}, onPrompt, onContent, onReasoning } = {}) {
    const { maxPromptChars, maxAttachmentChars, overflowToAttachment } = config.runtime;

    /**
     * 上送前风控自检：拼好的 prompt（含附件正文）里只要还有 XML 协议标签，就拒绝发送。
     * 宁可报错也不静默带出去 —— 静默带出去等于把风控信号交给对方，且无任何证据留痕。
     */
    const guard = (plan, protocolText) => {
      if (config.sanitize?.rejectOnHit === false) return;
      // 服务端自带的协议说明是有意保留的（只在显式保留客户端 tools 时出现），不算污染
      assertNoProtocolTags(plan.prompt, 'prompt', { allow: [protocolText] });
      if (plan.attachment) assertNoProtocolTags(plan.attachment.buffer.toString('utf8'), '附件');
    };

    /** 拼全量 prompt；超过输入框上限时把较早的段落拆成附件 */
    const buildFull = () => {
      const built = buildPrompt({ messages: request.messages, tools: request.tools });
      const plan = overflowToAttachment
        ? planOverflow(built.prompt, { maxChars: maxPromptChars, maxAttachmentChars })
        : { prompt: built.prompt, attachment: null };
      guard(plan, built.protocolText);
      return { built, plan };
    };

    const full = buildFull();
    const toolNames = full.built.toolNames;

    /*
     * 会话复用：同一段对话只建一次网页会话，后续只发本轮新增内容。
     * hybrid（全浏览器降级）按页面 UI 驱动，没有会话映射，直接走全量。
     */
    const sessionAllowed = config.runtime.sessionReuse !== false && Boolean(sessions);
    const layer = typeof web.status === 'function' ? web.status()?.layer : null;
    let plan = full.plan;
    let built = full.built;
    let sessionPlan = { key: null, reason: 'disabled', hashes: [], entry: null };
    let sessionArgs = null;
    let sessionMode = 'new';
    /** 本次请求应该在哪个账号上跑（新对话由引擎按负载选，然后钉住） */
    let accountHint = null;

    if (sessionAllowed && layer !== 'hybrid') {
      /*
       * 网页会话按账号命名空间隔离：不同账号下同名映射键不能互相串。
       * 已有条目沿用它自己的作用域（账号粘性）；新对话先问引擎「这次会落到哪个账号」，
       * 再用该账号的哈希前缀作为作用域建键。planAccount 只读，不发请求。
       */
      const existing = sessions.lookup(request.messages, { conversationId: request.conversationId });
      let scope = existing?.scope || null;
      if (scope) {
        accountHint = existing?.entry?.accountFingerprint || null;
      } else {
        const planned = typeof web.planAccount === 'function'
          ? web.planAccount(existing?.entry?.accountFingerprint || null)
          : null;
        accountHint = planned?.fingerprint || null;
        scope = accountHint ? hashId(accountHint) : null;
      }
      sessionPlan = sessions.plan(request.messages, { conversationId: request.conversationId, scope });
      if (sessionPlan.reuse) {
        const delta = buildDeltaPrompt({
          messages: request.messages,
          from: sessionPlan.deltaFrom,
          toolNameById: collectToolNamesById(request.messages),
        });
        // 增量本身也可能是「一整条超大消息」，没有 ## 段落可拆，planOverflow 会抛 413。
        // 这种情况应该退回全量新会话（全量 prompt 带段落标题，通常反而拆得动），而不是直接失败。
        let deltaPlan = null;
        try {
          deltaPlan = overflowToAttachment
            ? planOverflow(delta.prompt, { maxChars: maxPromptChars, maxAttachmentChars })
            : { prompt: delta.prompt, attachment: null };
        } catch (err) {
          if (!(err instanceof PromptTooLongError)) throw err;
          sessionPlan.reason = 'delta-too-long';
        }
        if (deltaPlan && deltaPlan.prompt.length <= maxPromptChars) {
          guard(deltaPlan, '');
          plan = deltaPlan;
          built = { ...full.built, prompt: deltaPlan.prompt, stats: delta.stats };
          sessionArgs = {
            chatSessionId: sessionPlan.entry.chatSessionId,
            parentMessageId: sessionPlan.entry.lastMessageId,
            accountFingerprint: sessionPlan.entry.accountFingerprint,
            reuse: true,
          };
          sessionMode = 'reuse';
        } else {
          // 增量本身也超长：放弃复用，退回全量新会话（多一次 create，日志留原因）
          sessionPlan.reason = 'delta-too-long';
        }
      }
    }

    const prompt = plan.prompt;
    const stats = built.stats;

    // 图片：下载/解码 → 传成 DeepSeek 附件 → ref_file_ids
    const imageIds = [];
    if (request.images?.length) {
      const loaded = await Promise.all(request.images.map((image) => loadImage(image.url)));
      imageIds.push(...(await web.uploadImages(loaded)));
      log?.info?.('已上传图片', { count: imageIds.length });
    }

    const uploadAttachment = async (attachmentPlan) => {
      if (!attachmentPlan.attachment) return [];
      if (typeof web.uploadAttachments !== 'function') {
        throw new PromptTooLongError('当前引擎不支持附件上传，无法承载超长上下文');
      }
      const ids = await web.uploadAttachments([attachmentPlan.attachment]);
      log?.info?.('上下文超长，较早内容已转为附件', {
        name: attachmentPlan.attachment.name,
        chars: attachmentPlan.attachment.chars,
        sections: attachmentPlan.attachment.sections,
      });
      return ids;
    };

    const fileIds = [...imageIds, ...(await uploadAttachment(plan))];

    /** 会话失效时引擎回调这里拿「全量 prompt + 附件」（真正需要重建时才上传） */
    const rebuildSession = async () => ({
      prompt: full.plan.prompt,
      refFileIds: [...imageIds, ...(await uploadAttachment(full.plan))],
    });

    onPrompt?.(prompt, {
      stats,
      attachment: plan.attachment,
      sanitize: request.sanitize,
      session: sessionPlan.key
        ? {
            mode: sessionMode,
            reason: sessionPlan.reason,
            keyHash: hashId(sessionPlan.key),
            webSessionHash:
              sessionMode === 'reuse' && sessionPlan.entry ? hashId(sessionPlan.entry.chatSessionId) : null,
            parentHash: sessionMode === 'reuse' && sessionPlan.entry ? hashId(sessionPlan.entry.lastMessageId) : null,
            deltaFrom: sessionPlan.reuse ? sessionPlan.deltaFrom : null,
          }
        : null,
    });

    /** 一轮成功后把会话链落盘（进程重启后还能续上同一网页会话） */
    const commitSession = (result) => {
      if (!sessions || !sessionPlan.key) return;
      if (!result?.chatSessionId) {
        // 引擎没有返回会话（例如 hybrid 降级）：这条映射不再可用
        sessions.drop(sessionPlan.key);
        return;
      }
      sessions.commit(sessionPlan.key, {
        chatSessionId: result.chatSessionId,
        lastMessageId: result.messageId,
        accountFingerprint: result.accountFingerprint,
        sentHashes: sessionPlan.hashes,
        reused: Boolean(result.sessionReused),
        created: Boolean(result.sessionCreated),
        rebuilt: Boolean(result.sessionRebuilt),
        reason: result.sessionRebuildReason || sessionPlan.reason,
        promptChars: prompt.length,
      });
      log?.info?.('网页会话', {
        id: meta.id,
        mode: result.sessionRebuilt ? 'rebuild' : result.sessionReused ? 'reuse' : 'new',
        webSession: hashId(result.chatSessionId),
        parent: hashId(result.messageId),
        promptChars: prompt.length,
        deltaFrom: sessionPlan.reuse ? sessionPlan.deltaFrom : null,
        reason: result.sessionRebuildReason || sessionPlan.reason,
      });
    };

    /** 计数用：会话失效重建时实际发出去的是全量 prompt（不是增量） */
    const effectivePrompt = (result) => (result?.sessionRebuilt ? full.plan.prompt : prompt);

    /** 给日志/接口的会话摘要：只有哈希前缀，没有原始 id */
    const sessionInfo = (result) =>
      result?.chatSessionId
        ? {
            reused: Boolean(result.sessionReused),
            created: Boolean(result.sessionCreated),
            rebuilt: Boolean(result.sessionRebuilt),
            keyHash: sessionPlan.key ? hashId(sessionPlan.key) : null,
            webSessionHash: hashId(result.chatSessionId),
            parentHash: hashId(result.messageId),
            reason: result.sessionRebuildReason || sessionPlan.reason,
            deltaFrom: sessionPlan.reuse ? sessionPlan.deltaFrom : null,
          }
        : null;

    const knownTools = toolNames.length ? toolNames : null;

    /**
     * 把一段原始输出整理成协议无关的语义：有效工具调用 + 干净正文。
     *
     * 模型输出的工具调用走纯文本哨兵协议（唯一对外协议），解析层转成标准 tool_calls；
     * DSML / <tool_call> / 原生 token / 旧版 DO 只做静默兜底。
     */
    const evaluate = (text) => {
      const parsed = parseToolCalls(text, knownTools);
      // 不再做「重复调用抑制」：agent 里同一个调用原样重发是正常操作（每一步之后重新 observe_screen），
      // 按签名去重会把整轮输出吞成空回答。
      const toolCalls = parsed;
      const content = stripToolMarkup(text);

      // 纯文本协议的成功率：只在模型真的写了哨兵块时统计。
      // blocks = 完整调用块数，parsed = 能从块里解出的调用数；解析不出来就降级成普通文本（不抛错）。
      const callBlocks = scanTextToolCallBlocks(text).filter((block) => block.complete);
      const textCalls = parseTextToolCalls(text);
      const protocol = {
        blocks: callBlocks.length,
        parsed: textCalls.length,
        failed: callBlocks.length > 0 && textCalls.length === 0 ? 1 : 0,
      };
      if (protocol.failed) {
        log?.warn('纯文本工具调用块解析失败，已降级为普通文本', {
          blocks: protocol.blocks,
          sample: text.slice(callBlocks[0].start, callBlocks[0].end).slice(0, 300),
        });
      }

      // 诊断（只记日志，不改行为）：这一轮既没有正文、也没有工具调用时，客户端收到的是一条
      // 空 assistant 消息，agent 那边会直接判「模型未返回正文或工具调用」把整轮 loop 判失败。
      // 两种成因（协议块解析不出 / 工具名不在声明里）以前全是静默的，
      // 线上只能看到「莫名其妙断了」，所以这里必须把原文与丢弃原因留下来。
      if (!content.trim() && !toolCalls.length) {
        log?.warn('这一轮没有解析出正文或工具调用，客户端将收到空回答', {
          chars: text.length,
          parsedCalls: parsed.length,
          knownTools: knownTools?.length ?? 0,
          sample: text.slice(0, 400),
        });
        if (parsed.length) {
          log?.warn('解析出了工具调用但没交给客户端（不该发生，检查 evaluate 的过滤逻辑）', {
            names: parsed.map((call) => call.name),
          });
        } else if (findToolMarkup(text).length) {
          log?.warn('模型输出了协议块，但没解析出任何工具调用（工具名不在声明里，或 DSML 结构对不上）', {
            protocolBlocks: findToolMarkup(text).map((block) => block.kind),
          });
        }
      }

      // 未知工具名是「模型自己在乱叫」的信号：照实返回（客户端会回一条 unknown tool 让它纠正），
      // 但不能静默——以前这里连日志都没有，出事只能靠猜。
      if (toolCalls.length && knownTools) {
        const unknown = toolCalls.filter((call) => !knownTools.includes(call.name));
        if (unknown.length) {
          log?.warn('模型调用了未声明的工具，已照实返回给客户端', {
            names: unknown.map((call) => call.name),
            declared: knownTools.length,
          });
        }
      }

      return {
        toolCalls,
        content,
        // RESULT / 伪造的 ## 段落标题都算「编造协议」
        fabricated: hasFabricatedProtocol(text),
        // 纯文本协议解析统计（blocks=完整调用块，parsed=解出的调用，failed=整体失败）
        protocol,
      };
    };

    /** 可见正文为空时，工具调用可能只写在思考里（DeepSeek 的常见行为）：提升成正式调用 */
    const promoteFromReasoning = (reasoning, reply) => {
      if (reply.content.trim() || reply.toolCalls.length || !reasoning) return reply;
      const toolCalls = parseToolCalls(reasoning, knownTools);
      return toolCalls.length ? { ...reply, toolCalls } : reply;
    };

    /** 思考内容里若也伪造了协议（RESULT / 段落标题），出口前清掉 */
    const cleanReasoning = (reasoning) =>
      reasoning && hasFabricatedProtocol(reasoning) ? stripToolMarkup(reasoning) : reasoning || '';

    /**
     * 复用会话时把 chatSessionId / parentMessageId 交给引擎，并挂上「失效时重建」的回调；
     * 非复用路径传 null，由引擎建一次新会话（一次对话全程 create 次数 = 1）。
     */
    const run = (promptText = prompt, ids = fileIds, hooks = {}) =>
      web.chat({
        prompt: promptText,
        thinking: request.thinking,
        search: request.search,
        refFileIds: ids,
        signal,
        meta,
        session: sessionArgs
          ? { ...sessionArgs, rebuild: rebuildSession }
          : accountHint
            ? { accountFingerprint: accountHint }
            : null,
        onDelta: hooks.onDelta,
        onThinking: hooks.onThinking,
      });

    if (!request.stream) {
      // 不检测、不中断、不截断：模型写多少就收多少，出口只做协议清洗（RESULT 行从正文里剔掉）
      let result = await run(prompt, fileIds);
      let reply = promoteFromReasoning(result.reasoning, evaluate(result.text));

      if (reply.fabricated) {
        log?.warn?.('模型输出了自造的工具结果（RESULT），已从正文里剔除', {
          toolCalls: reply.toolCalls.length,
        });
      }
      commitSession(result);

      return {
        prompt: effectivePrompt(result),
        stats,
        attachment: plan.attachment,
        sanitize: request.sanitize,
        session: sessionInfo(result),
        text: result.text,
        reasoning: cleanReasoning(result.reasoning),
        elapsedMs: result.elapsedMs,
        ...reply,
      };
    }

    // 流式：协议行挡在 SSE 之外，收尾由这里统一核对/补发
    const filter = new ToolMarkupStreamFilter();
    let sentContent = '';
    let sentReasoning = '';
    const emitContent = (text) => {
      if (!text) return;
      sentContent += text;
      onContent?.(text);
    };
    const emitReasoning = (text) => {
      if (!text) return;
      sentReasoning += text;
      onReasoning?.(text);
    };

    const result = await run(prompt, fileIds, {
      onDelta: (text) => {
        const safe = filter.push(text);
        if (safe) emitContent(safe);
      },
      onThinking: (text) => emitReasoning(text),
    });
    const authoritativeText = result.text;

    const reply = promoteFromReasoning(result.reasoning, evaluate(authoritativeText));
    if (reply.fabricated) {
      log?.warn?.('模型输出了自造的工具结果（RESULT），已从流式 content 中剔除', {
        toolCalls: reply.toolCalls.length,
      });
    }

    // 把被协议行挡住的剩余正文补发出去（有 toolCalls 时也要发：DO 块之后的自然语言不能丢）
    const rest = filter.flushRest();
    if (rest) emitContent(rest);

    // 收尾核对：SSE 一旦发出去就不能撤回，只能补发尾巴。
    // 浏览器 DOM 的 markdown 序列化与模型原始文本经常不是前缀关系（空行/列表符/收尾符），
    // driver 的流式增量可能停在半路；这里用权威 result.text 清洗后的内容兜底补一次。
    const contentGap = reconcileStreamedText(sentContent, reply.content);
    if (contentGap.delta) {
      log?.debug?.('流式正文比权威文本短，补发尾部', {
        sentChars: sentContent.length,
        finalChars: reply.content.length,
        tailChars: contentGap.delta.length,
      });
      emitContent(contentGap.delta);
    }
    if (!contentGap.complete) {
      log?.warn?.('流式正文与权威文本分叉且无法安全补齐，客户端可能缺一段内容', {
        sentChars: sentContent.length,
        finalChars: reply.content.length,
        toolCalls: reply.toolCalls.length,
      });
    }

    // 思考内容同理补尾（DOM 折叠思考块时流式可能只拿到前半段）
    const finalReasoning = cleanReasoning(result.reasoning);
    const reasoningGap = reconcileStreamedText(sentReasoning, finalReasoning);
    if (reasoningGap.delta) emitReasoning(reasoningGap.delta);
    if (!reasoningGap.complete) {
      log?.warn?.('流式思考与权威思考分叉且无法安全补齐', {
        sentChars: sentReasoning.length,
        finalChars: finalReasoning.length,
      });
    }

    commitSession(result);

    return {
      prompt: effectivePrompt(result),
      stats,
      attachment: plan.attachment,
      sanitize: request.sanitize,
      session: sessionInfo(result),
      text: authoritativeText,
      reasoning: finalReasoning,
      streamedContent: sentContent,
      elapsedMs: result.elapsedMs,
      ...reply,
    };
  }
}
