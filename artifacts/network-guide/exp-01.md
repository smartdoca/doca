# 从DNS到TLS到HTTP的全链路排障实验 (Exp-01)

## 学习目标
1. 掌握DNS（RFC1034）、TLS 1.3（RFC8446）、HTTP/1.1语义（RFC9110）三层协议的标准交互逻辑，区分**必需行为**与**可选行为**
2. 能够使用dig、Wireshark、openssl、curl等工具分层定位网络故障，隔离各层异常对端到端通信的影响
3. 通过故障注入实验，验证各层协议关键字段的正确性，理解协议规范对故障排查的指导作用
4. 建立全链路排障思维，掌握“从应用层向下逐层验证”的调试方法论

---

## 核心协议机制与关键字段解析
### 1. DNS层（RFC1034 核心规范，Section 3、4、5）
DNS是分布式分层名称空间，核心功能为“域名-IP映射”，分为**解析器（Resolver）**和**名称服务器（Name Server）**两个角色：
- 必需行为：
  - 递归解析器需遵循“根服务器→顶级域（TLD）服务器→二级域权威服务器”的层级迭代查询流程（RFC1034 5.3）
  - 名称服务器必须响应标准查询，响应码（RCODE）需严格遵循规范：0=成功，2=服务器失败（SERVFAIL），3=域名不存在（NXDOMAIN）
- 可选行为：递归查询（Resolver可选择向本地DNS服务器发送递归查询，由服务器完成迭代）；本地缓存：RFC1034 5.4建议所有DNS响应均可缓存，RFC2308明确要求**否定响应（NXDOMAIN/NODATA）的缓存是Resolver的必需行为**，否定响应的缓存TTL取值为SOA记录自身的TTL与SOA记录中MINIMUM字段值的最小值，这是DNS否定缓存排障的核心依据

**关键报文字段（DNS头部）**
| 字段 | 二进制位置 | 含义 | 必需性 |
|------|------------|------|--------|
| QR | 第1位（bit15） | 0=查询，1=响应 | 必需 |
| Opcode | 第2-5位（bit11-14） | 0=标准查询，1=反向查询等 | 必需 |
| RCODE | 第6-9位（bit0-3） | 响应状态码 | 必需 |
| QNAME | 变长 | 查询的域名（按标签拆分，以0结尾） | 必需 |
| QTYPE | 2字节 | 查询类型（1=A（IPv4），28=AAAA（IPv6）） | 必需 |

**推演例子**：执行`dig @8.8.8.8 www.example.com A`，预期响应的Answer段包含`www.example.com.	86400	IN	A	93.184.216.34`，其中RCODE为0表示成功；若返回`NXDOMAIN`则说明域名未注册，`SERVFAIL`表示本地DNS服务器无法完成迭代查询。

### 2. TLS层（RFC8446 TLS 1.3，Section 4）
TLS 1.3将握手流程简化为1-RTT，核心交互为**ClientHello→ServerHello→EncryptedExtensions→Certificate→CertificateVerify→Finished**，取消了旧版本的密钥交换流程（如RSA密钥交换）：
- 必需行为：
  - ClientHello必须携带`SNI`（Server Name Indication）扩展（RFC8446 4.2.3），用于服务器选择匹配域名的证书
  - ServerHello必须选择双方支持的密码套件（如TLS_AES_256_GCM_SHA384），且版本必须为0x0304（TLS1.3的版本标识）
  - Finished消息是第一条加密的握手消息，其`verify_data`需匹配握手哈希，用于验证完整性
- 可选行为：0-RTT会话恢复、客户端认证（需额外证书）

**关键报文字段（以ClientHello为例）**
| 扩展/字段 | 类型 | 含义 | 必需性 |
|-----------|------|------|--------|
| supported_versions | 扩展 | 客户端支持的TLS版本列表 | 必需（TLS1.3强制） |
| server_name | 扩展 | SNI域名值（如"www.example.com"） | 必需（多域名证书场景） |
| cipher_suites | 列表 | 客户端支持的密码套件 | 必需 |

**推演例子**：使用`openssl s_client -connect www.example.com:443`，若ClientHello的`server_name`扩展为`www.example.com`，ServerHello的`cipher suite`为`TLS_AES_256_GCM_SHA384`，则TLS层握手正常；若客户端返回`证书过期`，则Certificate消息中的证书有效性不符合要求。

