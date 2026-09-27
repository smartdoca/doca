# 当前编辑器制品

此目录只保存根 `package.json` 当前通过 `file:vendor/...` 使用的五个编辑器制品：

- `slatetsx-kit-editor-0.4.9-86c014f2fc80.tgz`
- `online-office-univer-sheet-0.2.0-rc.16-d48ab0b71a5e.tgz`
- `exmd-collaborative-editor-0.4.2-2dd09320cab1.tgz`
- `aidcanvas-0.4.1-d8369bbd0e5c.tgz`
- `eppt-editor-0.3.0-alpha.1-d4d2631fccd4.tgz`

仓库不保存旧版本制品、升级恢复夹具或旧编码兼容测试。替换编辑器时直接更新当前制品、`package.json` 与锁文件；项目数据库和测试数据按新的当前基线重新创建。

这些本地制品是正式依赖，必须随代码提交。临时打包产物、截图、日志和验收输出放在被忽略的 `.local/` 或 `docs/local/`。
