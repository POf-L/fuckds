# 深度优化说明（相对原包）

> 原则：不改对外接口、不改业务语义。OpenAI / Anthropic 两条链路、
> 工具调用解析、附件/超长转附件、号池轮换、PoW 求解逻辑均保持原样。
> Go 的 PoW 求解器已经是预计算 + 多 worker 的快路径，本次未动。

## 1. 体积：压缩包 20 MB / 解压 56.6 MB → 压缩包 0.75 MB / 解压约 2.1 MB

原 zip（2,971 个文件）里真正源码只有约 2 MB，剩下的是：

- `web/node_modules/`：约 55 MB，2,300+ 个文件。前端依赖，解压后
  `npm --prefix web install` 即可重装，绝不应该进发布包。
- `test/.artifacts/`：大量测试截图（`*-error-*.png`），已在 `.gitignore`
  里，但打包时没排除。
- `src/prompt/special.mjs.bak`：与正式文件只差一行注释的备份文件。

本次已删掉以上三类，并把 `.gitignore` 补齐
（`web/node_modules/`、`web/dist/`、`*.bak` 等）。
新增 `npm run package`（`scripts/package.mjs`）：以后打包只用它，
自动排除 node_modules、data、`.env`、测试产物、`.bak`、`.git`；
`web/dist` 若已构建会一并带上，解压后 `/admin` 可直接用。

## 2. 安全：首页不再泄露 API Key

- **高危修复**：原 `GET /` 首页是未鉴权的，但示例 curl 里直接插了
  真实的 `config.server.apiKey`。任何能访问首页的人都能拿到 key。
  现已改为 `<your-api-key>` 占位符。
- API Key 比较从字符串 `!==` 改为 SHA-256 + `timingSafeEqual`
  恒时比较（`src/http.mjs` 的 `isApiKeyValid`），不再因长度/时序泄露信息。
- JSON / HTML 响应统一加 `X-Content-Type-Options: nosniff`。

未改动、仍需你自己注意：`CORS_ORIGIN` 默认 `*`，且 `HOST` 默认
`127.0.0.1`。如果把监听地址改成 `0.0.0.0` 对外暴露，务必设置强 `API_KEY`。

## 3. 去重：约 200 行重复代码抽成公共模块

- 新增 `src/http.mjs`：`server.mjs` 和 `admin/routes.mjs` 原来各有一份
  `readJson` / `sendJson` / `sendHtml` / `escapeHtml` / API Key 校验，
  且请求体上限还不一致（8MB vs 2MB）。现统一到一处，
  两处上限保持原值（主接口 8MB、后台 2MB），行为不变。
- 新增 `src/sse.mjs`（`BaseSse`）：OpenAI / Anthropic 两份 SSE writer
  除了帧格式外逐行相同（响应头、keep-alive、end 清理），现由基类统一，
  `src/openai/sse.mjs`、`src/anthropic/sse.mjs` 只留帧格式。
- 新增 `src/util.mjs` 的 `parseEnvText`：`config.mjs`（启动读 `.env`）
  和 `admin/routes.mjs`（后台读配置）原来各写了一份 `.env` 解析，
  现共用一份，引号/注释处理不再有分叉风险。
- `src/openai/response.mjs` 删除私有的 token 估算实现，统一用
  `src/util.mjs` 的 `estimateTokens`，两协议 usage 口径一致。
- 删掉 `package.json` 里指向不存在的 `bin/cli.mjs` 的 `bin` 字段
  （`npm link` 原来会直接失败）。

## 4. 热路径性能（小改动、可验证）

- `estimateTokens`：原来每个字符跑一次正则。超长 prompt（10 万字起）
  下这是可观的常数开销；改为码点区间比较，并按码点（而非 UTF-16
  单元）计数，表情不再被算成两个 token。
- `direct/stream.mjs` 的 SSE 解析器：原来每解析一帧就把剩余 buffer
  整体 `slice` 一次，一个 chunk 里 N 帧就是 O(N × 剩余长度)。
  改为只移动 offset、每次 `push` 结束时压缩一次。
