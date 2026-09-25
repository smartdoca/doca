# 已安装插件

把插件 npm 包放进这个目录就能接入，不需要改 Doca 源码。这和 DeepSeek Harness 把插件包放进 profile、由 loader 按包声明挂载的方式相同：框架代码保持不变，安装层单独演进。

每个子目录是一个插件包，目录名就是安装名。包的 `package.json` 用 `doca` 字段声明入口：

```json
{
  "doca": {
    "server": "./src/server/install.ts",
    "web": "./src/web/install.tsx",
    "mobile": "./src/mobile/mail-home.tsx"
  }
}
```

`doca.server` 必须默认导出一个无参函数，返回 Doca 插件。Web 界面放在固定路径 `src/web/install.tsx`，并导出 `bundle`。服务启动时扫描本目录；Web 构建用同一目录收集界面。删掉目录再重启，对应能力就会从路由、搜索、AI 和知识库里消失。

本地邮箱包可以链接进来：

```sh
ln -sfn ../../doca-mail plugins/mail
ln -sfn ../doca/node_modules ../doca-mail/node_modules
```

`plugins.mail: false` 可以在不删除目录时停用名为 `mail` 的安装。
