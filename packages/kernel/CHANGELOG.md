# @fraqjs/kernel

## 1.1.0

### Minor Changes

- c542817: 将 random、hono、webui-gateway 和 kysely 迁移为基于 `@fraqjs/kernel` 的 common plugin，并让通用插件上下文支持 `timeout` 与 `interval`
- b832066: 将 `timeout` 和 `interval` 集成到 `@fraqjs/kernel`
- 3a0704a: 将日志系统集成到 `@fraqjs/kernel`，并引入 `ctx.logBus` 作为事件总线

## 1.0.0

### Major Changes

- c19c38e: 这是 Fraq 的第一个正式版，包含了已经稳定的 API。从 v1.0.0 开始，@fraqjs 下所有包将同步版本号。
