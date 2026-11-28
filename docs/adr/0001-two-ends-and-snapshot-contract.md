# ADR-0001 双端架构与快照数据契约（含与实时层的汇聚缝）

- **状态**：已接受（Accepted）。PR #19 于 2026-11-27 合并（`7877d0b`），按本文「合并即生效」生效。正文自此不改写；跟进的落实情况记在 `docs/adr/README.md` 的索引里。
- **裁定**：#21 六问已于 2026-11-27 由 Helm 线 owner（Claude 线）按推荐默认值全数裁定，即刻生效；裁定内容已写入正文，汇总见 §9。
- **日期**：2026-11-21
- **范围**：Helm 地基——终端形态、数据拓扑、快照契约、与实时层的汇聚缝。不含视觉规范、鉴权实现、生成器实现。
- **依据代码**：默认分支 `主要` @ `33bec13`（`index.html` 中的 `cleanSnapshot`、收件箱 `inboxCleanQueue`；`tests/fixtures/*.json`）。

## 1. 背景

Helm 现在是一个单文件 PWA：`index.html`、`sw.js`、`manifest.webmanifest`，托管在 GitHub Pages，零依赖、无服务端。唯一的外部数据是用户在「我的」里配置的一条快照地址，只接受 https（F-1，#17）。到目前为止的十几个切片都在「消费快照」这一侧推进，但有三件事从来没有成文：

1. **双端**到底是什么，各端负责什么；
2. **快照契约**的正本在哪里、怎么演进；
3. 快照（按代拉取）与**实时层**（按事件推送）将来怎样汇到同一个对象模型上。

于是出现了以下实证问题：

- **字段漂移**：桌面 fixture 带 `staleness_days`，代码读的是 `staleness`（README，G8-2 段）。
- **新鲜度不实**：`generated_at` 从未被读取（`index.html` 中 0 处引用），8 天前的数据也显示为「已连接」（#18 ARCH-6）。
- **悬空引用**：生成器因 cq18、cq40 的 `subject_ref` 悬空而 fail-closed 扣发（切片 3 前置实况）。
- **评估结论**：#18 把「控制路径不在本仓、契约只有手写解析」列为 SOTA 差距基线。

本 ADR 先把地基定下来，后续切片照此推进。

> **术语对齐（已裁定，#21 第 1 问）**：派单原文的「Second Brain 实时层」在本次可读到的一手材料中没有同名出处。名称检索覆盖了 helm、jarvis-architecture、miao-ai 三仓与组织内 issue。与之最接近的一手实现，是私有仓 `HUIIIM/miao-ai` 的实时事件层：
> - `ARCHITECTURE.md` §六「事件契约（SSE）」；
> - 其中的 `memory.*`（长期记忆）与 `approval.*`（审批）事件族。
>
> 已裁定：「Second Brain 实时层」＝`miao-ai` 实时事件层，本 ADR 即按此书写。§5.1 的缝规则本身不随对象改变；若日后对象更换，只需重做 §5.2 的映射表。为不把私有仓的设计复制进公开仓，下文只写 Helm 需要的最小字段与语义，不转录对方契约。

## 2. 决策驱动

- **N=1、手机优先**：主人用手机看与判（晨间、拇指操作），用桌面做集中处理。
- **不编造**：缺值保持缺值，未连接不显示 0，标题只用已脱敏的显示标题。这条已落在代码里（`displayTitleOf`、`inboxCleanItem`）。
- **快照永远不是正本**：见 `jarvis-architecture/docs/data-integrity-standard.md`，快照的定义与「写前基线」不变量。
- **公开仓、静态托管**：客户端代码全部公开，所以任何秘密与原始数据都不能进客户端，也不能进仓库。
- **鉴权口径 K4**：令牌是唯一鉴权因子；PWA 阶段不接活令牌，也不持久化令牌。
- **可独立验证**：契约必须能机器校验；切片 3 已提供 `tests/node-check.js` 与 `tests/live/inbox.live.js`。

## 3. 考虑过的方案

