# Agent Note：会话标题快照改由投影单元供给

Status: implemented

[English](2026-10-08-session-title-projection-snapshot.md) | 中文

## 问题

`SessionTitleService.get` 每次调用都折叠整份日志：`foldSessionTitle(session.snapshotEvents())`。因此反复读取标题的宿主每次都要重扫该会话的整个事件数组，且这次读取带着一笔延期的同步历史读。

该包已经注册了 `title` 投影单元，但它的状态只持有标题**文本**，所以 `get` 无法从投影状态里供给自己的快照——标题加 `messageSeqs`、`source`、`eventSeq`、`updatedAt`。`src/types.ts` 里那个未被使用的 `TitleProjection = SessionTitleSnapshot` 别名记着：更丰富才是原本设想的状态形态。

## 决定

`title` 单元的状态改为整份快照载荷（`TitleProjection | null`），其 `stateVersion` 由 1 升到 2。它的 `apply` 由单条 `session/title` 事件构造该载荷，而对其他任何事件返回同一个状态引用，因此无关追加依旧不产生下游工作。

`get` 改为读取 `stateOf(session, 'title')`，并经 `titleSnapshotFromState` 重建快照——那正是折叠原先使用的同一构造路径，所以等价性由构造保证，而非由重写一遍的折叠保证。一个会话的首次读取折叠一次，之后每次读取都从单元水位继续。

wire 视图保持为裸标题文本，因此投影消费方看不到任何变化。

`collectSessionTitleMessages` 仍为单次 provider 生成扫日志：合格前缀只在 provider 运行时才物化，这也是有界 `titleInput` 聚合与它并存的理由。

## 备选方案

为载荷再注册一个单元：**否决**，它会把同一事件折叠两次、多出一行持久记录，并把同一个事实分给两个权威。

经 `checkpoint` 读状态：**否决**，该调用每次都会对**所有**已注册单元的状态做结构化克隆；而 `stateOf` 物化同样的单元并返回活状态，本次读取只是复制它。

让 `get` 继续扫日志：**否决**，它每次读取都重读整份日志，并保留一笔投影面本已取代的同步历史读。

## 影响

- 版本 1 单元持久化的行会被**丢弃**而不是前向套用，因此升级后的首次标题读取会对该会话重新折叠一次日志。被丢弃的行只是一次缓存未命中，绝不会错误标题。
- wire 契约不变：`title` 仍是标题文本。
- `foldSessionTitle` 保留为纯的整数组折叠，供持有事件而非会话的调用方使用。
