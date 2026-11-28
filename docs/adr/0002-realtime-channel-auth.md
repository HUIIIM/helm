# ADR-0002 实时通道鉴权：令牌只在内存、请求头携带、只读作用域

- **状态**：提议（Proposed）。合并即生效；合并与否由 Helm 线 owner 判定。其中四个参数待裁，见 §7。
- **日期**：2026-11-28
- **承接**：ADR-0001 §5.1 第 8 条与 §7 第 5 项——实时通道需要令牌（K4），接通前须另立鉴权 ADR，回答令牌放在哪里、怎样不落盘。
- **范围**：Helm 客户端与投影出口之间的实时增量通道（SSE），以及同一出口上的快照读取。不含写回路径：写回仍只经中枢确认队列（ADR-0001 §4.5）。不含生成器与实时层服务端的实现。
- **本 ADR 不接通任何通道**：只定规则。接通是另一个实现切片，且以本 ADR 被接受为前提。

## 1. 背景

- **K4 口径**（切片 3 简报，硬约束）：令牌是唯一鉴权因子；PWA 阶段不接活令牌，不把任何令牌持久化进 localStorage；文案与注释不得出现「双因子」表述。
- **Helm 的现状**：
  - Helm 是 GitHub Pages 上的公开静态页。客户端代码全部公开，没有服务端，也就没有能替客户端保管秘密的地方。
  - 唯一的数据入口是用户自填的 https 快照地址（F-1，#17）。读和存两侧都校验只收 https。
- **实时层的现状**（`HUIIIM/miao-ai`，ADR-0001 §5.2 已裁定为汇聚对象；私有仓，本文只引语义）：
  - **服务端**：生产强制鉴权，只认真实凭证，没有无凭证路径（`ARCHITECTURE.md`「生产部署口径」节）。API 用 Bearer key，key 只存哈希（同文件 REST 契约节）。
  - **自家客户端**（`frontend/src/lib/api.ts` 文件头注释与 `streamRunEvents`）：
    - key 只放在模块内存里，不写 localStorage、sessionStorage、cookie，刷新即丢、需重新输入，并注明「by design」；
    - SSE 用 `fetch` 加 `ReadableStream` 读取，用 `Authorization: Bearer` 请求头携带凭证。
- **浏览器约束**：`EventSource` 的构造参数只有 URL 与 `withCredentials`，不能设置自定义请求头（WHATWG HTML，Server-sent events）。所以想用请求头带令牌，就不能用 `EventSource`。
- **#18 的相关发现**：
  - 第 5 节第 3 条：快照地址如果在查询串里带令牌，会明文存进 localStorage，并在「我的」输入框里回显。
  - SEC-A6：页面没有 CSP。

## 2. 决策驱动

1. **K4 优先**：令牌是唯一因子；任何令牌都不落盘。
2. **公开静态页**：页面代码、仓库、URL、日志都可能被他人看到，令牌不能出现在其中任何一处。
3. **最小权限**：Helm 只读投影；令牌泄露的最坏后果应当限于读取投影，不能扩大到写入或控制。
4. **与实时层同形**：沿用实时层自家客户端已经在用的做法，不另起一套。
5. **不能难操作**：易用性硬门。手机上每次刷新都要重新输入长令牌，代价必须正面处理，不能假装不存在。

## 3. 考虑过的方案

| # | 方案 | 结论 |
|---|---|---|
| A | 令牌放在 URL 查询串（快照地址或 SSE 地址里带 `?token=`） | 否。会进入 localStorage（快照地址本来就被持久化）、浏览器历史、服务器与代理日志、Referer。违反驱动 1、2。 |
| B | 令牌存进 localStorage、sessionStorage、IndexedDB 或 SW 缓存 | 否。K4 明文禁止持久化进 localStorage，其余存储与之同类，一并排除。 |
| C | 由投影出口在 Helm 页面所在源之外签发 HttpOnly cookie，`credentials: 'include'` 携带 | 否（现阶段）。Helm 在 GitHub Pages 上，与投影出口跨站，cookie 属于第三方 cookie，主流浏览器默认拦截或限制，手机上尤甚。实时层自家前端用的是同源 cookie 路线，Helm 不具备同源条件。 |
| D | `EventSource` 加 `withCredentials` | 否。不能设置请求头，只能依赖 cookie，等于回到方案 C 的问题。 |
| E | **令牌只在内存；`fetch` 加 `ReadableStream` 读 SSE；`Authorization: Bearer` 请求头携带；令牌只有只读作用域、有效期短、可吊销** | **采纳**。与实时层自家客户端同形；满足 K4；泄露面限于读取投影。 |