### 3. HTTP层（RFC9110 语义规范，Section 5、7）
HTTP/1.1是应用层协议，请求-响应模式为核心交互：
- 必需行为：
  - 请求行格式为`Method SP Request-URI SP HTTP-Version CRLF`（RFC9110 5.1）
  - 所有HTTP/1.1请求必须携带`Host`头部（RFC9110 7.1.2），用于确定目标服务器的域名与端口
  - 响应状态码需符合语义（如200=成功，400=语法错误，502=网关错误）
- 可选行为：`Upgrade`协议升级、请求压缩等

**关键请求字段**
| 头部字段 | 含义 | 必需性 |
|----------|------|--------|
| Host | 目标主机（如`www.example.com:443`） | 必需 |
| User-Agent | 客户端类型 | 可选 |
| Connection | 连接控制（如`keep-alive`） | 可选 |

**推演例子**：执行`curl -v https://www.example.com`，预期请求行是`GET / HTTP/1.1`，请求头部包含`Host: www.example.com`，响应状态为`HTTP/1.1 200 OK`；若返回`400 Bad Request`，则大概率缺少`Host`头部或请求行语法错误。

---

## 实验设计与逐步实施
### 实验环境与工具
- 基础环境：本地主机（Linux/macOS/Windows），连接互联网
- 工具链：
  - DNS诊断：dig（dnsutils包）
  - 协议抓包：Wireshark（需安装并允许捕获网络接口）
  - TLS分析：openssl（自带）
  - HTTP交互：curl（自带）
- 辅助资源：公共DNS（8.8.8.8、1.1.1.1）、测试域名（example.com、badssl.com）

### 步骤1：DNS层排障实验（定位“域名解析”故障）
**目标**：验证DNS迭代查询流程，模拟常见解析故障
1. 正常查询：执行`dig @8.8.8.8 www.example.com A`，观测：
   - Query section：QNAME=www.example.com，QTYPE=1（A记录）
   - Answer section：返回IPv4地址（93.184.216.34），RCODE=0
2. 故障1（域名不存在，NXDOMAIN）：执行`dig @8.8.8.8 nonexistent.example.com A`，观察到RCODE=3（NXDOMAIN，对应RFC1034中域名不存在的状态）；需注意另一种否定响应NODATA：RCODE=0但Answer段为空，此时域名存在，但无对应查询类型的记录，两者排障逻辑不同，该定义由RFC2308明确
3. 故障2（服务器不可达）：临时修改`/etc/resolv.conf`为无效DNS服务器（如`nameserver 192.0.2.1`），执行`dig www.example.com`，观察返回状态为`TIMEOUT`，对应RFC1034中服务器无响应的异常
4. 诊断验证：执行`dig +trace www.example.com`，查看迭代查询的根→TLD→权威服务器路径，确认是否存在中间环节的故障

### 步骤2：TLS层排障实验（定位“加密握手”故障）
**目标**：验证TLS1.3握手流程，模拟证书/版本协商故障
1. 正常握手抓包：打开Wireshark，过滤`tls`流量，执行`curl https://www.example.com`，查看ClientHello和ServerHello：
   - ClientHello包含`supported_versions: 0x0304`（TLS1.3）、`server_name: www.example.com`
   - ServerHello选择`cipher_suite: TLS_AES_256_GCM_SHA384`
2. 故障1（证书无效）：执行`openssl s_client -connect expired.badssl.com:443`，观察返回`verify error:num=10:certificate has expired`，对应RFC8446中证书有效性校验失败
3. 故障2（版本不兼容）：执行`openssl s_client -connect tls-v10.badssl.com:443 -tls1_2`（强制TLS1.2），观察返回`handshake failure`，说明服务器仅支持TLS1.3
4. 诊断验证：在Wireshark中查看`Certificate`消息的SAN（Subject Alternative Name），确认匹配请求的SNI域名，若SAN不包含目标域名则为证书不匹配故障

### 步骤3：HTTP层排障实验（定位“请求/响应”故障）
**目标**：验证HTTP请求合法性，模拟头部缺失/语法错误故障
1. 正常HTTP请求：执行`curl -v https://www.example.com`，查看请求头部：
   - 请求行：`GET / HTTP/1.1`
   - 关键头部：`Host: www.example.com`存在，响应状态`200 OK`
2. 故障1（缺少Host头部）：执行`curl -v https://93.184.216.34`（直接使用IP，未指定Host），观察返回`400 Bad Request`，对应RFC9110中HTTP/1.1请求必须包含Host头部的规范
3. 故障2（无效请求行）：执行`curl -v "https://www.example.com" -X INVALID`（使用未定义方法），观察返回`501 Not Implemented`，对应RFC9110中不支持的方法
4. 诊断验证：使用Wireshark过滤`http`流量，查看请求行和头部是否符合RFC9110的ABNF格式（如请求行必须以空格分隔方法、URI、版本）

