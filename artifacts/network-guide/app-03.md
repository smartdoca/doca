# DNS安全：UDP/TCP传输、EDNS与DoT/DoH

## 学习目标
对比DNS的UDP/TCP传输场景，解释EDNS的核心作用与协商机制，区分DNS over TLS（DoT）和DNS over HTTPS（DoH）的安全特性，掌握DNS传输相关的诊断方法，识别常见协议误区。

## 1. DNS的传输层：UDP与TCP的场景对比
### 1.1 传统DNS的UDP传输机制（RFC1035基础）
RFC1035定义的传统DNS默认使用UDP作为传输协议，其核心限制是UDP payload最大为512字节（RFC1035 Section4.2.1）。这种机制的优势是低开销、延迟小，适合短查询场景，例如A记录（IPv4地址）、AAAA记录（IPv6地址）等小尺寸响应的查询。

当UDP响应的实际尺寸超过512字节时，DNS服务器会在响应头部设置TC（Truncated）标志位，告知客户端响应已被截断，客户端需触发TCP重传（RFC1035 Section4.3.5）。这是协议的必需行为，确保客户端总能获取完整响应。

### 1.2 TCP传输的适用场景
当以下情况发生时，DNS会切换到TCP传输：
1. UDP响应设置了TC标志位；
2. 查询的响应尺寸超过客户端与服务器通过EDNS协商的UDP payload阈值；
3. DNSSEC相关查询（需携带大量RRSIG、DNSKEY等签名/密钥记录）；
4. 动态更新（DNS UPDATE）等需要可靠传输的场景。

与UDP相比，TCP提供了可靠的有序数据传输、流量控制和拥塞控制，但开销更高，延迟更大（需三次握手建立连接）。例如，查询包含10个以上DNSSEC签名的域名时，响应尺寸通常超过512字节，此时TCP是必需的传输协议。

### 1.3 场景对比表格
| 特性               | UDP传输（RFC1035）                | TCP传输（RFC7766推荐）            |
|--------------------|----------------------------------|----------------------------------|
| 延迟               | 低（无TCP握手）                   | 高（三次握手+TCP流管理）          |
| 可靠性             | 不可靠（需应用层重传逻辑）         | 可靠（确认、重传、错误恢复）       |
| 最大载荷           | 默认512字节（不可协商）           | 理论无上限（受系统MTU限制）      |
| 适用场景           | 短查询、小响应（如A/AAAA记录）   | 大响应、DNSSEC、动态更新等       |
| 触发条件           | 响应尺寸≤512字节且无EDNS支持      | TC位设置或响应尺寸超UDP阈值      |

## 2. EDNS（扩展DNS）：突破UDP限制的关键机制（RFC6891）
### 2.1 EDNS的核心需求与设计目标
RFC1035的DNS存在明显局限：UDP payload限制512字节，RCODE（返回码）和标志位字段不足，无法支持DNSSEC等新特性。EDNS（Extended DNS，亦称EDNS0，因是第0版本）由RFC6891标准化，旨在扩展DNS协议能力，实现向后兼容（旧设备会忽略扩展字段）。

### 2.2 核心机制：OPT伪资源记录
EDNS通过在DNS消息的**额外数据段**加入OPT（Option）伪RR（资源记录）传递扩展信息，该RR无实际域名对应，仅作为扩展载体（RFC6891 Section6.1.1）。关键字段包括：
- **UDP payload大小**：在OPT RR的CLASS字段中编码，代表请求方（客户端）能接收的最大UDP payload尺寸（RFC6891 Section6.2.3）；
- **版本**：EDNS的版本号，当前固定为0，服务器若不支持客户端版本需返回BADVERS错误（RFC6891 Section6.1.3）；
- **DO标志**：DNSSEC OK标志，告知服务器需要返回DNSSEC相关记录（引用RFC3225）；
- **选项字段**：预留扩展能力（如EDNS-TCP-KEEPALIVE、Padding等，对应RFC7828、RFC7830）。