## 4. 决策

### 4.1 令牌放在哪里

1. 令牌只存在于 Helm 页面脚本的内存变量中。
   - 不写入 localStorage、sessionStorage、IndexedDB、cookie、Cache Storage、URL（含 hash）、`history.state`。
   - 不写入任何导出文件（决策日志导出不含令牌）。
   - 不出现在任何 DOM 文本或属性中。
2. 输入框使用 `type="password"` 与 `autocomplete="off"`。读入内存后立即清空输入框。界面只显示「已连接实时通道」与令牌的到期时刻，不显示令牌本身，也不显示其任何片段。
3. Service Worker 不经手令牌：SW 不缓存带 `Authorization` 的请求，现行 SW 已不缓存任何 `.json` 与非 GET 请求；实时流请求同样不进 SW 缓存。
4. 刷新页面、关闭标签页、令牌到期、收到 401 或 403 时，内存中的令牌一律丢弃，界面回到「实时通道未连接」，并说明原因。快照读取路径不受影响，继续按代拉取。

### 4.2 怎样携带

1. 实时增量用 `fetch(url, { headers: { Authorization: 'Bearer …' }, credentials: 'omit', cache: 'no-store' })` 发起，在 `response.body.getReader()` 上按 `text/event-stream` 格式逐条解析。不使用 `EventSource`。
2. 续接使用 ADR-0001 §5.1 第 2 条的高水位：请求头带 `Last-Event-ID: <stream_position>`。由于不用 `EventSource`，这个头由客户端自己设置。
3. 只用 https。沿用 F-1 的谓词：投影出口不是 https，就不发起实时请求。
4. `credentials: 'omit'`：不带也不接收任何 cookie。令牌是唯一因子（K4），不与 cookie 叠加。

### 4.3 令牌的性质（由中枢签发，Helm 只消费）

1. **作用域只读**：只允许读取快照与订阅增量事件。不能写回、不能决定、不能调用实时层的其他接口。写回仍只经中枢确认队列（ADR-0001 §4.5）。
2. **有效期短**：到期即失效，到期前不续期也不刷新，需要用户重新提供。时长待裁（§7）。
3. **可吊销**：中枢可以随时吊销单个令牌。吊销后下一次请求得到 401，客户端照 §4.1 第 4 条处理。
4. **服务端只存哈希**：与实时层现行做法一致。

### 4.4 投影出口的跨源与页面策略

1. **CORS**：投影出口只对 Helm 页面的源返回 `Access-Control-Allow-Origin`，不用 `*`；允许请求头 `Authorization` 与 `Last-Event-ID`；不返回 `Access-Control-Allow-Credentials`。
2. **CSP**：Helm 页面加 `Content-Security-Policy`。其中 `connect-src` 只列 `'self'` 与投影出口的源，令牌即使被注入脚本读到，也发不到别处。这一条同时推进 #18 SEC-A6，需在接通切片里与 CSP 一并落地。
3. **快照地址不得带令牌**：接通切片在保存快照地址时，若查询串含令牌形态的参数，就拒绝保存并提示（响应 #18 第 5 节第 3 条）。

### 4.5 易用性：每次刷新都要重新提供令牌，这一代价怎样处理

