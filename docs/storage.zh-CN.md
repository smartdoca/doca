# 文件存储与上传

[English](storage.md)

本模块用于头像、知识库封面、文档图片和附件。正文编辑器与管理页共用上传接口，正文仅保存稳定资产ID，由资源适配器解析鉴权URL，不保存短时CDN签名链接。

## 环境变量配置

文件存储由必填的 `DOCA_FILE_STORE_ID` 和 `DOCA_FILE_STORES_JSON` 指定。两份环境示例均使用 `/data/storage`，与正式镜像的持久数据卷一致。源码开发时复制 `.env.example`，把本地 root 改为本机可写的绝对路径。Compose 使用 `docker.env.example`。数据库只记录稳定存储 ID 和对象引用，不保存后端凭据；管理页只读展示。

```dotenv
DOCA_FILE_STORE_ID=local
DOCA_FILE_STORES_JSON='{"version":1,"stores":{"local":{"provider":"local","root":"/data/storage"}}}'
```

使用服务专用持久化目录，仅服务用户可写，位于静态目录之外。多实例必须共享同一物理后端。备份覆盖数据库、全部被引用的文件存储和受保护的部署配置。被引用的存储 ID 必须持续配置；修改路径或桶不会移动已有字节。

0.1.10 拒绝旧数据库基线、数据库管理的存储配置和旧插件安装清单，保留旧数据，不转换、不迁移。新版使用新空数据库和独立存储，见[发行要求](releases/0.1.10.zh-CN.md)。

## Docker 上传报 EACCES

如果 `/api/v1/assets` 返回 HTTP 500，容器日志显示 `EACCES: permission denied, mkdir '/app/data'`，检查 `DOCA_FILE_STORES_JSON` 中当前本地存储的 `root`。镜像以 `node` 用户运行，工作目录为 `/app`；Compose 把持久数据卷挂载在 `/data`。开发配置的 `./data/v1/storage` 会解析成 `/app/data/v1/storage`，位于可写数据卷之外。

如果这个存储从未保存过成功上传的文件，把它的 root 设置为 `/data/storage`，保留原存储 ID 和其他存储条目。只重建应用容器，使环境变量修改生效：

```sh
docker compose up -d --no-deps --force-recreate --pull never --no-build doca
```

如果存储已有文件，修改 root 前先检查并备份实际目录和数据库，约定保留对象字节及其原有 key 的路径方案，再验证旧文件下载和新文件上传。修改配置不会移动文件。不要通过删除数据卷或重置数据库修复路径、权限问题。

## 命名空间与访问

宿主生成对象路径使用 `host/` 前缀，插件创建的常规文件使用 `plugins/<pluginId>/`。插件私有对象使用独立代次和对象路径，不可变安装 ZIP 使用 `host/plugin-releases/<sha256>.zip`。用户文件名不参与物理路径生成。文件和文件夹保持稳定 ID，并遵循宿主授权；GET `/api/v1/assets/:id/content` 检查权限，静态服务不能绕过。见[准确存储实现](unified-storage-implementation.md)。

## S3 与 CDN

`provider:"s3"` 的环境 JSON 配置需要 `bucket`、`region`、`forcePathStyle` 和 `credentials:{accessKeyId,secretAccessKey,sessionToken?}`，可选 `endpoint` 为 HTTP(S) 根 origin，不带账号密码、子路径、查询参数或片段。HTTP 用于部署者显式配置的可信内网端点；应用不会解析 DNS 来自动判定目标是否为内网。部署者控制目标和网络出口，管理界面不配置密钥或端点。桶保持私有，凭据只授予宿主和插件对应前缀所需的读写删除权限。配置校验不代表真实连接成功。

RustFS 与 Doca 位于共享容器网络时，先创建私有桶，再配置 S3 API 监听器（默认端口 `9000`，控制台为 `9001`），启用路径式寻址。`region` 与 `RUSTFS_REGION` 一致，默认 `us-east-1`：

```dotenv
DOCA_FILE_STORE_ID=cloud
DOCA_FILE_STORES_JSON='{"version":1,"stores":{"cloud":{"provider":"s3","bucket":"doca-files","region":"us-east-1","endpoint":"http://rustfs:9000","forcePathStyle":true,"credentials":{"accessKeyId":"replace-me","secretAccessKey":"replace-me"}}}}'
```