### 2.3 关键数值与协商例子
根据RFC6891 Section6.2.5，客户端应使用4096字节作为UDP payload的推荐起始值（Ethernet MTU通常为1500，IP头+UDP头共28字节，故单帧可承载1472字节，但4096是平衡覆盖性与分片风险的推荐值）。具体协商过程：
1. **客户端请求**：发送查询时，额外段加入OPT RR，CLASS=4096（表示支持最大4096字节UDP响应），DO=1（请求DNSSEC记录）；
2. **服务器响应**：若支持EDNS0，返回自身最大payload（如4096），同时携带DNSSEC记录；
3. **后续查询**：客户端使用协商后的4096字节payload，若响应尺寸≤4096，仍用UDP传输，避免触发TCP。

若响应超过协商的最大payload，服务器会设置TC位，客户端回退到TCP传输（RFC6891 Section6.2.2）。

### 2.4 EDNS的必需行为与 fallback
- **客户端必需**：使用DNSSEC等扩展能力时需加入OPT RR；若收到服务器BADVERS错误，需降级处理；
- **服务器必需**：不支持客户端EDNS版本时返回BADVERS；
- ** fallback 机制**：若客户端检测到服务器不支持EDNS0，可回退到无OPT的查询，默认使用512字节payload（RFC6891 Section6.2.2）。

## 3. DNS over TLS（DoT）与DNS over HTTPS（DoH）：安全传输对比
### 3.1 DNS over TLS（DoT，RFC7858）
DoT是通过TCP端口853传输DNS消息，先建立TLS会话加密通信，适用于Stub resolver与递归服务器之间的端到端安全传输（RFC7858 Section1）。核心特性：
- **固定端口**：默认TCP端口853，与标准DNS端口53隔离，避免混淆；
- **加密机制**：基于TLS 1.3（遵循BCP195安全建议），提供端到端加密、服务器身份认证；
- **会话管理**：复用TLS连接减少握手开销，支持长连接避免频繁建立TCP/TLS会话；
- **场景适配**：企业内部DNS、递归服务器与客户端的通信，防火墙易识别853端口（降低阻断概率）。

### 3.2 DNS over HTTPS（DoH，RFC8484）
DoH将DNS消息封装在HTTP/2或HTTP/1.1请求中，通过HTTPS（端口443）传输，适用于浏览器应用、公共DNS服务的跨平台安全查询（RFC8484 Section1）。核心特性：
- **URI结构**：典型请求为GET /dns-query?name=google.com&type=A，或POST方法，URI模板如`https://dns.google/dns-query`；
- **复用协议**：复用HTTPS的443端口，与HTTPS流量混合，避免被防火墙阻断；
- **HTTP特性**：支持缓存（HTTP Cache-Control）、CORS（供浏览器跨域请求）、身份认证等；
- **隐私考虑**：HTTP的Cookie、请求头等可能关联用户身份，需依赖Padding（RFC8467）减少流量分析风险。

### 3.3 两者安全特性对比表格
| 特性               | DNS over TLS（DoT，RFC7858）    | DNS over HTTPS（DoH，RFC8484）  |
|--------------------|----------------------------------|----------------------------------|
| 传输层             | TCP + TLS 1.3                    | TCP + HTTP/2 + TLS 1.3          |
| 默认端口           | 853（专用）                      | 443（HTTPS标准端口）             |
| 加密粒度           | 完整DNS消息加密                  | 完整DNS消息加密                  |
| 防火墙穿透性       | 可能被单独阻断（专用端口）       | 易穿透（复用HTTPS流量）          |
| 适用场景           | 客户端-递归服务器、Stub解析器    | 浏览器应用、公共DNS服务          |
| 隐私关联           | 依赖TLS特性，无HTTP关联          | 依赖HTTPS特性，Cookie可能泄露     |
| 认证要求           | 支持服务器证书认证/密钥固定      | 支持HTTPS证书链验证              |

