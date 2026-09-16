# @fraqjs/cli

## 1.1.1

### Patch Changes

- 8de7206: 将 cli-integration 插件（若有）的版本绑定到自身版本
- d61eda9: 实现配置文件树编辑器
- Updated dependencies [d61eda9]
  - @fraqjs/cli-protocol@1.1.1

## 1.1.0

### Minor Changes

- fb53d1e: 实现可恢复的 watch 模式，启动失败后自动回滚到上一个启动成功的配置
- 2fefab0: 实现 cli-integration 插件，通过 WebUI 管理 Fraq CLI

### Patch Changes

- Updated dependencies [2fefab0]
  - @fraqjs/cli-protocol@1.1.0
  - @fraqjs/kernel@1.1.1

## 1.0.1

### Patch Changes

- 634a76c: 从 Fraq 版本推断 @fraqjs/color-log 的版本，而非锁定在 0.2.0.

## 1.0.0

### Major Changes

- c19c38e: 这是 Fraq 的第一个正式版，包含了已经稳定的 API。从 v1.0.0 开始，@fraqjs 下所有包将同步版本号。

### Patch Changes

- Updated dependencies [c19c38e]
  - @fraqjs/kernel@1.0.0
