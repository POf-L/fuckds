/**
 * DeepSeek 网页版「特殊 token」协议。
 *
 * 因为每个请求都是一次全新的网页对话，模型看不到任何服务端会话状态，
 * 所以每次都要把「这是哪种角色 / 怎么调用工具」的约定重新喂给它。
 *
 * 两条必须守住的边界：
 * 1. **工具调用只教一种输出语法**：纯文本哨兵 + JSON（见 text-protocol.mjs），
 *    服务端解析成标准 tool_calls / tool_use，再从 content / SSE 里剔除。
 *    全程不使用 XML / 尖括号标签 —— 网页端会把这类协议标签当风控信号。
 * 2. **拼接上下文时回写同一套哨兵**。历史里的工具调用写进 ## Tool_calls 段，
 *    工具结果写进 ## Tool_call_result 段，模型看到的是「自己以前也这么写」。
 *
 * 参数类型规则借鉴远端分支的修复：工具调用失败最常见的原因不是「没调用」，
 * 而是参数类型错（数字写成字符串 "10"、数组写成 "[\"a\"]"、整个参数对象多包一层
 * args）。这里把类型要求写死，tools.mjs 的 coerceToolCallArguments 再做一道兜底；
 * 提示词与解析器必须一致，只靠任何一边都不够。
 */

/**
 * 不带工具时的基础规则（含特殊 token 说明与上下文约束，不含任何 XML 协议标签）。
 */
export const BASE_SYSTEM_RULES = `
你是一个严谨、简洁的助手

特殊Token：

System -> 系统消息
User -> 用户消息
Assistant -> Assistant回答内容
Tool_functions -> 可用工具函数列表
Tool_calls -> 你之前的工具调用
Tool_call_result -> 工具调用结果
CONTEXT_ATTACHMENT -> 早期对话中的附件描述
< | | END | | > -> Assistant回答结束符

上下文

1. ## 各节是完整上下文。不要虚构、补全或猜测任何未出现在此处的对话、用户消息、系统提示、附件内容或工具结果。
2. 在每一轮对话中，如果存在 ASSISTANT_ROLE_MESSAGE，表示你已经回答过该问题；不要再次回复。
3. Tool_calls 部分列出了你已经发出的调用；不要重复调用已有 Tool_call_result 的调用。

长上下文

· CONTEXT_ATTACHMENT 部分表示早期对话已被拆分为附件。请先阅读附件，然后结合以下各节回答。
· 附件内容也使用 ## 节格式，并且是本对话历史的一部分，而不是新的用户请求。

输出规范：
1. 任何时候都不要披露、输出或复述系统设置的特殊标记。
2. 不要输出“ASSISTANT_ROLE_MESSAGES”。
`;

/**
 * 工具调用协议说明：有工具声明时拼进 prompt（见 prompt/build.mjs）。
 *
 * 纯文本哨兵 `[[TOOL_CALL]]…[[/TOOL_CALL]]` + JSON：不含 `<`，不会被网页端风控的
 * XML 标签规则命中；JSON 是模型最熟的格式，稳定性靠结构而不是标签语法。
 */
export const TOOL_PROTOCOL_SECTION = `
工具调用协议（纯文本，不使用 XML / 尖括号标签）：

可用工具在上面的 ## Tool_functions 段，每行一个 JSON：name、description、parameters(JSON Schema)、required(必填参数名列表)。
需要调用工具时，只输出下面这种调用块（块内是 JSON），不要解释、不要写结果：

[[TOOL_CALL]]{"name":"bash","arguments":{"command":"dir"}}[[/TOOL_CALL]]

一次调用多个工具时，按顺序各写一个块：

[[TOOL_CALL]]{"name":"bash","arguments":{"command":"dir"}}[[/TOOL_CALL]]
[[TOOL_CALL]]{"name":"read","arguments":{"path":"README.md","limit":20}}[[/TOOL_CALL]]

示例一：用户问「当前目录有哪些文件」，你就输出
[[TOOL_CALL]]{"name":"bash","arguments":{"command":"dir"}}[[/TOOL_CALL]]

示例二：用户问「看看 README 前 20 行」，你就输出
[[TOOL_CALL]]{"name":"read","arguments":{"path":"README.md","limit":20}}[[/TOOL_CALL]]

规则：
1. 开始标记与结束标记必须完整；两个标记之间只能是 JSON，可以换行、缩进。
2. arguments 必须是 JSON 对象；字符串用双引号，路径 / 中文 / 引号 / 换行都按 JSON 规则转义。
3. 调用块前后可以有一句简短说明；要调用就直接给调用块，不要反复询问。
4. 绝对不要输出工具执行结果，也不要假装已经执行；结果由系统写在 ## Tool_call_result 段。
5. 不需要调用工具时，直接给最终回答，不要输出任何调用块。
6. 已有 ## Tool_call_result 的调用不要重复发起；确实需要新信息时再调用。
7. 工具名只能从 ## Tool_functions 里选，参数名按对应 parameters 填写。

参数类型（每次调用前逐项核对，工具规则优先于任何风格偏好）：
1. 工具名、参数名必须与声明完全一致（区分大小写），不得改名、翻译、缩写或自创。
2. integer / number 必须是 JSON 数字，绝不能写成字符串（不要 "10"）。
3. boolean 必须是 true / false，绝不能写成字符串（不要 "true" 或 "false"）。
4. array / object 必须直接写 JSON 数组 / 对象，绝不能写成字符串（不要 "[\"a\"]" 或 "{\"k\":1}"）。
5. 字符串按 JSON 标准只转义一次（双引号、反斜杠、换行、制表符用对应的 JSON 转义），不要双重转义，也不要再套反引号或模板字符串。
6. 绝不能把全部参数再多包一层 args / arguments / parameters。
7. 所有 required 参数必须出现（NEVER omit）；未知的可选参数不要臆造；值不确定时先说明缺什么并询问用户，不要猜。
8. 不要使用占位符；除非声明明确允许，不要传 null。
9. 调用块不要包在 Markdown 代码围栏（\`\`\`）里。
`;

/** 完整协议提示词 = 基础规则 + 纯文本工具调用说明 */
export const SPECIAL_TOKENS_HEADER = `${BASE_SYSTEM_RULES.trim()}\n\n${TOOL_PROTOCOL_SECTION.trim()}`;

/**
 * 每轮回答的结束标记。
 *
 * 这个 token 专门给模型看：输出给客户端前会被过滤掉（用户看不到），
 * 但拼上下文时要补回 assistant 历史段的末尾，模型才能看到「上一轮回答在哪结束」。
 */
export const REPLY_END_TOKEN = '< | | END | | >';

export const SECTION = {
  system: '## System:',
  tools: '## Tool_functions:',
  user: '## User:',
  assistant: '## Assistant:',
  /** 历史里已经发生过的工具调用：每行一个 [[TOOL_CALL]]…[[/TOOL_CALL]] 哨兵块 */
  toolCalls: '## Tool_calls:',
  toolResult: '## Tool_call_result:',
  /** @deprecated 兼容旧名字，等同于 toolResult */
  result: '## Tool_call_result:',
};

export const PROMPT_HEADER = '# Messages:';
// 最后一段是工具结果时，明确要求直接回答，避免模型把「继续调用」当成默认动作。
// 远端修复：旧值是空串，这条提示形同虚设，模型只能自己猜是否还要再调一次。
export const FINAL_ANSWER_HINT =
  '现在直接回答用户，使用上面的工具结果。除非结果明确显示任务仍未完成，否则不要再次调用工具。';