- `direct/client.mjs` 的文件上传缓存：原来过期条目永不删除，
  长期运行的进程里 Map 随上传次数无限增长。写入前清过期项，
  并设 512 条上限（满了先清过期、再删最旧）。
- `admin/routes.mjs` 的静态文件：原来每次请求把整个文件
  （主 JS 约 588KB）读进内存再发。改为 `createReadStream` 流式发送，
  并发访问后台时内存不再随并发线性增长。
- `chat-runner.mjs`：空回答诊断分支原来调用两次 `findToolMarkup`
  （全文正则扫描）；改为算一次复用。工具名判未知原来是数组
  `includes`，改为 `Set.has`。
## 5. 没有动、也不建议盲目动的地方

- Go PoW：已是前缀预计算 + 按位数分块 + 多 worker，20–30ms 级，
  再优化收益极小且容易改错哈希。
- `browser/driver.mjs` 的轮询（60ms）和 `settleMs`（800ms）：
  它们是“等页面渲染稳定”的时序参数，调小会直接增加截断/丢尾风险。
- `direct/client.mjs` 的号池、冷却、换号重试：是限流保护逻辑，
  不是冗余重试，别为了“快”删掉。

## 6. 验证

- 全部源码 `node --check` 通过。
- 自带测试：原版与优化版均为 **136 通过 / 4 失败 / 2 跳过**。
  4 个失败在两版完全相同，原因是本机没有 `npm install`（缺
  `playwright`，`src/browser/driver.mjs` 导入即报错），与本次改动无关。
  完整验证请先 `npm install` 再 `npm test`。
- 针对改动点单独验证（token 估算、SSE 解析 500 帧、SSE writer、
  恒时 key 比较、请求体上限）全部通过。
- 未做需要真实 DeepSeek 账号的端到端验证：没有 token 时
  `npm run up` / 真实对话无法跑，部署后请先跑 `npm run smoke`。

## 7. 使用（与原来一致）

```bash
npm install
npm run pow:build
npm run auth -- '<userToken>'
npm run up
# 以后打包发布：
npm run package   # 生成 fuckds-optimized.zip
```

---

## 8. 第二轮：英文提示词、工具参数纠正、流式提速

### 8.1 参数传错到底是代码问题还是模型问题？结论：两边都有，代码侧可修

排查链路（提示词 → DSML 解析 → chat-runner → 客户端）：

- **提示词自相矛盾（模型侧的直接诱因）**：旧提示词说“string 属性可以省略，
  但写全更稳”，而 DSML 解析器缺省把没有 string 属性的参数当字符串。
  模型一省略，数字 `10`、布尔 `true`、数组 `["a"]` 就全变成字符串，
  客户端按声明校验时直接报错。这是本次最常见的传错形态。
- **服务端从不校验（代码侧的缺口）**：旧代码只知道工具名，不知道参数
  schema。解析出来的调用原样发给客户端，错类型、大小写写错（`Query`
  vs `query`）、整包塞进一层 `args` 参数，都没有任何一层拦截或纠正，
  只能靠客户端报错、agent 自己纠错，一轮工具调用就此浪费。
- **模型本身的幻觉无法根除**：编造必填值、调未声明的工具名，这类错误
  提示词只能压低概率，不能保证为零。所以纠正层只做“无歧义还原”，
  绝不替模型编造缺失值（见下）。

### 8.2 提示词改成英文并加强约束（`src/prompt/special.mjs`）

- 全文改成英文；超长附件的说明、段落标记也同步改成英文
  （`src/prompt/overflow.mjs`），避免一轮请求里中英提示词混写。
- 删掉“可以省略”：每条参数必须写 `string="true"` 或 `string="false"`，
  并写明缺省会被当字符串。
- 类型对照表 + 正反例子：用一个带 string / integer / array 的小工具，
  正确写法和四种典型错法（`"10"`、字符串数组、`args` 双层包装、
  大小写错）并列，模型不用再猜。
- 预检清单：发调用前自查工具名、参数名、参数类型、必填齐全四项；
  必填值未知时不许猜、不许调工具，改成文字说明缺什么并向用户要。