| # | 方案 | 结论 |
|---|---|---|
| A | 手机原生 App 加桌面 Web，两套代码 | 否。N=1 下维护两份客户端、两份契约解析，漂移风险翻倍；PWA 已满足安装与离线。 |
| B | 一套 PWA，按断点分两种布局，共用一个数据层 | **采纳**。现状即如此（`#wall` 在 ≥1024px 生效），本 ADR 把它定为约束。 |
| C | 客户端直连各源（队列、目标、记忆、实时事件流） | 否。违反「快照非正本、出口唯一」，并会把内部端点与凭据推到公开的客户端上。 |
| D | 只由服务端投影供数，客户端只认一个投影出口：先快照，后增量事件 | **采纳**。 |
| E | 客户端直写源文件或直写中枢 | 否。写回只经中枢确认队列；客户端只产生带基线的本地决策记录（切片 3 已如此）。 |

## 4. 决策

### 4.1 双端＝一套 PWA、两种布局、一个数据层

| | 手机驾驶舱（<1024px） | 桌面墙（≥1024px） |
|---|---|---|
| 职责 | 看态势、判待决（拇指操作，两步确认） | 集中处理：多面板联动、焦点、命令面板、键盘 |
| 数据 | 与桌面相同的 `snapshot` 对象 | 同左 |
| 状态 | 本机 localStorage：日程、留言、决策日志 | 同左，同一设备同一份 |

规则：

1. **数据层唯一**：两端只经 `cleanSnapshot`（及其子清洗器，例如收件箱的 `inboxCleanQueue`）读数。任何渲染器都不读原始快照。新增数据面时先扩清洗器与 fixture，再写渲染器。
2. **功能不分叉**：同一个对象（目标、决策、待决件、动态）在两端打开的是同一份详情内容。两端只在布局与交互密度上不同，不存在「只有某一端才有的数据」。
3. **断点只有一个**：1024px。≥2560px 只限宽，不另立第三端。
4. **离线**：SW 只缓存外壳，不缓存快照 JSON。快照的最后可用副本由客户端自己保存，并带年龄标签，原有行为保持不变。

### 4.2 数据拓扑：一个投影出口，读写分离

```
各源（队列镜像、目标、决策、动态、健康度……）
        │  （仓外）生成器：按 exposure-map 脱敏投影，fail-closed
        ▼
  投影出口（https）───────────────▶ Helm 客户端（只读）
   ├ 快照：第 N 代的完整物化状态       cleanSnapshot → 两端渲染
   └ 增量事件（将来）：第 N 代之后的变化   本地决策日志（只追加）
                                          │ 导出 JSON
                                          ▼
                               中枢确认队列（仓外）：校验基线 → 落正本
```

- Helm 不读任何源，也不写任何源。客户端的唯一入口是投影出口；唯一出口是导出的本地决策日志，经中枢确认队列回写。
- 投影是 **fail-closed** 的：校验不过就扣发，已发布的快照保持上一代不动（切片 3 前置实况已按此运行）。
- 增量事件与快照走同一个投影出口，受同一套脱敏规则约束（§5）。

### 4.3 快照契约 v2（现行，以 `projection_version: 2` 标识）

**正本位置**：契约的正本是本仓里「消费方契约」，由三部分组成：

1. `cleanSnapshot` / `inboxCleanQueue` 的读取行为；
2. `tests/fixtures/` 里的样本；
3. 本 ADR 的字段表。

生成器侧以它为准做发布前校验（消费者驱动契约）。下一步把字段表落成机器可读的 JSON Schema，见 §7。

**信封字段**

| 字段 | 类型 | 必需 | 语义 |
|---|---|---|---|
| `projection_version` | number | 是 | 契约主版本。客户端优先读它；旧字段 `version` 只作回退。 |
| `generation_seq` | number | 是 | 生成代号，单调递增。决策记录的基线之一。 |
| `generated_at` | ISO 8601 | 是 | 投影生成时刻。**新鲜度以此为准**，不以拉取时刻为准，见 §4.4。 |
| `tenant` | 任意 | 否 | 客户端一律忽略，不显示、不存储到清洗结果中。 |

**段落**：每段都可缺省；缺省时由客户端显示诚实空态，不补 0。

