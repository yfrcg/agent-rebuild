# Checklist

## WS Client SDK

- [ ] `packages/ws-client` 包结构完整（package.json、tsconfig.json、src/index.ts）
- [ ] 类型从 `protocol.ts` 共享，前端不重新定义事件类型
- [ ] 连接管理器支持 `connect` 握手（protocolVersion: "1.0", clientName）
- [ ] 指数退避重连（初始 1s，最大 30s，含 jitter）
- [ ] 认证失败不重试，其他失败退避重试
- [ ] 请求 ID 全局唯一（`web_${method}_${timestamp}_${shortId}`）
- [ ] Promise Map 正确处理 resolve/reject/timeout
- [ ] 副作用方法自动注入 `idempotencyKey`
- [ ] 连接断开时 reject 所有 pending 请求
- [ ] `chat.delta` 批处理（30-80ms）
- [ ] `state.resync_required` 自动触发 resync
- [ ] 事件 listener 类型安全（`on("chat.delta", handler)`）
- [ ] 断线恢复：`lastSeq` 持久化、`session.getTranscript` 补发、`audit.tail` gap 补齐
- [ ] Token 不进入日志、不进入 localStorage 明文
- [ ] ws-client 单元测试覆盖连接/请求/事件/恢复/幂等

## Web UI 基础

- [ ] Vite + React + TypeScript 项目初始化
- [ ] 四区域布局骨架（左 session、中 chat、右 timeline、顶 status bar）
- [ ] 五个 store 实现（connection/session/run/event/approval）
- [ ] Run 状态机七状态正确实现
- [ ] 状态不可逆保护（completed/cancelled/failed 不可覆盖）

## 核心页面

- [ ] Session Workspace：list/create/get/bindProject
- [ ] Run Console：send/delta/completed/cancel + transcript 历史
- [ ] Tool Timeline：纵向事件流、按 seq 排序、支持过滤、payload 折叠
- [ ] Approval Center：list/confirm/reject + 过期检查
- [ ] Memory Panel：search + write（只提供 content/scope）
- [ ] Gateway Dashboard：runtime.status + ws.metrics
- [ ] Audit Panel：audit.tail、默认摘要、REDACTED

## 安全

- [ ] Origin 白名单检查
- [ ] Memory write 不构造任意路径
- [ ] Tool denied 不自动重试
- [ ] Audit 只显示 redacted 数据

## 视觉设计

- [ ] 深色控制台主题
- [ ] 状态色正确（running 蓝、success 绿、warning 琥珀、denied 红、cancelled 灰）
- [ ] monospace 字体用于代码和 payload
- [ ] 移动端适配

## 集成验证

- [ ] 与真实 Gateway WS 端到端测试通过
- [ ] 断线恢复验证通过
- [ ] 多 session 并发验证通过
- [ ] TypeScript 编译零错误