- 这是 K4 加公开静态页的直接后果，也与实时层自家客户端的取舍相同。本 ADR 不规避这一代价，而是让它可承受：
  - **不阻塞**：没有令牌时，快照路径照常工作，所有视图可用；实时通道只是「未连接」，并有明确的连接入口。
  - **输入短**：令牌的输入方式待裁（§7），推荐方案见 §7。
  - **状态诚实**：实时通道的状态单独显示（已连接、未连接、已到期、已吊销），不与快照的 Live 状态混在一起。

## 5. 后果

**正面**
- 令牌不在任何持久介质、URL 或日志里。最坏的泄露情形（页面内存被注入脚本读取）也被只读作用域、短有效期与 CSP 的 `connect-src` 三重收窄。
- 与实时层自家客户端是同一种做法，服务端不需要为 Helm 另开鉴权模式。
- 实时通道与快照通道各自独立失效：实时通道断了，Helm 退回按代拉取，ADR-0001 §5.1 第 7 条照旧成立。

**代价与风险**
- 每次刷新、每次令牌到期都要重新提供令牌，这是确定的易用性代价，见 §4.5。
- 自己实现 SSE 解析（不用 `EventSource`）意味着要自己处理断线重连、心跳超时与半包。接通切片必须为此写测试，覆盖断线、乱序、序号断档后整份重拉。
- 内存中的令牌防不住同页注入脚本。所以 CSP 是接通的前置条件，不是可选项。

## 6. 跟进（本 ADR 不实现）

1. **接通切片**，前置条件是本 ADR 被接受、§7 已裁定：
   - 实时通道的状态与入口；
   - 基于 `fetch` 的 SSE 读取与续接；
   - CSP；
   - 快照地址带令牌时拒绝保存；
   - 测试覆盖断线、401、到期、吊销与序号断档。
2. **中枢侧**：签发只读、短期、可吊销的投影令牌；投影出口的 CORS 配置。这些在仓外，不由 Helm 实现。

## 7. 待裁（推荐方案在先；按组织惯例另开 issue 候中枢裁）

| # | 事项 | 推荐 |
|---|---|---|
| 1 | 令牌有效期 | 12 小时：覆盖一个工作日，过夜即失效 |
| 2 | 令牌输入方式 | 中枢侧生成一次性短码（例如 8 位），Helm 用短码向投影出口换取令牌，令牌只进内存；同时保留粘贴完整令牌的入口作为后备 |
| 3 | Helm 页面的源是否固定（CORS 的允许值） | 只允许 `https://huiiim.github.io`；预览或本地地址不进生产允许列表 |
| 4 | CSP 是否与接通切片同批落地，还是先单独落地 | 先单独落地（不依赖本 ADR，可立即推进 #18 SEC-A6），接通切片只在 `connect-src` 里加投影出口的源 |

## 8. 参考

- ADR-0001 §4.5、§5.1（第 2、7、8 条）、§5.2、§7；#21（汇聚对象已裁定为 `miao-ai` 实时事件层）。
- 本仓：
  - `index.html`：`getSnapshotUrl` 与保存侧的 https 谓词（F-1，#17）；
  - `sw.js`：不缓存 `.json`，只处理 GET。
- #18：第 5 节第 3 条（能力 URL 即凭据）；SEC-A6（CSP）。
- `HUIIIM/miao-ai`（私有，本文只引语义）：
  - `ARCHITECTURE.md`「生产部署口径」节（生产强制鉴权、无凭证路径已切除）与 REST 契约节（Bearer key，只存哈希）；
  - `frontend/src/lib/api.ts`：key 只在内存、刷新即丢；`fetch` 加 `getReader()` 读 SSE，`Authorization: Bearer` 请求头。
- WHATWG HTML，Server-sent events：`EventSource(url, { withCredentials })`，无自定义请求头。https://html.spec.whatwg.org/multipage/server-sent-events.html
- Fetch Standard，`credentials` 与 CORS：https://fetch.spec.whatwg.org/
- OWASP Cheat Sheet，HTML5 Security：Local Storage 不应存放敏感信息。https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html
- W3C Content Security Policy Level 3，`connect-src`：https://www.w3.org/TR/CSP3/