| 段 | 形态要点 |
|---|---|
| `briefing` | `{kind, date, display_title?, summary?}`。目前没有 id，也没有 `subject_ref`。 |
| `goals[]` | `{id, display_title?}` |
| `decisions[]` | `{id, date, display_title?, subject_ref?}` |
| `team` | `{workspaces, goals}`，只有计数。席位不是快照对象。 |
| `overview` | `goals_total`、`goals_named`、`goals_activity_buckets{updated_last_24h, updated_last_7d, older}`、`recent_activity[]{type, date, display_title?, subject_ref?}`、`staleness` |
| `fleet_health` | `{healthy, degraded, down}` 计数 |
| `pending_approvals` | 旧形态：`{status, count, items[]}`。出现 `queue` 段时停用。 |
| `queue` | 队列镜像投影：`{status: connected\|not_connected, count, items[], title_map?, dropped?}`。件字段为 `queue_id, kind, state, actor, requested_at, subject_ref, effect, content_hash, decided_at, decided_via, decision_note` 与 `display_title`，另加可选字段 `decided_by`（决定者，#21 第 5 问裁定的 v2 内加法）；`actor` 保持提请方语义，`decided_via` 保持决定途径语义；`state` 用 K2 闭枚举 `{pending, approved, rejected, executed, unknown}`。 |

**不变量**（客户端已执行，生成器必须保证）：

1. **暴露**：只投影显示标题，即 `display_title` 或 `title_map` 值。任何原始标题，或被标为 [review] 级的字段，都不进投影。
2. **缺值**：缺失写 `null` 或直接缺省，不许造值，也不许用 0 代位。
3. **引用闭合**：`subject_ref` 要么能在同一份投影中解析，要么省略。悬空引用触发扣发（cq18、cq40 即是此类，处置仍候上层裁定）。
4. **身份稳定**：同一对象跨代保持同一 id。凡可决定的件（`queue.items`）都必须携带 `content_hash`，作为决定的绑定基线。
5. **闭枚举**：枚举外的值，客户端按 `unknown` 处理并 fail-closed，不开放任何决定。

**演进规则**：

- 主版本内只做**加法**：可以加段、加可选字段；客户端忽略不认识的字段。
- 改名、删字段、改语义，都必须升 `projection_version`。客户端双读当前主版本与上一主版本，fixture 两版并存，直到上一版退役。
- 已知待修的漂移：
  - `staleness_days` 与 `staleness` 二名并存：v2 定名 `staleness`，`staleness_days` 视为非契约字段；
  - 动态项没有稳定 id，客户端暂用位置寻址 `activity-<index>`，只作本地导航；
  - `briefing` 没有 id。

  这些都在 v3 一并处理，见 §7。

### 4.4 新鲜度与连接状态

- 「已连接（Live）」必须同时满足两条：本次拉取成功，且 `now − generated_at` ≤ 新鲜阈值。
- 拉取成功但数据超龄，显示「快照较旧」，并标出数据年龄。拉取失败但有缓存，显示「缓存快照」，并标出缓存年龄。
- 缺 `generated_at` 的快照不能显示为 Live。
- 新鲜阈值已裁定为 **24 小时**（#21 第 6 问），在实现切片里作为常量 `DATA_FRESH_MS` 落地（PR #20）。
- `主要` 现行代码只看拉取时刻（`signalState`），与本条不符；实现见 PR #20（§7 第 1 项）。

### 4.5 决定与写回

1. **本地**：决定只追加到本地决策日志（`helm.decisions.v1`）。每条记录必须带：
   - 理由；
   - 两步时间戳 `reviewed_at`、`decided_at`；
   - 基线：`content_hash`、`generation_seq`、快照状态。
2. **写回**：日志经中枢确认队列回写。确认端必须按「写前基线」校验：记录里的 `content_hash` 不等于正本当前的哈希，就拒绝，不落正本，并把冲突回报给本地。这是乐观并发；HTTP 中同类做法见 RFC 9110 §13 的 `If-Match` / 412。
3. **封印**：客户端只在后续投影显示中枢状态与本地记录一致时，才标「一致」。从不声称「已送达」。

## 5. 与实时层的汇聚缝

**汇聚的对象模型**：

- 快照＝第 N 代的物化状态；
- 实时事件＝第 N 代之后、按序到达的增量；
- 两者描述同一批对象，使用同一个 id 空间。

这与 Open MCT 的 telemetry provider 同形：先 `request`（历史），后 `subscribe`（实时），两者共用同一对象标识。

