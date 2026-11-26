# 用户介导的外部文件授权

渲染进程不得持有任意外部文件系统权限。导入、导出和选择目录由主进程统一发放短期、操作受限、范围受限且绑定调用方的外部文件授权；调用方只能以授权标识执行被允许的操作。应用自身配置、日志、缓存和项目内部文件由主进程拥有的目录服务处理，不再通过泛化的 `external` 原始路径接口访问。迁移旧调用点带来的成本换取了可验证、不可绕过的最小权限边界。

## 测试口径

`test/helpers/external-file-read-codes.ts`（注释清理 M30 第 2 个 PR 迁入）：

- `secureFileSystemCodes(files)` 的 `files` 必须取自 `repoSourceFiles('electron/security')`。函数再按 `electron/security` 目录和 `.ts`、`.m`、`.cs`、`.ps1` 扩展名筛一遍，所以传入列表是「安全文件层的全部源码」这一前提由调用方负责。
