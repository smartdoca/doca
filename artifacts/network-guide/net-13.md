# 第13章 QoS机制：DSCP、队列与拥塞管理

## 学习目标
本章将帮助读者达成以下核心目标：
1. 解析DiffServ体系中DSCP的分类规则与服务类映射逻辑；
2. 区分主流队列调度算法的工作机制及适用场景；
3. 掌握拥塞管理的核心技术（队列调度+主动队列管理）的实现原理；
4. 学会通过标准工具观测与排查QoS故障，理解常见配置误区。

## 1 Differentiated Services（DiffServ）基础框架（基于RFC2475）
DiffServ是IETF定义的可扩展QoS架构，核心是将网络流量聚合为**行为聚合（Behavior Aggregate, BA）**，通过简单的逐跳行为（Per-Hop Behavior, PHB）提供差异化服务，替代旧有IntServ架构的状态信令开销。

### 1.1 核心组件：分类器与流量调节器
RFC2475将流量的处理流程定义为“分类+调节”，核心组件如下：
- **分类器**：分为两类（第2.3.1节）：
  - BA分类器：仅根据IP头部的DSCP字段（6位）匹配流量，是域内最常用的分类方式；
  - MF（多字段）分类器：根据源IP、目的IP、端口号、协议ID、入接口等多字段组合匹配，适用于边缘节点的精细分类。
- **流量调节器**：部署在DS域边界节点，包含4个功能单元（第2.3.3节）：
  - 流量计（Meter）：用令牌桶等算法测量流量是否符合SLA约定的速率/突发大小，判断包是“在-profile”还是“out-of-profile”；
  - 标记器（Marker）：修改IP头部的DSCP字段，改变流量所属的BA类；
  - 整形器（Shaper）：延迟out-of-profile的包，将流量“拉回”约定速率，通常用缓存存储待发包；
  - 丢弃器（Dropper）：直接丢弃out-of-profile的包，是简单的流量 policing 实现。

### 1.2 DS域的部署位置
流量调节优先部署在网络边缘（边界节点），但也可在源域内提前标记（预标记），优势是降低域内分类的复杂度（第2.3.4.1节）：例如企业CEO主机直接将语音流量标记为高优先级DSCP，避免中间路由器重复分类。

## 2 DSCP标记规则与服务类映射（基于RFC4594）
DSCP是IP头部的6位字段，用于标识流量所属的服务类，IETF推荐了标准化服务类与DSCP的映射（RFC4594，针对企业网络的通用场景）。

### 2.1 推荐服务类与DSCP对应表
RFC4594定义了6类核心服务，各服务的DSCP标记、适用场景及AQM要求如下：
| 服务类名称               | 推荐DSCP值 | 典型应用场景                          | 核心特性                          | 配置要求（AQM）                                  |
|--------------------------|------------|---------------------------------------|-----------------------------------|--------------------------------------------------|
| 运维管理类（OAM）        | CS2（001000） | SNMP、Telnet、FTP等管理流量          | 低丢包、非时延敏感                | 优先队列或加权队列，预留最低带宽                  |
| 高吞吐量数据类（AF1x）   | AF11（001010）/AF12（001100）/AF13（001110） | 长寿命TCP流（如FTP） | 弹性流量，按丢包优先级区分        | RED配置：AF13的max-threshold ≤ AF12的min-threshold；AF12的max-threshold ≤ AF11的min-threshold；AF11的max-threshold ≤ 队列总内存 |
| 中吞吐量数据类（AF2x）   | AF21（010010）/AF22（010100）/AF23（010110） | 交互数据（如Web） | 弹性流量，次高优先级              | RED配置规则同AF1x，AF23丢弃优先级最高              |
| 默认服务类（Standard）   | DF（000000） | 所有未分类流量                        | 尽力而为（Best-Effort）           | 基础RED，无严格带宽保证                          |
| 低优先级数据类（Low-Priority） | CS1（000001） | 非关键批量下载                        | 无带宽保证，高丢包容忍            | 独立队列，AQM优先级最低                          |
|  Expedited Forwarding（EF） | EF（101110） | VoIP、视频会议                          | 低延迟、低抖动                    | 严格优先级队列，保证速率（RFC3246）              |
> 注：AFxy的y值为丢弃优先级（1最低，3最高），Congestion时先丢弃y值高的包，避免带宽浪费。