### 5.1 缝规则（无论实时层最终指谁，都成立）

1. **同一 id 空间**：事件所指的对象，必须用快照里的 id 表示，即 `goal.id`、`decision.id`、`queue_id`、`subject_ref`。实时层内部的 id（例如运行 id、追踪 id）只作关联字段，不作对象身份。
2. **高水位衔接**：
   - 快照必须带一个高水位 `stream_position`，即已折叠进本代的最后一条事件序号，v3 新增字段；
   - 客户端订阅增量时从该位置续接，用 SSE 的 `Last-Event-ID` 语义；
   - 事件序号单调；客户端丢弃序号 ≤ 高水位的事件，保证不重放、不漏放；
   - 发现序号断档时，客户端整份重拉快照，不去猜补。
3. **同一投影边界**：增量事件与快照经同一个投影出口发出，适用同一套暴露规则：只有显示标题、只有摘要、不含原文、不含凭据。客户端不直连实时层的内部端点。
4. **同一绑定基线**：可决定对象的决定，绑定在该对象内容的哈希上。
   - 快照侧叫 `content_hash`；实时层的审批对应物是「计划哈希」：计划变化即作废审批。两者语义相同。
   - 汇聚后，事件里可决定对象的哈希必须与快照的 `content_hash` 同算法、同输入口径。否则同一件在两条通道上会出现两个基线。
   - 已裁定（#21 第 4 问）：统一用 `content_hash` 规则，即对可决定字段做规范化 JSON 后取 sha256；实时层在投影出口按同一口径重算。
5. **状态机对齐**：快照的 K2 枚举与实时层的审批生命周期必须一一映射。实时层有、K2 没有的终态，在获裁定前一律落到 `unknown`（fail-closed，不开放决定）。
6. **时间与新鲜度**：事件携带发生时刻。连接状态取「最后一条事件时刻」与 `generated_at` 中较新者计算数据年龄，同 §4.4。
7. **传输**：只用 https 上的 SSE（与实时层现有传输一致），不引入 WebSocket。实时连接断开时，退回按代拉快照，再从高水位续接。
8. **鉴权**：实时通道需要令牌（K4）。PWA 阶段不接活令牌，所以**本阶段只定缝、不接通**。接通前须另立鉴权 ADR，至少回答两件事：令牌放在哪里、怎样不落盘。

### 5.2 映射（实时层＝`miao-ai` 实时事件层，#21 第 1 问已裁定）

| Helm 快照侧 | 实时层侧（语义，不转录私有契约） | 对齐结论 |
|---|---|---|
| `queue.items[].state = pending` | 审批已请求 | 一致 |
| `approved` / `rejected` | 审批已决（批准／否决），带决定者、决定时刻、可选理由 | 一致。决定者映射到新增可选字段 `decided_by`；`actor` 仍为提请方，`decided_via` 仍为决定途径（#21 第 5 问已裁定）。 |
| `executed` | 审批后执行完成（实时层是运行状态，不是审批事件） | 由服务端投影派生：同一审批的运行完成即投影为 `executed`；客户端不推导（#21 第 3 问已裁定）。 | |
| （无） | 审批过期（未决关闭） | K2 外。K2 暂不扩枚举，落 `unknown`，fail-closed（#21 第 2 问已裁定）。 |
| （无） | 审批作废（计划哈希变化） | K2 外，语义等同 Helm 的「基线已变」。K2 暂不扩枚举，落 `unknown` 并提示复核，fail-closed（#21 第 2 问已裁定）。 |
| `content_hash` | 计划哈希 | 语义一致；统一用 `content_hash` 规则（§5.1 第 4 条，#21 第 4 问已裁定）。 |
| `subject_ref` | 运行所属目标的引用 | 须改用快照 id 空间（§5.1 第 1 条） |
| `overview.recent_activity[]` | 运行、工具、记忆等事件流 | 动态项须获得稳定 id（v3）；记忆类事件只进摘要，不进原文 |

## 6. 后果

**正面**

- 手机与桌面永远读同一份清洗结果，不会出现某一端独有的数据，也不会出现两份解析。
- 契约在本仓有正本，生成器可以照它做发布前校验，漂移能在发布前被拦下。
- 实时接入有了确定的缝：同一 id 空间、高水位续接、同一投影边界、同一基线。接入时只需要加一条传输，不需要重写对象模型。
- 写回路径与「写前基线」不变量一致：旧快照不能覆盖新正本。

