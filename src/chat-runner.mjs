import { PromptTooLongError } from './errors.mjs';
import { loadImage } from './openai/images.mjs';
import {
  findToolMarkup,
  hasFabricatedProtocol,
  reconcileStreamedText,
  stripToolMarkup,
  ToolMarkupStreamFilter,
} from './openai/tool-text.mjs';
import { buildPrompt } from './prompt/build.mjs';
import { planOverflow } from './prompt/overflow.mjs';
import { coerceToolCallArguments, getToolSchemas, parseToolCalls } from './prompt/tools.mjs';

/**
 * 引擎调用的公共部分：拼 prompt → 图片/超长附件上传 → 调 web.chat → 解析工具调用。
 *
 * OpenAI 和 Anthropic 两个协议层只负责请求归一化和响应格式，执行逻辑都在这里，
 * 保证两条链路在「防自造结果」「超长转附件」上的行为完全一致。
 */
export function createChatRunner({ config, log, web }) {
  /**
   * @param {object} request 归一化后的内部请求（messages 为 OpenAI 语义）
   * @param {object} [hooks]
   * @param {AbortSignal} [hooks.signal]
   * @param {object} [hooks.meta] 透传给 web.chat 的元信息（请求 id 等）
   * @param {(prompt: string, info: object) => void} [hooks.onPrompt] prompt 拼好后、真正发送前回调
   * @param {(text: string) => void} [hooks.onContent] 流式正文增量（已过滤协议行）
   * @param {(text: string) => void} [hooks.onReasoning] 流式思考增量
   */
  return async function runChat(request, { signal, meta = {}, onPrompt, onContent, onReasoning } = {}) {
    const { maxPromptChars, maxAttachmentChars, overflowToAttachment, toolDeclMode = 'auto' } = config.runtime;

    /**
     * 拼 prompt；超过输入框上限时把较早的段落拆成附件。
     *
     * auto 模式下：完整工具声明放得下就用完整；一旦需要拆分，就改用压缩索引重建。
     * 否则上百个工具的完整声明（可能上百 KB）会把正文挤干，模型等于看不到对话。
     */
    const prepare = (systemExtra = '') => {
      const mode = toolDeclMode;
      const build = (declMode) =>
        buildPrompt({ messages: request.messages, tools: request.tools, systemExtra, toolDeclMode: declMode });

      let built = build(mode === 'compact' ? 'compact' : 'full');
      if (!overflowToAttachment) return { built, prompt: built.prompt, attachment: null };

      // 完整声明就已经放得下：直接用，不做任何压缩
      if (mode !== 'compact' && built.prompt.length <= maxPromptChars) {
        return { built, prompt: built.prompt, attachment: null };
      }

      // auto：需要拆分时改压缩索引，把正文空间腾给对话
      if (mode === 'auto') {
        built = build('compact');
        if (built.prompt.length <= maxPromptChars) {
          return { built, prompt: built.prompt, attachment: null };
        }
      }

      const plan = planOverflow(built.prompt, { maxChars: maxPromptChars, maxAttachmentChars });
      return { built, prompt: plan.prompt, attachment: plan.attachment };
    };

    const initial = prepare();
    const { toolNames, stats } = initial.built;
    const prompt = initial.prompt;

    // 图片：下载/解码 → 传成 DeepSeek 附件 → ref_file_ids
    const imageIds = [];
    if (request.images?.length) {
      const loaded = await Promise.all(request.images.map((image) => loadImage(image.url)));
      imageIds.push(...(await web.uploadImages(loaded)));
      log?.info?.('已上传图片', { count: imageIds.length });
    }

    const uploadAttachment = async (plan) => {
      if (!plan.attachment) return [];
      if (typeof web.uploadAttachments !== 'function') {
        throw new PromptTooLongError('当前引擎不支持附件上传，无法承载超长上下文');
      }
      const ids = await web.uploadAttachments([plan.attachment]);
      log?.info?.('上下文超长，较早内容已转为附件', {
        name: plan.attachment.name,
        chars: plan.attachment.chars,
        sections: plan.attachment.sections,
        // 工具声明被挪进附件时模型会丢格式约定，必须能从日志看出来
        moved: plan.attachment.moved,
      });
      return ids;
    };

    const fileIds = [...imageIds, ...(await uploadAttachment(initial))];
    onPrompt?.(prompt, { stats, attachment: initial.attachment });

    const knownTools = toolNames.length ? toolNames : null;
    const knownToolSet = knownTools ? new Set(knownTools) : null;
    // 工具声明的 schema：原来 evaluate 只知道工具名，参数类型错了也原样
    // 发给客户端。现在按声明纠正一次可还原的类型错误（见 tools.mjs）。
    const toolSchemas = getToolSchemas(request.tools);
    const finalizeToolCalls = (calls) =>
      calls.map((call) => {
        const { arguments: coerced, warnings } = coerceToolCallArguments(call, toolSchemas);
        if (warnings.length) {
          log?.warn('工具调用参数与声明不符（已纠正可还原的部分，缺失值未编造）', {
            name: call.name,
            warnings,
          });
        }
        return coerced === call.arguments ? call : { ...call, arguments: coerced };
      });

    /**
     * 把一段原始输出整理成协议无关的语义：有效工具调用 + 干净正文。
     *
     * 模型输出的工具调用走原生 DSML（唯一协议），解析层转成标准 tool_calls；
     * 其他历史格式（<tool_call> / 原生 token / 旧版 DO）只做静默兜底，不再记日志。
     */
    const evaluate = (text) => {
      const parsed = parseToolCalls(text, knownTools);
      // 不再做「重复调用抑制」：agent 里同一个调用原样重发是正常操作（每一步之后重新 observe_screen），
      // 按签名去重会把整轮输出吞成空回答。
      // 但参数要按声明纠正一次：模型常把数字/布尔/数组写成字符串，见 tools.mjs。
      const toolCalls = finalizeToolCalls(parsed);
      const content = stripToolMarkup(text);

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
        } else {
          // 原来这里调用了两次 findToolMarkup（一次判空、一次取 kind），
          // 协议扫描是全文正则，空回答分支下白跑一遍；算一次复用。
          const blocks = findToolMarkup(text);
          if (blocks.length) {
            log?.warn('模型输出了协议块，但没解析出任何工具调用（工具名不在声明里，或 DSML 结构对不上）', {
              protocolBlocks: blocks.map((block) => block.kind),
            });
          }
        }
      }

      // 未知工具名是「模型自己在乱叫」的信号：照实返回（客户端会回一条 unknown tool 让它纠正），
      // 但不能静默——以前这里连日志都没有，出事只能靠猜。
      if (toolCalls.length && knownToolSet) {
        const unknown = toolCalls.filter((call) => !knownToolSet.has(call.name));
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
      };
    };

    /** 可见正文为空时，工具调用可能只写在思考里（DeepSeek 的常见行为）：提升成正式调用 */
    const promoteFromReasoning = (reasoning, reply) => {
      if (reply.content.trim() || reply.toolCalls.length || !reasoning) return reply;
      const toolCalls = finalizeToolCalls(parseToolCalls(reasoning, knownTools));
      return toolCalls.length ? { ...reply, toolCalls } : reply;
    };

    /** 思考内容里若也伪造了协议（RESULT / 段落标题），出口前清掉 */
    const cleanReasoning = (reasoning) =>
      reasoning && hasFabricatedProtocol(reasoning) ? stripToolMarkup(reasoning) : reasoning || '';

    const run = (promptText = prompt, ids = fileIds, hooks = {}) =>
      web.chat({
        prompt: promptText,
        thinking: request.thinking,
        search: request.search,
        refFileIds: ids,
        signal,
        meta,
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

      return {
        prompt,
        stats,
        attachment: initial.attachment,
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

    const result = await web.chat({
      prompt,
      thinking: request.thinking,
      search: request.search,
      refFileIds: fileIds,
      signal,
      meta,
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

    return {
      prompt,
      stats,
      attachment: initial.attachment,
      text: authoritativeText,
      reasoning: finalReasoning,
      streamedContent: sentContent,
      elapsedMs: result.elapsedMs,
      ...reply,
    };
  };
}