## 4. 诊断方法与常见误区
### 4.1 可操作诊断步骤
#### 4.1.1 检测UDP/TCP的DNS传输
使用`dig`工具（DNS调试必备）：
```bash
# 普通UDP查询，查看TC位与EDNS状态
dig @8.8.8.8 google.com | grep -E "status|tc|OPT"
# 强制使用TCP查询
dig @8.8.8.8 google.com +tcp | grep "status"
# 启用DNSSEC的EDNS查询
dig @8.8.8.8 google.com +dnssec | grep "OPT"
```
输出说明：若有`OPT`行说明EDNS0已启用，若响应中有`tc: yes`则触发了TCP fallback。

#### 4.1.2 检测DoT与DoH连接
- **DoT检测**：用nmap扫描853端口是否开放：
```bash
nmap -p 853 8.8.8.8
# 若返回853/tcp open domain-s，说明支持DoT
```
- **DoH检测**：用curl测试DoH URI：
```bash
curl -H "accept: application/dns-message" "https://dns.google/dns-query?name=google.com&type=A"
# 若返回DNS二进制数据或JSON，说明支持DoH
```

#### 4.1.3 抓包验证（tcpdump）
```bash
# 监听DNS UDP包（53端口），查看EDNS OPT RR
sudo tcpdump -i eth0 udp port 53 -v
# 监听DoT包（853端口），查看TLS握手
sudo tcpdump -i eth0 tcp port 853 -v
```

### 4.2 常见误区与规避
1. **误区1**：EDNS0会替代TCP传输
   纠正：EDNS0仅优化UDP载荷，减少TCP触发，但当响应尺寸超过协商阈值时，仍会触发TCP，并非完全替代TCP（RFC6891 Section6.2.2）。
2. **误区2**：DoT和DoH的安全等级完全相同
   纠正：两者均加密，但DoT是专用端口，无HTTP关联隐私风险；DoH复用HTTPS，易被防火墙接受，但存在Cookie等隐私泄露可能，需根据场景选择（RFC8484 Section8、RFC7858 Section8）。
3. **误区3**：UDP的512字节限制是绝对的
   纠正：仅当无EDNS0时，UDP最大载荷为512字节；EDNS0可扩展到4096字节甚至更大，需网络MTU支持，客户端会自动协商合理值（RFC6891 Section6.2.5）。

## 5. 自测题与解析
### 5.1 自测题
1. 当DNS响应的UDP包设置TC（截断）标志位时，客户端应采取的操作是？
   A. 忽略响应，重新用UDP查询
   B. 立即切换TCP传输并重传查询
   C. 向服务器发送错误请求
   D. 等待服务器重发UDP响应

2. EDNS（EDNS0）的核心作用不包括以下哪项？
   A. 扩展DNS over UDP的payload尺寸
   B. 增加可返回的RCODE（返回码）数量
   C. 对DNS消息进行端到端加密
   D. 支持DNSSEC的DO标志位

3. DNS over TLS（DoT）的默认使用端口是？
   A. 53
   B. 443
   C. 853
   D. 5353

### 5.2 答案与解析
1. **答案：B**。依据RFC1035 Section4.3.5，TC标志位表示UDP响应截断，客户端需用TCP重传以获取完整响应。
2. **答案：C**。EDNS0仅扩展DNS协议的格式和字段，本身不提供加密，加密是DoT/DoH的专属功能（RFC6891中无加密相关规范）。
3. **答案：C**。依据RFC7858 Section3.1，DoT的默认端口为TCP 853；DoH默认端口为443（RFC8484 Section3）。

## 6. 参考RFC
- RFC6891：Extension Mechanisms for DNS (EDNS(0))
- RFC7858：Specification for DNS over Transport Layer Security (TLS)
- RFC8484：DNS Queries over HTTPS (DoH)
- RFC1035：Domain names - implementation and specification
- RFC2119：Key words for use in RFCs to Indicate Requirement Levels

## 补充说明
本章未覆盖RFC9508中ECH（Encrypted Client Hello）与DNS交互的内容，若需了解加密客户端请求的扩展机制，需参考对应RFC的规范细节。