### 2.2 DSCP标记规则
根据RFC4594的边缘安全要求，标记需遵循以下规则：
1. **终端预标记**：应用或主机应直接将流量标记为对应DSCP；
2. **边缘验证**：非信任域的流量（如用户设备），DS边缘节点必须通过MF分类验证DSCP，非法高优先级流量需重新标记或丢弃；
3. **域内保持**：DS域内部应尽量保持DSCP值，避免频繁重标记导致性能开销。

## 3 队列调度算法（Rate Queuing，基于RFC4594）
队列调度是拥塞管理的核心，决定了不同服务类流量的带宽分配顺序，RFC4594推荐两类调度机制：

### 3.1 优先级队列（Priority Queue, PQ）
PQ为高优先级队列提供绝对优先发送权，典型应用是VoIP/视频的EF类。其优势是延迟极低，适合时延敏感业务；但存在致命缺陷：**饥饿问题**——若高优先级队列持续有流量，低优先级队列将永远无法发送。RFC4594明确要求（第1.4.1.2节）：必须通过 admission control（限制高优先级流量峰值）或 rate control（为高队列预留最大速率）避免饥饿。

### 3.2 加权队列（Weighted Queuing）
分为WFQ（加权公平队列）和WRR（加权轮询），核心是为每个队列分配权重，带宽分配与权重成正比，无绝对优先级，适合弹性数据类：
- 示例：1Gbps链路配置权重：OAM（10%）、AF1x（40%）、AF2x（30%）、DF（15%）、CS1（5%），总权重归一化后各队列按比例占用带宽。
- 优势：无饥饿问题，适合多数企业网络数据业务；劣势：时延略高于PQ，不适合极端时延敏感业务。

### 3.3 服务类与队列映射的最佳实践
RFC4594要求（各服务类节）：
- OAM类用Rate Queuing，预留最小带宽；
- AF1/AF2类独立队列，RED配置按丢弃优先级设置阈值；
- DF类作为默认队列，无严格权重要求；
- CS1类单独队列，仅在其他队列空闲时发送。

## 4 拥塞管理与主动队列管理（AQM）
拥塞发生时，仅靠队列调度无法避免丢包导致的TCP全局同步，需结合AQM主动管理队列深度（RFC4594第1.4.2节）。

### 4.1 主动队列管理：RED算法
随机早期检测（Random Early Detection, RED）是最经典的AQM，工作逻辑：
1. 计算队列平均深度（而非瞬时深度，避免抖动影响）；
2. 若平均深度 < min-threshold：无丢包，所有流量正常转发；
3. 若平均深度在 min-threshold 和 max-threshold 之间：随机丢弃部分包，丢包概率线性随平均深度增加；
4. 若平均深度 > max-threshold：所有包丢弃，强制发送方降低速率。

### 4.2 AQM在AF类的差异化配置
RFC4594对AF PHB的RED配置有明确规则（以AF1x为例）：
```
min-threshold AF13 < max-threshold AF13
max-threshold AF13 ≤ min-threshold AF12
min-threshold AF12 < max-threshold AF12
max-threshold AF12 ≤ min-threshold AF11
min-threshold AF11 < max-threshold AF11
max-threshold AF11 ≤ 队列总内存
```
规则的核心是：**AF类丢弃优先级越高，其RED阈值越低**，Congestion时优先丢弃AF13的包，减少对高优先级弹性流量的影响。

### 4.3 ECN的补充作用
RFC3168定义的显式拥塞通知（ECN）：将IP头部的2位ECN字段标记为“拥塞”，避免实际丢包，更适合TCP流的速率调整，RFC4594推荐在所有服务类启用ECN（EF类除外）。

## 5 推演示例（数值化）
### 5.1 DSCP标记示例
场景：企业网络流量包括CEO的VoIP（EF）、财务FTP（AF11）、DNS查询（DF）、低优先级备份（CS1），流程：
1. CEO主机预标记VoIP为EF（DSCP=101100）；
2. 财务服务器预标记FTP为AF11（DSCP=001010）；
3. 边缘路由器将DNS（目的端口53）标记为DF（000000）；
4. 低优先级备份流量手动标记为CS1（000001）。

