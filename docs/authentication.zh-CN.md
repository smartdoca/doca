# 身份认证、注册审批与账号绑定

[English](authentication.md)

适用于当前无空间、无组织架构的轻量 Doca。本文同时说明本地账号、外部身份源、注册审批和登录方式切换规则。

## 产品边界与调研结论

一个 Doca 用户可绑定多种登录身份；文档、权限、头像和偏好始终归属稳定的 `users.id`。不按邮箱、昵称或手机号自动合并账号，必须先登录原账号，再主动绑定。

参考 [Better Auth 的账号关联设计](https://better-auth.com/docs/concepts/users-accounts)，将用户资料与登录身份分离，但采用显式绑定，不启用隐式邮箱关联。参考 [authentik User Write stage](https://docs.goauthentik.io/add-secure-apps/flows-stages/stages/user_write/) 将创建与激活账号分开，支持待审核状态。这些是设计参考，没有迁移现有账号到 Better Auth，也未依赖 authentik 服务。

后台采用独立全页外壳：自己的导航、内容滚动区、返回工作台入口，不再嵌套文档工作区。账号设置也采用独立导航。结构参考 [shadcn/ui Dashboard](https://ui.shadcn.com/examples/dashboard) 的侧栏与分区、[表单指南](https://ui.shadcn.com/docs/forms) 的分组与反馈，保留 Doca 的飞书风格配色及自定义选择框，不替换组件库。

## 三类注册策略

「管理员后台 → 登录与注册」分别设置：

| 入口 | 不允许新用户加入 | 自动注册 | 需要审批 |
| --- | --- | --- | --- |
| 本站账号密码 | 关闭注册入口 | 注册后直接登录 | 创建 pending 用户 |
| 企业 OIDC SSO | 只允许已绑定身份登录 | 首次登录创建用户 | 首次登录创建 pending 用户 |
| Google/GitHub/微信/QQ | 只允许已绑定身份登录 | 首次登录创建用户 | 首次登录创建 pending 用户 |

已有绑定的 active 用户不受“关闭注册”影响，已有用户仍可绑定身份。管理员手动创建的用户直接 active。待审核用户没有本站会话，不能访问文档或 WebSocket。管理员在用户页筛选“待审核”并批准，或拒绝并停用。审批通过后需重新登录，不激活旧授权流程。

默认不开启外部注册或任何身份源。保留账号密码入口，避免身份源故障导致管理员无法登录。本轮已增加联系方式验证、手机验证码登录与密码恢复；验证码发送和尝试限制使用共享数据库，密码登录等原有限流仍为单进程。短信单独配置准入规则，第三方来源可单独覆盖类别策略。

登录方式切换时，服务端会按启用状态、已验证联系方式、密码账号标识和身份源凭据逐个检查所有 active 用户及管理员。只要有人在修改后没有可用方式，就拒绝保存。管理员可以先在“强制用户补充登录方式”中选择新方式；用户下次打开时必须完成验证或绑定，全部完成后再关闭旧方式。仅新增方式时默认不强制。

## 支持的身份源

- **OIDC SSO**：标准 Discovery，可接 Keycloak、authentik 等。采用 `openid-client` 6.8.8，授权码 + PKCE S256、state、nonce，启用 ID Token 签名校验及 issuer/audience/时效校验。参考 [openid-client](https://github.com/panva/openid-client)。客户端认证使用 `client_secret_post`，暂不支持私钥 JWT、mTLS、SAML；纯 OAuth2 不能当作 OIDC 配置。
- **Google**：固定 `https://accounts.google.com` Discovery，`openid profile`，声明邮箱来源时额外申请邮箱权限。参考 [Google OIDC 文档](https://developers.google.com/identity/openid-connect/reference)。
- **GitHub**：授权码 + PKCE S256，`read:user`，通过 `/user` 获取稳定数字 ID；声明邮箱来源时增加 `user:email` 并读取已验证主邮箱。参考 [GitHub OAuth 官方文档](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)。
- **微信**：网站扫码 `snsapi_login`，以 App ID 下的 OpenID 绑定，不用 UnionID 自动合并。不是公众号网页授权、小程序或移动 App 登录。
- **QQ**：网站 OAuth；token / me 用 JSON 格式，再读取用户资料；验证 `me.client_id` 与配置一致。路径与格式参考 [SocialiteProviders QQ 开源实现](https://github.com/SocialiteProviders/QQ/blob/master/Provider.php)。

微信/QQ 官方开发文档本次访问受限；适配器已实现并使用模拟响应测试，**未完成真实平台验收**。所有外部身份源都需部署方申请应用和凭据；网站资质、域名审核及授权范围以平台控制台当前要求为准。微信/QQ 此流程不发送 PKCE，不能等同 OIDC 的 PKCE 能力。

当前只实现 SSO 客户端。Doca 作为 OIDC 提供方、SAML、全局 SSO 退出/撤销同步尚未实现。身份源禁用账号不会自动撤销 Doca 已签发的 8 小时会话，需本站管理员停用，或后续接入 IdP 生命周期事件。

## 部署步骤

1. 在各平台注册应用。生产使用固定 HTTPS `DOCA_ORIGIN`，代理保留已配置的 Host。
2. 在「平台设置 → 服务凭据 → SSO 认证」添加凭据名称和 Client Secret，设置自定义 SSO 允许来源。密钥保存在数据库，保存后生效，不回显。

3. 添加身份源，填写显示名、Issuer（仅 OIDC）、Client/App ID 和凭据标识。先保持关闭，保存取得回调地址。
4. 原样填入平台回调白名单：`https://doca.example.com/api/v1/auth/providers/<UUID>/callback`。每个身份源独立地址，不支持任意返回 URL。
5. 配置注册策略并启用。在个人信息页面绑定或退出后测试登录。验证完成前保留原管理员登录方式。

Google/GitHub/微信/QQ 的固定 HTTPS 域名内置允许。OIDC Issuer 及 Discovery 返回的授权、token、JWKS 等所有域名必须加入 服务凭据页的「自定义 SSO 允许来源」（完整 origin，每行一个）。禁止网络重定向，即使自建身份源也要求 HTTPS。白名单由部署者维护，须配合网络出口策略，不要信任可变的不可信 DNS 或开放任意内网地址。

类型、Issuer、Client ID 是不可修改的命名空间。更换发行者或应用时新建身份源，让用户主动绑定，不把原 ID 指向另一身份源。修改名称、凭据标识和启停状态使用 version 乐观锁，使旧授权流程失效。停用身份源可能让仅绑定该来源的用户无法再次登录，应先安排替代绑定。新增登录方式默认不强制用户使用；只有准备替换旧方式时，管理员才应设置“强制用户补充登录方式”，待用户完成补充后再关闭旧方式。

## 安全流程

1. 同源 POST 发起；随机 state、浏览器流程凭据、nonce、PKCE verifier。绑定要求先完成管理员配置的独立安全验证，凭证五分钟内单次有效。
2. 存储 state 和浏览器凭据的哈希及十分钟流程；流程 Cookie 为 HttpOnly/SameSite=Lax，主 Cookie 保持 HttpOnly/SameSite=Strict，HTTPS 下加 Secure。
3. 回调验证对应 provider、state、浏览器凭据，原子认领一次并校验授权身份。日志不记录回调查询参数、code、token、提供方错误正文。
4. 固定重定向 `/#/auth/complete`，前端同源 POST 完成，恢复 Strict 主会话。绑定必须仍为最初发起的用户和同一个会话，且独立安全验证凭证仍有效。
5. 事务消费流程，检查 provider 版本、唯一身份归属、注册策略与用户状态。pending 不发会话，active 只发 Doca 会话。

不持久化第三方 access/refresh token；仅保存 subject、当时显示名与关联信息。来源声明的HTTPS头像URL可用于展示，服务端不盲目抓取；用户上传头像仍走本站资源存储。

解绑须最近验证，不能移除最后一种**可用**方式，停用/缺凭据的提供方不计入保底。无密码账号可经最近验证首次设置本站密码；已有密码走原修改密码流程。公开用户ID与本地登录名统一为有意义的唯一字符串；来源未提供合适的用户ID时必须补全，不再生成UUID名称。内部用户UUID保持稳定。

## 数据库

当前数据库基线包含以下身份结构（不会自动创建用户或重置密码）：

- `settings.registration_review`：本地注册审批开关，配合原 registration；sso_registration/social_registration 为 closed/auto/approval。共享 revision 乐观锁。
- `account_flows`：保存单次安全验证凭证；会话不承担安全验证证明职责。
- `auth_providers`：配置、不可变命名空间、version；不存密钥。唯一 type+issuer+client_id。
- `auth_identities`：user_id → provider_id + subject。唯一 provider_id+subject 防抢绑；唯一 user_id+provider_id 限同一用户在同一身份源绑定一个身份。
- `auth_flows`：十分钟单次流程，stage 为 started/exchanging/verified，完成删除，过期在发起新流程时清理。

## HTTP 接口

前缀 `/api/v1`，写请求需匹配 Origin：

| 接口 | 权限与行为 |
| --- | --- |
| GET /auth/providers | 公共；仅启用且凭据就绪的 id/name/type |
| GET /admin/auth | 管理员；三类策略、revision、身份源、就绪状态、回调地址，无密钥 |
| GET/PUT /admin/accounts/policy | 管理员；账号密码、手机/邮箱登录、密码账号类型及 `forcedLoginMethod`，保存时校验所有 active 用户至少保留一种可用方式 |
| PUT /admin/auth/policy | 管理员；`{revision,local,sso,social}`，值 closed/auto/approval |
| POST /admin/auth/providers | 管理员；`{type,name,issuer,client_id,credential_ref,enabled,version:0}`，enabled 为 0/1 |
| PUT /admin/auth/providers/:id | 管理员；同上，version 取当前值，不可变字段不可改 |
| POST /auth/providers/:id/start | `{intent:"login"\|"link"\|"security"\|"replace"}` → `{url}` 与流程 Cookie；link 需最近验证 |
| GET /auth/providers/:id/callback | 授权回调，交换和校验身份，固定同源重定向 |
| POST /auth/complete | 消费验证流程，返回 status active/linked/pending，active 签发会话 |
| GET /me/identities | 登录；本地登录名、是否有密码、绑定及可用状态，无 subject/token |
| POST /auth/reauth | 登录；`{password}` 更新当前会话最近验证时间 |
| POST /auth/password/setup | 最近验证；`{password}` 12–128字符，仅首次设置，撤销其他会话 |
| DELETE /me/identities/:id | 最近验证；解绑本人身份，保护最后可用方式 |
| GET /admin/users?status=pending | 管理员；active/pending/disabled 过滤和分页 |
| PATCH /admin/users/:id | 管理员；status active 批准、disabled 拒绝或停用并撤销会话 |

`POST /auth/register` 响应增加 status，pending 时提示等待审核，不自动登录。

## 测试与待验收项

`tests/identity.test.ts` 使用 RSA 签名的模拟 OIDC 响应，走真实 openid-client 校验路径，覆盖 PKCE、签名、nonce、issuer、Cookie、重复/过期回调、会话绑定、策略、审批、解绑。各社交适配器使用模拟 HTTP，不代表平台应用审核或公网联调通过。

SQLite 与隔离 PostgreSQL 实库均按当前建表定义运行完整回归。真实身份源、HTTPS 代理部署和账号恢复能力需单独验收。

## 2026-09 模块重构补充

身份领域位于 `packages/core/src/modules/identity`，协议适配位于 `apps/server/src/adapters/identity-providers.ts`。新增自定义 OAuth 2.0 授权码/PKCE 适配，支持配置端点及稳定身份字段，仍受 HTTPS 白名单约束。该适配与 OIDC 独立，不把普通 OAuth token 当作 ID Token。

每个来源的 `profile_config` 声明注册字段、来源、可修改与同步规则。资料不完整时 `/auth/complete` 返回 `needs_profile`，不创建完整会话；提交所需资料和联系方式验证凭证后继续注册或审批。用户名唯一约束和 provider+subject 身份绑定独立，重名不合并账号。自定义协议配置创建后不可重新指向其他身份命名空间。
