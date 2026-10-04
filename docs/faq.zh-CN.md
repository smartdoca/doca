# 常见问题与排障

[English](faq.md)

## 有没有默认管理员密码？

没有。容器健康后执行 `bash scripts/bootstrap-admin.sh`，密码至少 12 位。已有账号需要使用 `bash scripts/reset-admin-password.sh`；初始化不用于重置密码。

## 为什么浏览器不能直接访问 39120 端口？

Compose 把端口绑定到服务器回环地址。生产环境通过反向代理访问 `DOCA_ORIGIN` 配置的 HTTPS 来源，不使用 `http://服务器IP:39120`。检查 DNS、TLS、代理头和 WebSocket 转发，详见[部署说明](deployment.zh-CN.md)。

## 应该复制哪个环境变量示例？

已发布 Docker 镜像使用 `docker.env.example`，源码开发使用 `.env.example`。启动 Compose 前配置 `DOCA_ORIGIN`、`DOCA_FILE_STORE_ID` 和 `DOCA_FILE_STORES_JSON`，详见[配置说明](configuration.zh-CN.md)。

## 为什么返回 421、403，或者编辑器断开？

421 通常表示请求 Host 与配置来源不匹配。写请求要求同源 Origin，不匹配会返回 403。编辑还需要授权，以及 `/api/v1/ws` 正常的 WebSocket 升级。检查浏览器地址、代理配置、账号状态和当前资源权限。

## 数据库基线被拒绝时怎么办？

停止操作并阅读对应[发行要求](releases/0.1.10.zh-CN.md)。Doca 0.1.10 不自动迁移旧数据库。保留旧部署、数据库、文件和密钥用于回退，不删除表、不重置数据卷、不修改基线标记来强行启动。

## 怎样排查启动失败？

```sh
docker compose config --quiet
docker compose ps
docker compose logs --tail=100 doca
curl -fsS -H 'Host: doca.example.com' http://127.0.0.1:39120/health
```

在服务器上、包含 `compose.yaml` 的检出目录执行。不要公开含密钥的日志。源码开发使用 `http://127.0.0.1:39130` 和开发配置。

## GitHub Pages 和 Doca 应用是同一种部署吗？

GitHub Pages 托管这套静态文档网站。Doca 应用需要容器或服务器、数据库、持久文件和 HTTPS 代理。更新文档站不会启动或升级 Doca 应用。

## 更新或重启会删除文件吗？

普通 `docker compose restart` 保留持久卷，配置变更通过 `docker compose up -d` 应用。更换镜像版本前阅读发行说明，并备份全部数据库、被引用的文件存储和受保护的配置。不要执行会删除数据卷的 `docker compose down -v`。

## 插件或外部服务为什么不可用？

插件包需满足当前 SDK 和存储契约。安装状态变化后，逐个手动重启全部实例。使用加密凭证的插件要求所有副本持有同一个持久主密钥。AI、SSO、搜索及云存储是否可用还取决于真实凭据和网络，源码测试不能代替真实服务验收。详见[插件部署](plugin-deployment.zh-CN.md)。

上面的健康检查需替换为实际配置的主机名；421 表示 Host 不匹配，回环探测也需正确 Host。默认不信任任何代理；代理 IP 共享限流时应准确配置 `DOCA_TRUST_PROXY`。