### 5.2 队列调度示例
1Gbps出口链路配置3个队列：
- PQ队列（EF）：速率200Mbps（保证时延）；
- 加权队列（AF1/AF2/DF/CS1）：权重40/30/20/10；
- 当PQ队列有150Mbps流量（低于200Mbps预留），加权队列需承担剩余850Mbps中的850*(0.4+0.3+0.2+0.1)=850Mbps，各队列按权重分配：AF1（340Mbps）、AF2（255Mbps）、DF（170Mbps）、CS1（85Mbps）；
- 若AF1流量突发至350Mbps（超出分配），流量计判断为out-of-profile，部分包被丢弃，保证PQ队列和其他队列的带宽。

### 5.3 AQM示例
AF13队列配置：min=100包，max=300包；AF12配置：min=150包，max=250包；AF11配置：min=200包，max=350包；
当AF13的平均队列深度为200包（介于min和max之间），RED会以线性概率随机丢弃AF13的包，提醒TCP降低发送速率，避免队列继续膨胀。

## 6 观测与诊断方法
### 6.1 常用工具与命令
1. **Linux tc命令**（流量控制与QoS观测）：
```bash
# 查看队列配置与调度算法
tc qdisc show dev eth0
# 查看类的带宽分配
tc class show dev eth0
# 查看过滤器与流量映射
tc filter show dev eth0
```
2. **Wireshark观测DSCP**：捕获IP包后，右键→协议首选项→IPv4→勾选“显示DSCP值”，可直接查看包的DSCP标记。
3. **厂商CLI命令**（以Cisco为例）：
```ios
show mls qos map  # 查看DSCP到队列的映射
show queueing  # 查看队列调度配置
show interfaces stats  # 查看队列丢包与深度
```

### 6.2 关键指标排查
需观测的核心指标：
- 队列深度：是否超过RED max-threshold；
- 丢包率：out-of-profile流量的丢弃比例是否过高；
- 延迟：PQ队列的VoIP延迟是否超过150ms（行业标准）；
- 饥饿度：低优先级队列的发送字节数是否持续为0（验证PQ是否配置了速率限制）。

## 7 常见误区与边界安全
### 7.1 典型配置误区
1. 无限制启用PQ导致饥饿：如将所有高优先级流量放入PQ，最终导致AF类等弹性流量无法发送；
2. 不验证边缘DSCP：允许用户设备将普通Web流量标记为EF，抢占带宽；
3. RED阈值配置错误：如AF13的max-threshold高于AF12的max-threshold，导致高丢弃优先级的包被后丢弃；
4. 忽略MF分类的分片问题：RFC2475第2.3.1节指出，MF分类器无法正确识别分片后的传输层端口，需通过第一层分片的ID或入接口辅助分类。

### 7.2 边界安全要求
RFC4594明确要求：
- DS边缘节点必须对非信任域的DSCP进行验证，将非法高优先级流量（如EF）重新标记为CS2或丢弃；
- 流量调节器的令牌桶参数需与SLA一致，避免内部流量超出约定速率；
- RFC8325 讨论 Diffserv 与 IEEE 802.11 的映射，不是 IoT 专用 DSCP 编码规范。无线 QoS 映射应结合接入点与客户端配置核对。

## 8 自测题
1. 根据RFC4594，低优先级数据服务类推荐的DSCP是？
   A. CS2 B. CS1 C. AF11 D. DF
   答案：B（RFC4594第4.10节明确Low-Priority Data类使用CS1）

2. 若AF23的RED max-threshold配置为500包，根据RFC4594规则，AF22的min-threshold最小应设为？
   A. 400包 B. 500包 C. 600包 D. 无需设置
   答案：B（AFxy的规则是max-threshold of higher discard priority ≤ min-threshold of lower discard priority，AF23的丢弃优先级高于AF22，故AF22的min-threshold需≥ AF23的max-threshold，即最小设为500，选B）

3. 根据RFC2475，MF分类器的分类依据不包括以下哪个字段？
   A. DSCP字段 B. 源IP地址 C. 目的端口 D. 入接口
   答案：A（RFC2475第2.3.1节：BA分类仅用DSCP，MF分类包含源IP、目的端口、入接口等多字段，A是BA分类的特征，非MF）

## 9 参考RFC与节号
- RFC2475：Architecture for Differentiated Services（第1.3、2.3、3.1节）
- RFC4594：Guidelines for DiffServ Service Classes（第1.4.1、1.4.2、3.3、4.7-4.10节）
- RFC3168：The Addition of Explicit Congestion Notification（ECN）
- [RFC8325](https://www.rfc-editor.org/rfc/rfc8325.html)：Mapping Diffserv to IEEE 802.11。
