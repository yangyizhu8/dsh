# 案例归档 · dsh 长会话上下文超限根治（W2′/W1′/W3）· 2026-09-28 → 09-29 关单

- 交付指针：`yangyizhu8/dsh` @ `baseline/0.1.1-rc.2` @ **c35c990fed**（fork-only，未发 npm）
- 卷宗：W0 结案件（docs/cases/w0-context-overflow-case-20260928.md）+ 方案包三件
  （docs/plans/w0-fix-package-20260928.md、W1-prime-m1-final-20260928.md、
  audit-revision-delta-20260928.md；**效力序：差量件 > 回填件 > 方案包 > 结案件**）
  + 本归档 + docs/releases/fork-baseline-0.1.1-rc.2-context-overflow-fix.md（六条发布说明）
- 落位说明：本件按收官指令原拟落 docs/cases/，因该目录两次落盘未生成文件（见 §七），
  经裁定改落 docs/releases/（已验证可写）——内容与判据不变。

## 一、七笔交付链（fork 侧 HEAD 逐位核对一致）

| # | commit | 内容 |
|---|---|---|
| 1 | bdb040dc6f | W2′：error.ts:68 单行扩宽（is longer/larger than）+ A2 ①②③④⑤ 验收用例（措辞矩阵 11 例） |
| 2 | a31e8f8fbd | W1′：新增 capacity.ts（归一化 + 有效窗解析链）+ 配置面 + 调用点 + 常量降级 |
| 3 | d614f3d199 | W1′ P2：conservative 改按**绑定腿**判定 + 新增 transfer-cap 来源 |
| 4 | cbba317109 | W3：注入闸（单条 2,048 / 累计 effectiveWindow×10% / off 回退）+ 契约 + 发布方 + 纯函数 6 例 |
| 5 | bc2d3f59b5 | W3 活体端到端断言（六步④唯一条件项，test-only） |
| 6 | a7d1828963 | 授权随推笔（用户本人 09-15 docs 笔；C7 闸经归属人确认） |
| 7 | c35c990fed | 类型门修复轮（pre-push 拦下的 8 处 TS 错误，含 #3 真实缺口闭合） |

## 二、验收证据（全量指针）

- 套件：packages/core/agent-loop + packages/compaction + packages/core/agent ⇒ **43 文件 / 665 passed**（exit 0）
- 发布门两半（本地预跑 + 钩子内实跑）：npx tsc -b tsconfig.host.json、pnpm typecheck:contracts-ready 双绿
- A1 超预算会话发请求前压缩、不再 400：体量 370,054 ⇒ 阈值 209,715 ⇒ 压缩 3 事件；首请求 75,135
  < 模拟真实上限 300,000；请求数 1；turn 收束 completed
- A2④（W2′-only 最不利组合，legacy-1e6 固定）：压后重发 **121** tokens < 300,000；结局② 硬停 =
  重发恰一次 + turn/end=error(CONTEXT_WINDOW_EXCEEDED)
- A3 容量驱动：同体量 glm 压缩 3 事件 / deepseek 0 事件；A4 正常体量 90 tokens 两档 0 压缩
- ⑤ 开关三态与 legacy 交互：glm 209,715 / deepseek 800,000（= 现状）/ legacy 800,000 / 覆盖 640,000；
  注入闸 legacy 基数 100,000
- **两次负向对照**（防摆饰防线）：①W2′ 架空（:68 回退）⇒ A2④ 2 例转红；②W3 闸门架空
  （rejection = undefined）⇒ 活体用例 2/3 转红；两次均以文件指纹逐位一致恢复

## 三、门禁拦截实例（本周期第三方实例）

- 现象：⑥ 推送被 **pre-push** 拦下，8 处 TS 错误全部落在本案改动面内
- **错误源精化（审核方复核）**：错误全部出自 build:lib:host（tsc -b tsconfig.host.json）；
  typecheck:contracts-ready 单独亲跑通过——但两者均为发布门前置，**本地须双跑**
- 根因（我方验收口径缺陷）：以 vitest 全绿（665/665）作为发布就绪证据，而 **vitest 只转译不做类型检查**；
  类型门在 pre-push（非 pre-commit）⇒ 从未被本轮触达。**与 W1′ 期 lint 假报区分**：那次是 error
  （死代码）阻断、warnings 不拦；本次是真实类型错误
- 处置：5 文件 8 处修复（条件展开 + 类型声明补字段 + 真实缺口闭合），本地双门预跑后重推成功

## 四、方法论条目（「验证器过≠闸过」三实例版，合并登记）

| 实例 | 形态 | 教训 |
|---|---|---|
| CI 矩阵哈希案 | 契约门按矩阵 yaml 哈希比对，哈希落后即 CI 红 | 门禁判据源必须与产物同批更新 |
| 闸闭环案 | 闸门状态以本地假设代替 ls-remote 实测 | 闸门/推送状态须以网络权威真值核验 |
| **本案（验收侧）** | 以单元测试全绿冒充发布就绪，未跑仓库发布门 | **发布就绪判据必须含仓库发布门（pre-push 两半）本地实跑；新增 TS 类型面变更必须本地 typecheck 前置** |

## 五、发布受阻三裁记录（⑥ 全链留痕）

1. **远程布局**：本机 DSH 仓唯一远程为厂商上游 deepseek-ai/deepseek-harness，baseline/0.1.1-rc.2
   无上游对应分支 ⇒ 裁定新增 fork 远程 yangyizhu8/dsh，显式远程名推送、严禁触碰 origin
2. **他线笔随推（C7）**：待推清单实为 6 笔（含非本案笔 a7d1828963）⇒ **未推即停**，经归属人
   （用户）授权后随推；纪律定稿：**发布单前置核对须对 origin..HEAD 全清单逐笔归属，非本件笔不得
   默认随推（授权后随推须记录授权来源）**
3. **网络双路**：代理 socks5://127.0.0.1:7890 一度不通、直连 443 亦不可达 ⇒ 未以未验证前提硬推；
   代理恢复后按默认路重推成功（未改持久代理配置）
4. **终裁 A（用户 2026-09-29）**：不执行 bump/publish，fork-only 收官。双层理由：本机无
   @deepseek-ai scope 凭据 + 从 fork 向公共 registry 发布厂商 scope 属第三方影响不可逆动作。
   版本/tag 子裁定随 A 作废；dsh-update-check 登记为 **N/A**（无已发布版本，指针即代码交付物）

## 六、遗留挂账（不属本案，供部署方决策）

1. 部署路径未接（fork 修复未自动到达既有安装线 0.1.5 / 0.1.7）
2. 版本错位（fork 基线 0.1.1-rc.2 vs 安装线 0.1.5+）
3. 观察期三指标（长会话压缩频率 / 注入拒收误伤 / 新网关 400 措辞变体）自部署生效日起计时

## 七、收官期新增纪律（本期实测教训，建议入库）

1. **合并 pathspec 的 add 会整体 abort**：`git add <A> <B>` 中 B 不存在 ⇒ git fatal 中止，A **亦未暂存**
   （暂存数 0），且 commit 只报 nothing to commit——易被误读为「无改动」。**纪律：add 逐条执行并核对暂存数**。
2. **落盘必须落盘后复核**：`write` 工具与 python 各一次对 docs/cases/ 写入未生成文件（Test-Path False），
   而工具均报成功。**纪律：关键交付物写入后立即 Test-Path/取字节数复核，并优先落已验证可写目录**。
3. **推送前类型门预跑**（本节 §三）与 **未推即停**（本节 §五.2）两条，已并入方法论三实例版。