---

## 可操作的诊断方法
### DNS层诊断工具与步骤
1. **配置验证**：Linux执行`cat /etc/resolv.conf`，Windows执行`ipconfig /all`，确认DNS服务器地址，若为公共网络需检查是否为DHCP分配的正确服务器
2. **权威对比**：执行`dig @a.iana-servers.net www.example.com A`，对比递归DNS服务器的响应，若结果不一致则存在DNS劫持或缓存异常
3. **缓存排查**：执行`dig www.example.com A`两次，若第二次响应时间显著缩短，则存在本地缓存；若缓存过期仍返回旧地址，需手动清理缓存（如Linux：`systemctl restart nscd`）

### TLS层诊断工具与步骤
1. **证书验证**：执行`openssl s_client -connect www.example.com:443 -showcerts`，查看证书链是否由受信任根CA签发，有效期是否在当前时间范围内，SAN字段是否匹配请求域名
2. **版本协商**：执行`openssl s_client -connect www.example.com:443 -supported_versions`，查看服务器支持的TLS版本，确认是否与客户端协商一致
3. **抓包分析**：Wireshark中过滤`tls.handshake.type == 1`（ClientHello）和`tls.handshake.type == 2`（ServerHello），查看扩展字段的完整性，若缺少SNI则为配置错误

### HTTP层诊断工具与步骤
1. **头部检查**：执行`curl -v -I https://www.example.com`，查看响应头部的`Content-Length`、`Server`等字段，若`Content-Length`缺失且服务器返回分块编码，则可能存在传输异常
2. **状态码映射**：参考RFC9110的状态码定义：
   - 4xx：客户端错误（如400=语法错误、404=资源不存在）
   - 5xx：服务器错误（如502=网关错误，通常与DNS/TLS故障相关）
3. **跨层关联**：若HTTP返回502，需先检查DNS是否解析到正确IP，再检查TLS握手是否成功（若TLS失败则连接被拒绝，对应502）

---

## 常见误区与边界安全
### 常见误区
1. **误区1**：认为DNS故障仅为“IP未返回”，忽略递归流程：若本地DNS服务器无响应，dig会返回TIMEOUT，而非NXDOMAIN，需区分“服务器异常”和“域名不存在”
2. **误区2**：认为TLS握手成功仅需“加密”，忽略SNI：若服务器配置多域名证书，客户端未发送SNI会导致服务器选择错误证书，出现证书不匹配错误
3. **误区3**：认为HTTP请求仅需GET/POST方法，忽略Host：直接使用IP访问时未指定Host会导致400错误，这是HTTP/1.1与HTTP/1.0的核心差异

### 边界与安全风险
1. **DNS劫持**：公共WiFi或恶意路由器会篡改DNS响应，将域名指向攻击者IP，需使用`+trace`验证权威服务器的迭代查询结果
2. **TLS中间人攻击**：企业防火墙或恶意软件会拦截TLS流量，替换服务器证书，需检查证书的签发者是否为合法CA（如DigiCert、Let's Encrypt）
3. **HTTP降级攻击**：攻击者强制客户端降级TLS版本至不安全的1.0，需配置服务器仅支持TLS1.3+（如Nginx配置`ssl_protocols TLSv1.2 TLSv1.3`）

---

## 自测题（带解答，共3题）
1. 根据RFC1034，若递归名称服务器返回SERVFAIL，最可能的故障原因是什么？
   - **解答**：递归名称服务器无法完成迭代查询，具体可能为：根服务器无响应、顶级域（TLD）服务器不可达、二级域权威服务器未返回有效响应（RFC1034 4.1.1）
2. RFC8446中，ClientHello必须携带哪个扩展以确保服务器选择匹配目标域名的证书？
   - **解答**：`server_name`（SNI）扩展，该扩展的作用是向服务器指示客户端请求的域名，确保服务器返回对应域名的证书（RFC8446 4.2.3）
3. 根据RFC9110，HTTP/1.1请求中缺失哪个必需头部会导致400 Bad Request状态码？
   - **解答**：`Host`头部，RFC9110 7.1.2明确规定：所有HTTP/1.1请求必须包含Host头部，以唯一确定目标服务器的地址

---

## 参考RFC与对应节号
- RFC1034: Domain Names - Concepts and Facilities（Section 3.2、4.1.1、5.4）
- RFC8446: The Transport Layer Security (TLS) Protocol Version 1.3（Section 4.1.2、4.2.3、4.4）
- RFC9110: HTTP Semantics（Section 5.1、7.1.2、8.1.1）