/**
 * DeepSeek 网页版「特殊 token」协议。
 *
 * 因为每个请求都是一次全新的网页对话，模型看不到任何服务端会话状态，
 * 所以每次都要把「这是哪种角色 / 怎么调用工具」的约定重新喂给它。
 *
 * 两条必须守住的边界：
 * 1. **工具调用只教一种输出语法**：原生 DSML（模型自己吐 XML 风格的调用），
 *    服务端解析成标准 tool_calls / tool_use，再从 content / SSE 里剔除。
 * 2. **拼接上下文时绝不写回 DSML**。历史里的工具调用统一渲染成 ## Tool_calls 段的 JSON 行，
 *    工具结果单独放在 ## Tool_call_result 段，模型没有可模仿的「自己写工具语法 / 自己写结果」样板。
 */

/**
 * 不带工具时的基础规则（含特殊 token 说明与上下文约束，不含任何 XML 协议标签）。
 *
 * 默认配置会丢弃客户端 tools，agent / 工具调用不可用，所以也不再教 DSML：
 * 教一遍模型也产不出 tool_calls，反而把 XML 标签写进 prompt（网页端风控会盯这类标记）。
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
 * 工具调用协议说明：只有「显式保留客户端 tools」时才会拼进 prompt（见 prompt/build.mjs）。
 * 默认配置丢弃 tools，网页端本来就产不出 tool_calls，这段只会把 XML 协议标签写进 prompt，
 * 既是无效上下文，又会放大风控面。
 */
export const DSML_PROTOCOL_SECTION = `
工具调用：
你需要使用一种标记语言来进行工具调用，同时它也是你的原生工具调用语言：
DeepSeek Markup Language(DSML):

DSML 使用规范

一、基本结构

每次工具调用写成如下形式：

<｜DSML｜ calls>
<｜DSML｜ invoke name="工具名">
<｜DSML｜ parameter name="参数名" string="true">字符串值</｜DSML｜ parameter>
<｜DSML｜ parameter name="参数名" string="false">JSON值</｜DSML｜ parameter>
</｜DSML｜ invoke>
</｜DSML｜ calls>

外层 <｜DSML｜ calls> 包住一次或多次 <｜DSML｜ invoke>，每次 invoke 用 name 属性写工具名，内部放该工具的所有参数。

二、标签写法

标签名前面必须带一个空格，即写 <｜DSML｜ calls>、<｜DSML｜ invoke>、<｜DSML｜ parameter>，闭合标签写 </｜DSML｜ parameter>、</｜DSML｜ invoke>、</｜DSML｜ calls>。这个空格不能省。

三、参数怎么写

字符串参数：string="true"，值直接写，不加引号不转义。例如 <｜DSML｜ parameter name="city" string="true">Paris</｜DSML｜ parameter>。

数字、布尔、数组、对象参数：string="false"，值按 JSON 写。例如 <｜DSML｜ parameter name="count" string="false">5</｜DSML｜ parameter>、<｜DSML｜ parameter name="flag" string="false">true</｜DSML｜ parameter>、<｜DSML｜ parameter name="tags" string="false">["a","b"]</｜DSML｜ parameter>、<｜DSML｜ parameter name="opts" string="false">{"k":"v"}</｜DSML｜ parameter>。

string 属性可以省略，但写全更稳。

四、多次调用

同一个 <｜DSML｜ calls> 里可以并排放多个 <｜DSML｜ invoke>，每个 invoke 调一个工具：

<｜DSML｜ calls>
<｜DSML｜ invoke name="get_weather">
<｜DSML｜ parameter name="city" string="true">Paris</｜DSML｜ parameter>
</｜DSML｜ invoke>
<｜DSML｜ invoke name="get_weather">
<｜DSML｜ parameter name="city" string="true">London</｜DSML｜ parameter>
</｜DSML｜ invoke>
</｜DSML｜ calls>

五、工具声明

工具定义（名称、参数、类型）放在 system 消息里，用 JSON 写清楚，不要用单独的 tools 字段，也不要造 tool_calls 外层。

六、工具结果

工具返回结果写成Tool_call_result块(JSON格式，每行一个)

约束：
1. 禁止编造、猜测、补全或模拟任何工具执行过程或结果。
2. 禁止输出 Tool_call_result。
3. 禁止假装你已经执行了工具。
4.禁止预测、猜测工具名/工具参数
5.在调用工具时注意参数嵌套，避免调用出错
`;

/** 完整协议提示词 = 基础规则 + DSML 工具调用说明（仅显式保留客户端 tools 时使用） */
export const SPECIAL_TOKENS_HEADER = `${BASE_SYSTEM_RULES.trim()}\n\n${DSML_PROTOCOL_SECTION.trim()}`;

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
  /** 历史里已经发生过的工具调用：每行一个 {"name":...,"args":...}，绝不写 DSML */
  toolCalls: '## Tool_calls:',
  toolResult: '## Tool_call_result:',
  /** @deprecated 兼容旧名字，等同于 toolResult */
  result: '## Tool_call_result:',
};

export const PROMPT_HEADER = '# Messages:';
export const FINAL_ANSWER_HINT = '';