- 工具声明渲染时把 `required` 在顶层再写一份（`renderToolDeclarations`），
  原来它只藏在 `parameters.required` 里，模型容易漏看。
- 修复一个旧空洞：`FINAL_ANSWER_HINT` 原来是空字符串，最后一轮是工具
  结果时模型得不到“直接回答”的指令，现已补上英文提示。
- 长度控制：新提示词 4,218 字符（旧中文 2,187 字符，但英文按 token
  算并不更贵），且刻意压在 6,000 字符预算内，超长拆附件的原有测试
  全部通过，没有因为提示词变长而挤占上下文预算。

### 8.3 服务端参数纠正（`src/prompt/tools.mjs` + `src/chat-runner.mjs`）

新增 `getToolSchemas` / `coerceToolCallArguments`，在 `evaluate()` 和
思考里提升调用时都跑一遍（OpenAI / Anthropic 两条链路共用）：

- 可还原的纠正：`"10"` → `10`（integer）、`"true"` → `true`、
  `'["a"]'` → `["a"]`、对象字符串 → 对象，嵌套对象/数组元素递归纠正；
- 大小写改名：`Query` → `query`（仅当声明里恰好有一个大小写不敏感匹配时）；
- 单层包装拆除：`{args: {...}}` / `{arguments: {...}}` 且里层键命中
  声明参数时拆掉一层；
- 只警告、不改动、不丢弃：必填缺失、枚举不符、无法还原的类型只记
  日志（日志里只写参数名，不写参数值，避免敏感内容进日志），调用
  原样返回给客户端报 unknown / 参数错误，让 agent 自我纠正——
  丢弃调用会让客户端收到空回答，编造缺失值比原样返回更糟；
- 未声明的工具名原样返回，不改动（与旧行为一致）。

新增测试 `test/tool-args.test.mjs` 覆盖以上四类。

### 8.4 token 转发速度（流式热路径，不是首字延迟）

先说清楚边界：首字前的人为延迟（PoW 补足 120–520ms + 打字停顿
120–480ms，`DEEPSEEK_HUMAN_TIMING`）是反检测伪装，本次没动它。
想要最快首字可以设 `DEEPSEEK_HUMAN_TIMING=false`，代价是 PoW
耗时特征更像机器，请自行权衡。本次改的是**已经开始流之后的
每 token 成本**，两处都是随输出长度增长的二次开销：

- **直连引擎**（`src/direct/client.mjs` + `src/direct/stream.mjs`）：
  原来每个上游补丁都要把全部 fragments filter + map + join 一遍，
  再和已发文本做 `startsWith`。新增 `createTextTracker`：同一对象
  的最后一段只做追加时直接切片取增量，不拼全文、不做全文比较；
  快照替换或片段被改写时回退全文 join + 前缀校验，正确性不变。
  本地合成测试（5,000 次追加、总 50KB）：约 220ms → 约 30–47ms。
- **工具协议过滤器**（`src/openai/tool-text.mjs`）：
  原来每个 push 都要对已累积全文做正则扫描（`findToolMarkup`、
  半截标签检测里的 `lastIndexOf('<')` / `lastIndexOf('\n')` 全文回扫）。
  现在：长文本下先看未发出部分附近有没有协议触发词，没有就跳过
  全文扫描；半截检测从已发出位置开始扫；最后一行、半截 `<|END|>`
  只看未发出后缀。本地合成测试（2,000 次 push、总约 100KB）：
  约 1,850ms → 约 330ms。工具调用出现在末尾时仍能正确截断，
  已用 `bench2` 式用例验证（DSML 块不漏进正文，`cutKind=TOOL_CALL`）。

以上数字是本机合成基准，不是真实 DeepSeek 上游耗时；真实链路里
上游网络和模型生成仍是主导，改动的效果体现在长回答后期
token 间隔不再随长度越拖越慢。

### 8.5 本轮验证

- 全部源码 `node --check` 通过。
- 全量测试：**140 通过 / 4 失败 / 2 跳过**。4 个失败与上一轮、原版
  完全相同（缺 `playwright` 的 4 个文件），新加的 4 个参数纠正测试
  全部通过，超长拆附件、提示词、流式过滤的原有测试未被破坏。