**代价与风险**

- 主版本内只能做加法，改名必须升版并双读，节奏变慢。
- 「消费方契约」要求生成器侧接入校验；在接入之前，契约只约束客户端一侧。
- 实时层的身份目前只是假设（§1）。如果假设不成立，§5.2 要重做。
- 本阶段不接实时通道，所以「Live」仍是按代刷新，最小延迟受生成节律限制。

## 7. 跟进（本 ADR 不实现，各自另立切片）

1. **新鲜度按 `generated_at` 判定**（§4.4）；缺失时不得显示 Live。关闭 #18 ARCH-6 与 OPS-3 的一半。已实现于 PR #20（阈值 24 小时）。
2. **契约机器化**：把 §4.3 落成 `docs/contract/snapshot.v2.schema.json`，fixture 逐一过校验，并接进 `tests/`。
3. **v3 契约草案**，候派单方裁定：
   - 新增 `stream_position`；
   - 为动态项与 `briefing` 增加稳定 id；
   - 统一 `staleness` 字段名；
   - 哈希口径已裁定（§5.1 第 4 条），v3 只需把口径写进 schema。
4. ~~K2 扩枚举裁定~~：已裁定暂不扩枚举，两者落 `unknown`（#21 第 2 问）。v3 起草时可再议。
5. **实时通道鉴权 ADR**：K4 下令牌的存放与生命周期。
6. ~~术语确认~~：已裁定为 `miao-ai` 实时事件层（#21 第 1 问）。

## 8. 参考

- 本仓：
  - `index.html`（`cleanSnapshot`、`signalState`、`inboxCleanQueue`）；
  - `tests/fixtures/`；
  - `docs/helm-reference-ops-teardown.md` §4、§8（关系只由 `subject_ref` 推导；生成器缺口）；
  - README 各切片段；
  - #17（F-1：只收 https）；#18（SOTA 评分卡：ARCH-6、OPS-3、VER-5、INT-3）。
- `HUIIIM/jarvis-architecture` `docs/data-integrity-standard.md`：快照定义、写前基线（compare-and-swap）、恢复版本闸。
- `HUIIIM/miao-ai` `ARCHITECTURE.md` §六：实时事件契约（SSE）、审批与记忆事件族。私有仓，本文只引语义。
- Michael Nygard，*Documenting Architecture Decisions*（2011）：https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions
- MADR：https://adr.github.io/madr/
- Ian Robinson，*Consumer-Driven Contracts: A Service Evolution Pattern*：https://martinfowler.com/articles/consumerDrivenContracts.html
- WHATWG HTML，Server-sent events（`Last-Event-ID`）：https://html.spec.whatwg.org/multipage/server-sent-events.html
- RFC 9110 §13，条件请求（`If-Match` / 412）：https://www.rfc-editor.org/rfc/rfc9110#section-13
- NASA Open MCT，telemetry API（`request` / `subscribe`）：https://github.com/nasa/openmct/blob/master/API.md

## 9. 裁定记录

#21 六问，2026-11-27 由 Helm 线 owner（Claude 线）按推荐默认值全数裁定，即刻生效。回执留痕见 #21。

| # | 事项 | 裁定 | 落在本文 |
|---|---|---|---|
| 1 | 「Second Brain 实时层」所指 | ＝`miao-ai` 实时事件层 | §1、§5.2 |
| 2 | K2 是否加「过期」「作废」 | 暂不加；实时层这两种终态记 `unknown`（fail-closed） | §5.2、§7 第 4 项 |
| 3 | `executed` 的来源 | 由服务端投影派生，客户端不推导 | §5.2 |
| 4 | 绑定哈希口径 | 统一用 `content_hash` 规则 | §5.1 第 4 条、§5.2 |
| 5 | 决定者字段映射 | 新增可选字段 `decided_by`（v2 内加法）；`actor`、`decided_via` 语义不变 | §4.3、§5.2 |
| 6 | 数据新鲜阈值 | 24 小时 | §4.4（实现：PR #20 `DATA_FRESH_MS`） |
