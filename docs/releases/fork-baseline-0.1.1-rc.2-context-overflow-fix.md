# fork 变更说明 · baseline/0.1.1-rc.2 · 长会话上下文超限根治三件套（W2′/W1′/W3）

> **本交付为 fork-only**：未发 npm、未推厂商上游。生效需自行部署本分支构建
> （`git fetch <fork> baseline/0.1.1-rc.2 && git checkout <commit>` 后按本仓构建流程安装）。
> 交付指针：`yangyizhu8/dsh` @ `baseline/0.1.1-rc.2` @ **c35c990fed**（七笔：五案笔 + 授权笔 a7d1828963 + 类型门修复笔）。

## 一、修复背景（W0 定谳）

2026-09-28 三个长会话同型报错 `400 invalid_request_error: The input is longer than the model's
context length`，定位为**双防线同时失效**：

1. **容量层虚高**：单适配器族把 `contextWindow = 1,000,000` 当全模型缺省 ⇒ `thresholdTokens`
   与 `retainTokens` 同源虚高 ⇒ **压力压缩路径形同不存在**；
2. **识别层漏判**：`error.ts` 的 overflow 正则未收 `is longer than` 变体 ⇒ 网关 400 被判为
   `INVALID_REQUEST`（非 `CONTEXT_WINDOW_EXCEEDED`）⇒ overflow 救援钩子早退 ⇒ 三会话累计
   46 次 400 **全程无救援**。

## 二、六条发布说明（定稿原文）

1. **长会话更早压缩（预期）**：容量按「模型真窗 + 网关上限」解析后，原本从不压缩的 glm/kimi 系
   与经中转会话会开始压缩；对裸官方 API 的 deepseek 系属**预期内的更频繁压缩，非回归**。
2. **注入上限为新增可见行为**：程序化注入（`agent.inject`）单条上限 **2,048 tokens**、累计上限
   `effectiveWindow × 10%`（未知模型 ⇒ 26,214 tokens）；超限**拒收**并提示改走附件或更短提示。
3. **闸门拒收的注入在界面上呈现为 discarded**，日志含拒收原因（`inbox injection refused: …`）；
   未新增专用事件类型（避免已知事件词汇表变更导致旧版拒读新会话档案）。
4. **W2′ 独立发布的敏感性边界**：识别层修复后，overflow 救援在一次压缩内即可装下真实上限
   （实测：会话 370,054 tokens ⇒ 压后请求 121 tokens；模拟真实上限 300,000）；
   但若**真实不可避免的尾部本身超上限**，仍需 W1′ 的 M3 余量兜底。
5. **`legacy-1e6` 一键回退会同时放宽压缩阈值与注入闸基数**（阈值回到 1e6 系、注入预算回到
   1e6×10% = 100,000）——属预期一致性，非缺陷。
6. **闸门跟随压缩后端**：注入闸的容量与估价由压缩后端发布的可选服务提供；该后端缺席时
   闸门不生效，并各会话告警一次（`inbox injection cap inactive: no capacity service`）——
   架构固有属性，已文档化。

## 三、落地与开关

| 层 | 落点 | 开关 / 回退 |
|---|---|---|
| 识别层（W2′） | `packages/llm/llm/src/error.ts` 单行扩宽 `is\s+(?:longer\|larger)\s+than` | 回退：还原该行 |
| 容量层（W1′） | 新增 `packages/compaction/compaction-basic/src/capacity.ts`；配置面 `contextWindowSource` / `providerTransferCap` / `stepIncrementMarginTokens`；调用点 `compaction-basic/src/index.ts` | `contextWindowSource: 'legacy-1e6'` 一键回退 |
| 注入闸（W3） | `packages/core/agent-loop/src/inbox-cap.ts`（判定）+ `agent.ts`（闸门）+ `Config.inboxInjectionCap`；契约 `packages/core/agent/src/types.ts`（可选 ctx 服务 `inboxCapacity`） | `inboxInjectionCap: 'off'` 一键回退 |

## 四、验收证据（摘要）

- 相关包套件：`packages/core/agent-loop` + `packages/compaction` + `packages/core/agent`
  ⇒ **43 文件 / 665 passed**（exit 0）；
- 发布门两半本地双绿：`npx tsc -b tsconfig.host.json`、`pnpm typecheck:contracts-ready`；
- A1（超预算会话发请求前压缩、不再 400）：体量 370,054 ⇒ 阈值 209,715 ⇒ 压缩 3 事件，首请求
  75,135 < 模拟真实上限 300,000，请求数 1，turn 正常收束；
- A3（容量驱动）：同体量下 glm 目标压缩 3 事件 / deepseek 目标 0 事件；
- A4（零额外压缩）：正常体量 90 tokens 两档均 0 次压缩；
- 两次**负向对照**（证明防线非摆饰）：①W2′ 架空 ⇒ A2④ 2 例转红；②W3 闸门架空 ⇒ 活体用例
  2/3 转红；恢复后文件指纹逐位一致。

## 五、dsh-update-check 登记

**N/A**：本交付无已发布版本（fork-only，未发 npm）⇒ 无版本可登记；代码交付物指针为
`yangyizhu8/dsh` @ `baseline/0.1.1-rc.2` @ `c35c990fed`。本文件即登记依据，防止该自动化日后
误报「版本未登记」。

## 六、遗留（不属本交付，供部署方决策）

1. **部署路径未接**：本 fork 修复不会自动到达既有安装线（0.1.5 / 0.1.7 线），需决定：
   从本 fork 构建安装 / 等待厂商上游合入 / cherry-pick 到安装线；
2. **版本错位**：fork 基线版本行 `0.1.1-rc.2` 与安装线 `0.1.5+` 不一致，待仓库管理口径统一；
3. **观察期三指标**（自部署生效日起计时）：长会话压缩频率、注入拒收误伤、新网关 400 措辞变体。