使用 Doca 容器可访问的主机名或内网地址。站点、静态资源和 CDN 来源也支持 HTTP(S)。见 [RustFS S3 文档](https://docs.rustfs.com/zh/administration/protocols/s3)。示例用于新安装，修改已有存储的端点不会搬运对象。

可选 `cdn:{domain,keyPairId,privateKey}` 使用 CloudFront 签名 URL 协议。部署私有 S3 源站、OAC 和要求签名的可信密钥组；CDN 保留完整对象 key、Content-Type 和 Content-Disposition。环境变量提供 HTTP(S) 分配 origin 和 PEM 签名私钥。宿主先检查最新 ACL，再发放 60 秒有效链接。撤权后不再发新链接，已发链接在到期前可能有效；已下载字节无法撤回。

未使用 CDN 时，宿主代理私有云文件，不向浏览器返回存储秘密。其他 CDN 签名协议需要新增适配器，不提供永久公开 URL 降级。密钥轮换需保留被引用的存储 ID 及其字节访问能力；轮换不是数据迁移。

## 图片的浏览器缓存与文件 CDN

文档正文、评论中的普通图片，以及由宿主代理的头像、封面，通过稳定的 `/api/v1/assets/:id/content` 地址缓存。成功的内联图片响应（包括缩略图）返回：

```http
Cache-Control: private, max-age=3600, must-revalidate
Vary: Cookie, Authorization
ETag: W/"对象及变体的标识摘要"
```

浏览器可以在一小时内复用本机缓存；过期后发送 `If-None-Match`，宿主先核对当前权限，再对相同对象返回 `304`，不再传图片字节。原图和缩略图具有不同 ETag。对象 key 不可变，替换图片需要上传新资产。账号切换后 Cookie/Authorization 变化会选择另一份缓存；缓存有效期内不会再次核对撤权，已下载字节无法撤回。浏览器可能因空间不足、用户清理、强制刷新或“Disable cache”提前丢弃缓存。这里使用 HTTP 缓存，不额外建立 IndexedDB 或 Service Worker 副本。`no-cache` 表示重新验证，`no-store` 表示不保存，区别见 [MDN 缓存指南](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Caching)。

AI 对话附件、`download=1`、回收站预览及错误响应仍使用 `no-store`，不应用上述缓存策略。即使带有效 ETag，未获授权的请求也不能获得 `304`。文档正文图片具有 resourceId，当前始终由宿主代理；开启 S3 文件 CDN 不会把这些图片自动改成公开地址。

文件 CDN 的签名跳转保持 `no-store`，避免浏览器重复使用过期的 60 秒签名。CDN 最终文件响应的 header 必须配置在文件 CDN 或 S3 源站；Doca 跳转响应上的 header 不会传给最终响应。新上传的 S3 对象元数据当前为 `Cache-Control: private, max-age=60`；已有对象的元数据不会由本次修复批量改写。

CloudFront 中，对受保护文件的 behavior 使用私有 S3 origin/OAC 和可信密钥组。沿用 60 秒签名限制，在 **Response headers policy → Custom headers** 中设置 `Cache-Control: private, max-age=60, must-revalidate` 并启用 **Override**，为新旧对象统一最终浏览器响应。不要给整站或 `/api/*` 套用公开长期缓存。未单独规划边缘缓存时，使用 **CachingDisabled**；定制策略的 Minimum TTL 必须是 0。AWS 指出，正数 Minimum TTL 可以覆盖源站的 `private/no-store`。Response headers policy 控制浏览器响应，不控制边缘 TTL；两者要分别设置。见 [响应头策略](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/modifying-response-headers.html)、[缓存策略 TTL](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cache-key-understand-cache-policy.html)和[签名 URL](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-signed-urls.html)。

签名 URL 的查询参数变化后，浏览器会将其作为不同地址，设置 header 不能保证跨签名复用本机缓存。稳定的文档图片接口没有这个问题。文件 CDN 的边缘命中率与浏览器缓存命中率也不是同一个指标。

验收时关闭 DevTools 的 **Disable cache**，连续打开同一文档：一小时内图片应显示 memory/disk cache；手动请求条件读取应为 `304`，没有图片响应体。再测试退出账号、撤权、缩略图、下载和回收站预览。CDN 跳转需同时检查跳转响应与最终响应：

```sh
# 只检查响应头。使用有权限的会话；不要把 Cookie 或签名贴到公共日志。
curl -I -H 'Cookie: doca_session=<会话>' https://doca.example.com/api/v1/assets/<资产ID>/content
curl -I -H 'Cookie: doca_session=<会话>' -H 'If-None-Match: W/"<首次响应的摘要>"' https://doca.example.com/api/v1/assets/<资产ID>/content
curl -I 'https://files.example.com/<对象key>?<有效签名参数>'
```

JS/CSS 静态 CDN 的一年缓存配置见[部署：静态资源](deployment.zh-CN.md#静态资源)，不要将文件 CDN 的私有短期策略套给带内容哈希的公开构建文件。

## 历史快照存储与显式升级

最近 20 个完整业务快照保存在数据库，旧快照每凑满 10 个只保留其中最新 1 个到配置的文件存储，S3 模式下为云存储。每个长期保留点是独立 gzip JSON 文件，原样保存 checkpoint 和独立恢复信息，并在数据库记录一个小索引。只在上传与读回 SHA-256 校验成功后，事务性地登记索引、清理这一组完整数据库记录；另外九个快照按已确认规则抽稀，不再提供回滚。未满十个或存储故障时保留数据库原件。列表统一合并两个来源，不显示存储类型、对象 key 或签名地址。

协作 checkpoint、未覆盖增量与附件不参与抽稀。回收站保留历史，显式永久删除文档后才排队清理归档文件；文件清理延迟一小时并复核无有效引用。归档不重新解码、补全或转换旧 recovery_json。缺少恢复信息或不支持的恢复版本继续拒绝预览。文件只接受 envelope v1，并验证文件哈希、解压上限及索引一致性。正文提交不等待转存，后台持久任务失败后会重试。

数据库新基线为 `doca-2026-10-09-history-storage-v1`；正常启动不兼容读取旧基线。升级只接受上一基线 `doca-2026-10-08-knowledge-books-v2`。先停止全部宿主实例，备份数据库、文件存储及配置，再运行：

```sh
pnpm history:upgrade                 # 显示要求，不修改数据
pnpm history:upgrade --apply         # 显式增加结构、更新基线、排队转存；不立即抽稀
```

不要用重建数据库代替升级。升级事务失败时原数据库保持不变。回退到上一宿主前，停止全部实例并导回已经保留的文件快照：

```sh
pnpm history:rollback --apply --manifest /backup/history-cloud-references.json
```

清单路径必须是新文件，权限为 0600。回退先保存云文件引用清单，再逐条验证导回保留点，最后恢复上一基线；云文件继续保留。中断状态使用专门基线标记，宿主拒绝启动，避免部分导回的保留点被再次抽稀；修复存储问题后，用新的清单路径重跑回退命令。不能恢复已抽稀的九个版本；需要这些版本时还原抽稀前的完整数据库备份。用户在快照列表中的回滚仍沿用当前 epoch 与权限/expectedSeq 校验，富文本和 Markdown 支持恢复，其余格式仍仅预览。

## 校验与权限

- 头像/封面最大5MB，识别PNG、JPEG、WebP、GIF真实文件头并解码；限制2500万像素，移除元数据，转WebP。头像裁为方形(最大512)，封面最大1600宽；GIF仅取首帧。
- 文档/AI 附件上传最大 20 MiB，保留原字节；可识别的栅格图片需通过 2500 万像素限制校验。头像、封面、评论图片按各自用途归一化为 WebP。普通用户文件使用独立流式上传 API，最大 2 GiB。SVG/HTML不作为可执行图片内联展示；普通文件强制 attachment、nosniff、sandbox。未接入病毒扫描。
- 最多4个并发上传、单用户每10分钟最多60次尝试；API也检查最近上传记录。反向代理需额外设置请求体大小、连接数和总存储配额，当前未提供每用户磁盘配额。
- 头像草稿仅上传者可读，绑定后本站登录用户可查看；匿名不可查看。封面遵循知识库ACL，未绑定草稿仅上传者可读；附件遵循文档ACL，系统管理员无阅读特权。封面需要管理者权限、附件需要编辑者权限。
- 上传先落对象，再在事务中复核用户状态/资源权限并登记；登记失败尽力删除未提交对象。编辑封面使用资源version，修改头像使用个人设置version。
- 已完成上传但未绑定的头像/封面草稿暂保留；资产草稿定时回收、每用户存储配额和病毒扫描待补充。普通用户文件已支持 S3 分片上传，32 MiB 起采用 8 MiB 分片；与限大小的资产接口分开。异常宕机可能遗留未登记对象，运维清理必须校验所有资产引用，不能按单篇文档删除共享对象。

## 验证边界

自动化覆盖本地上传、私有权限、图片校验、绑定、冲突、稳定存储 ID、插件命名空间和不可变归档完整性。隔离 PostgreSQL 集成及本地双实例浏览器验收已通过。S3 SDK 和 CDN 签名采用模拟，未使用真实云凭据；真实桶上传下载、私有源站封锁、签名过期、撤权、网络失败及备份恢复仍需专项验收。见[浏览器验收报告](storage-browser-acceptance.md)。
