# 文件存储与上传

[English](storage.md)

本模块用于头像、知识库封面、文档图片和附件。正文编辑器与管理页共用上传接口，正文仅保存稳定资产ID，由资源适配器解析鉴权URL，不保存短时CDN签名链接。

## 环境变量配置

文件存储由必填的 `DOCA_FILE_STORE_ID` 和 `DOCA_FILE_STORES_JSON` 指定。开发环境复制 `.env.example`，示例使用 `./data/v1/storage`；正式镜像显式提供 `/data/storage` 本地存储环境默认值。Compose 要求填写 `docker.env.example` 中的存储变量。数据库只记录稳定存储 ID 和对象引用，不保存后端凭据；管理页只读展示。

```dotenv
DOCA_FILE_STORE_ID=local
DOCA_FILE_STORES_JSON='{"version":1,"stores":{"local":{"provider":"local","root":"/data/storage"}}}'
```

使用服务专用持久化目录，仅服务用户可写，位于静态目录之外。多实例必须共享同一物理后端。备份覆盖数据库、全部被引用的文件存储和受保护的部署配置。被引用的存储 ID 必须持续配置；修改路径或桶不会移动已有字节。

0.1.9 拒绝旧数据库基线、数据库管理的存储配置和旧插件安装清单，保留旧数据，不转换、不迁移。新版使用新空数据库和独立存储，见[发行要求](releases/0.1.9.md)。

## 命名空间与访问

宿主生成对象路径使用 `host/` 前缀，插件创建的常规文件使用 `plugins/<pluginId>/`。插件私有对象使用独立代次和对象路径，不可变安装 ZIP 使用 `host/plugin-releases/<sha256>.zip`。用户文件名不参与物理路径生成。文件和文件夹保持稳定 ID，并遵循宿主授权；GET `/api/v1/assets/:id/content` 检查权限，静态服务不能绕过。见[准确存储实现](unified-storage-implementation.md)。

## S3 与 CDN

`provider:"s3"` 的环境 JSON 配置需要 `bucket`、`region`、`forcePathStyle` 和 `credentials:{accessKeyId,secretAccessKey,sessionToken?}`，可选 `endpoint` 为 HTTPS 根 origin。部署者控制目标和网络出口，管理界面不配置密钥或端点。桶保持私有，凭据只授予宿主和插件对应前缀所需的读写删除权限。配置校验不代表真实连接成功。

可选 `cdn:{domain,keyPairId,privateKey}` 使用 CloudFront 签名 URL 协议。部署私有 S3 源站、OAC 和要求签名的可信密钥组；CDN 保留完整对象 key、Content-Type 和 Content-Disposition。环境变量提供 HTTPS 分配 origin 和 PEM 签名私钥。宿主先检查最新 ACL，再发放 60 秒有效链接。撤权后不再发新链接，已发链接在到期前可能有效；已下载字节无法撤回。

未使用 CDN 时，宿主代理私有云文件，不向浏览器返回存储秘密。其他 CDN 签名协议需要新增适配器，不提供永久公开 URL 降级。密钥轮换需保留被引用的存储 ID 及其字节访问能力；轮换不是数据迁移。

## 校验与权限

- 头像/封面最大5MB，识别PNG、JPEG、WebP、GIF真实文件头并解码；限制2500万像素，移除元数据，转WebP。头像裁为方形(最大512)，封面最大1600宽；GIF仅取首帧。
- 附件最大20MB。可识别的图片会压缩为WebP(最大2400)，其余原样保存为二进制下载。SVG/HTML不作为可执行图片内联展示；普通文件强制 attachment、nosniff、sandbox。未接入病毒扫描。
- 最多4个并发上传、单用户每10分钟最多60次尝试；API也检查最近上传记录。反向代理需额外设置请求体大小、连接数和总存储配额，当前未提供每用户磁盘配额。
- 头像草稿仅上传者可读，绑定后本站登录用户可查看；匿名不可查看。封面遵循知识库ACL，未绑定草稿仅上传者可读；附件遵循文档ACL，系统管理员无阅读特权。封面需要管理者权限、附件需要编辑者权限。
- 上传先落对象，再在事务中复核用户状态/资源权限并登记；登记失败尽力删除未提交对象。编辑封面使用资源version，修改头像使用个人设置version。
- 已完成上传但未绑定的头像/封面草稿暂保留；后台定时孤儿回收、存储配额、病毒扫描和分片上传待补充。异常宕机可能遗留未登记对象，运维清理必须校验所有资产引用，不能按单篇文档删除共享对象。

## 验证边界

自动化覆盖本地上传、私有权限、图片校验、绑定、冲突、稳定存储 ID、插件命名空间和不可变归档完整性。隔离 PostgreSQL 集成及本地双实例浏览器验收已通过。S3 SDK 和 CDN 签名采用模拟，未使用真实云凭据；真实桶上传下载、私有源站封锁、签名过期、撤权、网络失败及备份恢复仍需专项验收。见[浏览器验收报告](storage-browser-acceptance.md)。
