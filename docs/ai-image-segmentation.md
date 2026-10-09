# 本地图像分割提案

`scripts/ai-image-segment.py` 是 SAM2 单图 CPU 推理工作器；`scripts/ai-image-segment-native-roi.py` 是按部位保留原生细节的独立工作器。宿主通过 `image_mask_segment` 调用明确安装的工作器，产生待检查的二值选区。它们不调用付费图片 API，不修改原图，也不承诺任意人物、道具或复杂场景都能准确分割。SAM 分数和提示点满足情况不能代替完整覆盖、边缘及最终图片的视觉验收。该能力需要管理员预先提供可信本地运行环境；Doca 不自动安装依赖、配置或权重。

## 原生部位 ROI

对于帽边、绳结等细小部位，可明确安装 `ai-image-segment-native-roi.py` 并生成独立 profile ID、真实 `workerPath` 和 `workerSha256`。两种工作器使用相同的严格 version 1 task/report；运行方式由所选工作器的真实摘要标识，不自动切换或扩大选区。已有提案与原始文件不转换、不覆盖。

每个部位从原图无损裁出包含完整 box、全部正负提示点和有界上下文的 ROI；坐标按原图像素中心映射，真实 SAM 候选及 logits 精化的 stage、index、score 保持原事实。选区贴回原尺寸零画布，保留分离部件与孔洞；返回的分数属于真实候选，不给合并结果虚构 IoU。选区触及图像内部裁切边时明确失败，不自动扩大裁切框或改用整图推理。原图的实际外边界允许目标接触。

部位提案可以通过 `proposalIds` 明确并入已检查的完整人物提案；局部选区不能声称完整人物覆盖。每个正式提案仍须实际查看诊断图，最终蒙版仍核验受保护区域、遮挡授权和源/raw 绑定。独立部位推理也不能修复错误语义提示点，或把 SAM 预测分数当作交付验收。

## 宿主启用与边界

服务端设置 `DOCA_AI_IMAGE_SEGMENT_PROFILE=/absolute/profile.json`，重启后读取严格 `version:1` profile。未设置时关闭该新能力；空值、非法路径、字段缺失或未知版本拒绝启动，不能静默忽略。可信运行文件或依赖不可用时不开放分割工具。只有能够实际查看诊断的视觉执行模型会收到工具。

profile 必须显式包含 `version`、`id`、`pythonPath`、`workerPath`、`workerSha256`、`engineRoot`、`engineCommit`、`engineTreeSha256`、`checkpointPath`、`checkpointVersion`、`checkpointSha256`、`config`、`configSha256`、`dependencies`、`threads` 和 `timeoutMs`。依赖对象完整指定 python、torch、torchvision、numpy、pillow 版本；线程数 1–32，超时 1000–300000 毫秒。宿主验证解释器、工作器/权重/配置字节摘要、已安装依赖版本和排序引擎文件树摘要，`engineCommit` 字符串本身不是版本证明。配置及运行文件不可由组或其他账号写入，模型参数没有路径或权重字段。

运行路径仅由宿主选择。每次任务使用独立私有临时目录、固定参数、`shell:false`、不继承模型密钥的子进程环境和离线标志；输出、总像素、文件尺寸、时长和同时运行数受限。租约丢失或取消会终止推理，不注册新提案和私有资产；已提交证据保留，暂存内容按事务结果清理。成功或有明确点约束失败的提案使用新的 `image_mask_segment/version:1` 回执；失败只能诊断、`usable:false`，不能进入合成。stdout、stderr、详细结果和位图在受配额限制的私有 `ai_mask_segment` 过程资产中保存，不进入文件列表、人物参考列表或最终交付。

工具输入的 `source` 明确选择已授权 `referenceImageId` 或持久 `generationOperationId`，提示坐标统一属于完整原页；raw 的既有局部工作窗口由宿主恢复到原页坐标。比例失真的整页 raw、越出真实生成窗口的选区、源/raw/存储对象变化、无权访问或跨账号会话都拒绝。每次读取重新核验回执、源字节、坐标变换、精确二值 PNG 与存储事实，不从旧 raw 或旧分割格式补造。

原始候选先单独 `image_candidate_view` 查看；后续轮次分割；提案的完整/局部两帧须完整传入同一轮视觉请求，下一轮才能用于 `image_mask_prepare`。只发文字、分数、坐标、部分帧或被截断标签不会获得查看证明。准备工具采用严格 `image_edit_mask/version:2`，每组选区明确提供 `proposalIds`、`include`、`exclude`，可对提案补漏或挖孔。原人和原保护物只接受同原页提案；新人和允许的新遮挡只接受同 raw 提案；改字可选同原页或同 raw。保留精确二值孔洞和分离部件，不压缩成少量轮廓点。v1 蒙版回执保留并明确拒绝，不补缺字段或转换。所有提案摘要及选区摘要绑定到新回执，准备、预览和本地保存各边界重新核验。见[精确合成与验收](ai-attachments.md)。

首次分割前可用 `image_candidate_region_view` 只读查看同一原页坐标小框的原图和 raw 投影，两帧保持原尺寸无损 PNG，并返回明确点位的实际 RGBA 与生成窗口内外事实。先完整接收候选三帧，再于后续轮次调用；`region` 和 `points` 都按完整原页归一化，每边最多 1024 像素、总量不超过 100 万像素，超限拒绝，不缩图或自动裁小。即使厂商 raw 与原页尺寸相同，也不能直接复制 raw 工作空间坐标：宿主按已绑定 viewport/workspace 投影。窗口外来自原稿，未生成。该小框不保存资产、回执或费用，不授予分割、蒙版、编辑轮廓、遮挡或候选完整查看证明，也不能替代最终语义验收。是否需要精确分割与保护，仍按用户真实要求决定，不把允许自然周边变化的任务自动升级为零像素限制。

`image_mask_segment_view` 按持久提案 ID 只读重看完整/局部两帧，不重新运行 SAM 或新增提案、资产和费用。恢复任务时可用它重建实际视觉证明；原始候选查看、当前书页、账号会话、来源和摘要检查仍执行。被预算省略的帧不获得查看许可，不能把收到 ID 或文字当作看过图片。

分割 `box` 固定为完整原页归一化 `[left, top, right, bottom]`，不是 `[left, top, width, height]`。原始候选也按原页宽高换算点和框，不能按裁剪后的候选尺寸换算。正点表示真实部位内点，负点表示该部位之外的背景或道具；提示点满足只是分割器诊断，仍需查看完整边缘、孔洞与分离部件。

`image_mask_view` 按持久蒙版 ID 只读重看当前 version:2 的完整/局部覆盖诊断。它不重新分割或准备蒙版，不新增回执、资产或费用；仍重新验证当前访问权限、原页、raw、坐标映射及全部提案和像素摘要。任务恢复时先独立重看同页原始候选，再读取两帧蒙版诊断；两帧实际送达后的后续轮次才允许读取几何或合成。预算只能容纳一帧时整组暂缓，旧查看许可也不保留。冲突诊断可以重看，但不会因查看变成安全蒙版；重复查看同一蒙版不算新的执行成果。

`image_mask_geometry` 只读分析已有 version:2 准备回执。须在实际接收该回执完整/局部两帧后的后续模型轮次调用；重新核验权限、来源、回执和像素摘要。可查询新人和保护物的交集、原人和保护物的交集，或剩余冲突，并用显式 `clipRegions` 限定需要诊断的范围；改字区始终从可遮挡的新人交集中排除。返回精确像素数、范围和摘要，不写入回执、资产或费用。返回的 `proposalIds/include/exclude` 仅是当前 version:2 原尺寸二值蒙版 selection 的数学编码，不能当作真实轮廓，或复用为生成 `editRegions`、编辑窗口及描边。整数几何优先；失败后，低于既有最小面积的正交矩形才可尝试中心扩展，再按固定的四方向及轮转次序尝试保留整数本体的细 tab。整数面积已经达到最小值、仅归一化浮点面积计算略低于阈值的正交轮廓，可尝试极小面积余量；真正低于最小面积的非矩形仍拒绝。每个候选均须满足既有多边形数量、点数、面积、简单性及坐标边界约束，并将整组 include/exclude 按既有原尺寸 SVG `alpha>=128` 规则渲染、扣除，零新增且零遗漏才返回 `ready`。细 tab 的透明度叠加或任何越界不能跳过回验、夹取坐标或省略小岛；所有有界候选失败后返回 `unrepresentable` 和 `geometry:null`。下一次 version:2 准备仍绑定完整二值像素及其预览，数学交集不证明遮挡符合用户意图，不能自动裁掉人物、减少保护或代替最终看图验收。

`image_mask_refine` 将已实际查看的当前 v2 蒙版作为 base，以数学选区名称和显式S/G修边创建新的标准 v2 准备回执，避免执行模型重复输出数百个几何坐标。当前输入必须提供 `baseMaskReceiptId`、`sourceExclude`、`allowedOcclusionAdd`、`sourceInclude`、`generatedInclude`、`generatedExclude`；缺字段拒绝，不为旧调用补默认值。前两组仅接受 `source-protected`、`generated-protected` 及可选局部 `clipRegions`；三个几何数组分别补原人、补新人、扣误选新人，无修改用 `[]`。保留base已有孔洞、排除、允许遮挡与全部提案；新增新人不自动获得遮挡授权，数学遮挡仍只取base新人和保护物交集，新增保护冲突保持不可合成。原人扣除带孔或整组几何无法精确表达时拒绝。原页、raw、窗口、提案、保护物与改字绑定保持，整页S/G/O及组合选区逐像素核验；叠加透明度或排除导致任何未声明像素变化都回滚新回执，base保留，不转换或改写历史标准v2蒙版。

修边前仍要求较早模型请求实际收到候选三帧、base 两帧以及所有保留提案两帧；新回执也须完整接收两帧，后续模型轮次才可合成。数学选区不自动授权遮挡或证明边缘准确，不能以该工具扣掉真实原人或遮住仍应可见的道具。返回仅有新回执及数学摘要，不输出全部坐标，也不增加图片服务调用或生图次数。当前安装 SDK 的输入校验错误通过正式错误通道返回模型；它不是成功回执，不能拿缺失 ID 读取预览或登记视觉证明。

默认 Docker 镜像不包含可用的 SAM2/PyTorch 运行环境、分割工作器或权重。需要自行准备并挂载可信运行目录，通过 Compose override 的 `environment` 显式设置容器内 profile 路径；只在 `.env` 填写变量不会替代目录挂载或运行环境校验。Linux 解释器、自定义镜像和只读挂载示例见 [Docker 文档渲染器](docker-rendering.zh-CN.md)。多实例使用相同版本事实，管理员升级运行环境后重启各实例。

## 隔离运行环境

本地 macOS 已实证：Python 3.12.14、PyTorch 2.5.1、torchvision 0.20.1、NumPy 2.5.3、Pillow 12.3.0，官方 SAM2 源码固定于 `2b90b9f5ceec907a1c18123530e92e794ad901a4`，使用本地 SAM2.1 Hiera Tiny 权重并强制 `device="cpu"`。这不是 Linux、Windows 或其他权重的通用质量/性能承诺。

单独创建虚拟环境和源码目录，以下为 macOS 的人工安装示例；不修改 Doca 的项目依赖、Docker、环境变量文件或部署配置：

```sh
python3.12 -m venv /absolute/segment-env
/absolute/segment-env/bin/python -m pip install torch==2.5.1 torchvision==0.20.1 numpy==2.5.3 pillow==12.3.0
git clone https://github.com/facebookresearch/sam2.git /absolute/sam2-source
git -C /absolute/sam2-source checkout --detach 2b90b9f5ceec907a1c18123530e92e794ad901a4
SAM2_BUILD_CUDA=0 /absolute/segment-env/bin/python -m pip install --no-build-isolation -e /absolute/sam2-source
```

安装说明参考[固定版本的官方 SAM2 文档](https://github.com/facebookresearch/sam2/blob/2b90b9f5ceec907a1c18123530e92e794ad901a4/INSTALL.md)及 [PyTorch 历史版本安装说明](https://pytorch.org/get-started/previous-versions/)。Linux CPU 安装应使用对应 CPU wheel，不能照搬 macOS wheel。官方权重须由可信安装过程预先提供并记录版本；工作器只读取本地文件，不调用 Hugging Face 下载接口，也不自动下载缺失配置或权重。升级依赖或模型须单独验证。

宿主拒绝引擎目录内的符号链接。上述官方源码包包含四个 YAML 配置别名链接，因此人工安装后还需建立独立的运行包副本：先确认每个链接只指向原引擎目录内的普通文件，再将别名实体化为普通文件，不能修改原依赖或放宽宿主校验。运行解释器实际导入此副本，验证导入位置和依赖版本后，以副本全部文件计算并冻结 `engineTreeSha256`；运行时禁止写入新的字节码缓存。QA 的 `host-runtime-v1` 使用了这一准备方式。直接将 editable 源码目录写入 profile 不满足启用约束。

<a id="linux-docker-profile"></a>

## Linux Docker profile

先在与正式容器相同的 Linux 镜像、架构和绝对路径中准备可信运行包；默认镜像不负责安装依赖或下载模型。管理员按固定官方源码版本及对应架构的官方 CPU wheel 安装 SAM2，复制可验证的 `sam2` 运行包到 `/opt/doca-segment/engine/sam2`，只实体化确认指向原包内普通文件的配置别名。让该环境的解释器在 `-I -B` 下实际导入这一副本（例如安装管理员拥有的 `.pth` 到该 venv 的 site-packages），不能靠 `PYTHONPATH`，因为隔离解释器会忽略它。原安装包保持不变，副本与其配置均冻结；其目录/文件不得由组或其他账号写入。

在独立管理员安装容器中放入对应发行源码的 `ai-image-segment.py`、可信安装流程已经校验来源的权重，以及真实安装记录。以下生成步骤运行在该 Linux 自定义镜像的 `/app`，其 `/opt/doca-segment` 是**安装时**可写的管理员目录；正式部署改为只读挂载。第二、三个参数分别来自已固定源码提交和权重版本记录，不根据文件名猜测。示例路径须确实存在，脚本读取真实依赖版本和摘要，没有预填或跳过校验的 hash。

```sh
node --import tsx --input-type=module - \
  2b90b9f5ceec907a1c18123530e92e794ad901a4 sam2.1_hiera_tiny <<'JS'
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  segmentationEngineTreeHash, segmentationProfileSchema,
  resolveSegmentationProfile,
} from './apps/server/src/services/ai/segmentation-profile.ts';

const pythonPath = '/opt/doca-segment/venv/bin/python';
const workerPath = '/opt/doca-segment/ai-image-segment.py';
const checkpointPath = '/opt/doca-segment/weights/sam2.1_hiera_tiny.pt';
const profilePath = '/opt/doca-segment/profile.json';
const config = 'configs/sam2.1/sam2.1_hiera_t.yaml';
const probe = await promisify(execFile)(pythonPath, ['-I', '-B', '-c',
  'import json,sys,sam2,torch,torchvision,numpy,PIL; from pathlib import Path; print(json.dumps({"engineRoot":str(Path(sam2.__file__).resolve().parent),"dependencies":{"python":sys.version.split()[0],"torch":torch.__version__,"torchvision":torchvision.__version__,"numpy":numpy.__version__,"pillow":PIL.__version__}}))',
], { timeout: 30000, env: {
  PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8',
  HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1',
}});
const actual = JSON.parse(probe.stdout);
if (actual.engineRoot !== '/opt/doca-segment/engine/sam2')
  throw Error('Interpreter did not import the frozen runtime copy');
const fileHash = async path => createHash('sha256')
  .update(await readFile(path)).digest('hex');
const profile = segmentationProfileSchema.parse({
  version: 1, id: 'linux-sam2-cpu', pythonPath, workerPath,
  workerSha256: await fileHash(workerPath), engineRoot: actual.engineRoot,
  engineCommit: process.argv[2],
  engineTreeSha256: await segmentationEngineTreeHash(actual.engineRoot),
  checkpointPath, checkpointVersion: process.argv[3],
  checkpointSha256: await fileHash(checkpointPath), config,
  configSha256: await fileHash(join(actual.engineRoot, config)),
  dependencies: actual.dependencies, threads: 4, timeoutMs: 120000,
});
await writeFile(profilePath, JSON.stringify(profile, null, 2) + '\n',
  { mode: 0o644, flag: 'wx' });
const status = await resolveSegmentationProfile({ DOCA_AI_IMAGE_SEGMENT_PROFILE: profilePath });
if (status.status !== 'ready') throw Error('Installed profile is not ready');
console.log(JSON.stringify({ status: status.status, profileId: profile.id,
  dependencies: profile.dependencies, engineTreeSha256: profile.engineTreeSha256 }));
JS
```

该命令使用现有严格 schema、引擎树计算和完整安装探测，profile 已存在时拒绝覆盖。计算文件摘要只是冻结实际字节，不代替管理员核验官方源码与权重来源。profile 生成后，使用正式非 root 用户、只读运行目录、无应用数据/模型密钥的一次性容器再执行 `resolveSegmentationProfile` 检查，必须返回 `ready`。然后用合成测试图验证真实工作器输出、取消/超时及临时目录清理；任何环节失败均不能声称该 Linux 部署可用。本仓库已有的 macOS QA 数据不构成这个 Linux 环境的验收。

## 严格输入

stdin 接收一个 UTF-8 JSON 对象，最长 256 KiB，必须恰好有以下字段：

| 字段         | 约束                                                         |
| ------------ | ------------------------------------------------------------ |
| `version`    | 严格整数 `1`                                                 |
| `sourcePath` | 原文件的绝对本地路径                                         |
| `outputDir`  | 绝对路径；父目录已存在，目标目录不存在或为空，不能是符号链接 |
| `targets`    | 1–64 个目标部位                                              |
| `exclusions` | 0–64 个需要保留/排除的对象，空时显式传 `[]`                  |

每个部位必须恰好有 `label`、`box`、`positivePoints`、`negativePoints`。同组标签唯一，标签长 1–100 字符；`box` 是 `[left, top, right, bottom]`，左右与上下严格递增。提示点是 `[x, y]`，每项至少一个正点，正负点合计最多 128 个，禁止重复点及同一部位正负点冲突。

所有坐标是 **EXIF 方向归一后原图**的 `[0,1]` 坐标；拒绝布尔值、NaN、Infinity、越界值、额外/缺失字段、重复 JSON 键、无效 UTF-8 和旧版本。点采样像素为 `min(floor(x × width), width - 1)`，y 同理；框按原图宽高换算，不以框裁切后另建坐标系。原文件只读，单帧且最多 2500 万像素，动画/多页图片及超限图片在加载模型前拒绝。

`sourcePath`、`outputDir` 和 CLI 配置由可信 Node 层从已授权持久来源与隔离临时目录分配，**模型不能控制这些路径**。宿主同时执行权限、会话归属、输出文件验证、超时及候选状态检查。

```sh
/absolute/segment-env/bin/python scripts/ai-image-segment.py \
  --config configs/sam2.1/sam2.1_hiera_t.yaml \
  --checkpoint /absolute/weights/sam2.1_hiera_tiny.pt \
  --engine-commit 2b90b9f5ceec907a1c18123530e92e794ad901a4 \
  --checkpoint-version sam2.1_hiera_tiny \
  --threads 8 < /absolute/isolated-task.json
```

`--config` 是已安装 `sam2` 包内的本地 YAML 名称；拒绝绝对配置路径、URL 和 `..`。`--checkpoint` 是已有可信权重的绝对路径。`--engine-commit` 和 `--checkpoint-version` 必填，来源于调用者安装记录，不根据文件名猜版本；回执额外计算配置与权重 SHA-256。CPU 线程数限定 1–32，默认 8。

## 候选与失败证据

对每个部位使用 box + 正负点请求多候选，选择违反点约束最少的候选，以其低分辨率 logits 再请求精化；在初始和精化候选中先比较负点误包含数、正点缺失数，最后比较 SAM 预测分数。没有分数阈值验收、颜色规则、书名规则或固定场景点位，也不填洞、清除细碎区域或自动修复轮廓。[官方单图接口](https://github.com/facebookresearch/sam2/blob/2b90b9f5ceec907a1c18123530e92e794ad901a4/sam2/sam2_image_predictor.py)定义了该候选、分数及 logits 精化流程。

stdout 只输出一个 JSON，库诊断写 stderr。成功退出为 0，并返回 `ok:true`、`candidateOnly:true`；成功仅表示工作器及点约束检查完成。输出目录保留：

- `target-union.png`：各目标部位的并集，原图归一方向后的尺寸，灰度值只有 0/255。
- `exclusion-union.png`：各排除对象的并集，同尺寸，允许全黑。
- `result.json`：来源/权重/配置摘要、调用者提供的引擎版本事实、每部位候选与点检查、并集重叠和差集后的像素数、时长。目标正点被排除并集覆盖时另报冲突；普通区域重叠不自动视为失败。

有任一部位正点缺失、负点误包含，或排除并集会抹去目标正点时，退出码为 2、`ok:false`、错误为 `point_constraints_unsatisfied`，保留两张临时候选 PNG 及详细诊断。错误 facts 包含具体 `label`、归一化坐标、采样像素、`missingPositive`、`includedNegative` 及完整候选分数；`result.json.pointConstraintsSatisfied=false`。这些文件只能作为受配额限制的私有调试证据保存，不能作为有效蒙版或交付成果。其他非法输入也非零退出，不转换旧格式、放宽点约束或覆盖已有输出文件。

`image_mask_region_view` 是独立只读小框诊断。输入明确指定当前严格v2 `maskReceiptId`、完整原页归一化的 `region:{left,top,width,height}` 和必填 `points`（无点用 `[]`，最多16点）。小框按左上floor、右下ceil取原生尺寸，单边最多1024像素、面积最多100万像素，超限拒绝而不缩小。返回同坐标原图、raw投影、覆盖层三张无损PNG及逐点RGBA、SGPOT和选中事实；窗口外raw明确来自未经生成的原稿。三帧按完整组进入当前模型输入，可信运行时对象保留PNG字节，普通预览仍压缩。小框不登记完整蒙版或分割提案的查看证明，不改变回执、权限、遮挡授权或合成门禁。

## 本地 QA 证据

隔离 QA 原图为 1500 × 2000，使用 12 个目标部位、7 个排除对象。工作器保留原尺寸二值并集和 1328 像素重叠事实，并严格拒绝了两项失败：`right hand` 负点 `[0.853,0.635]`（像素 `[1279,1270]`）被包含；`apron ties` 正点 `[0.37,0.744]`（像素 `[555,1488]`）缺失。未删掉这些提示点以伪造通过，也未修改原图。该次 CPU embedding 约 0.399 秒、所有部位候选与精化约 0.816 秒，工作器内部总时长约 4.92 秒；不包含启动解释器前的时间，不是生产延迟承诺。

本地另完成 30 项检查，覆盖严格字段与数值、重复 JSON 键、大小上限、动画拒绝、约束优先于高分、原图摘要不变、原尺寸二值 PNG、失败点坐标，以及排除区域抹去目标正点的冲突拒绝。真实单部位请求验证了正常 `ok:true` 回执和空排除蒙版；新建隔离 EXIF 方向 6 副本验证了归一后 2000 × 1500 的坐标与输出，不改动原文件。单部位成功不代表完整人物蒙版通过。

严格人物替换 A 组的现有诊断记录尚未证明任何一页通过整页验收；这不代表独立动作、背景和文字修改 B 组的进度。分割候选的点检查、速度或二值输出均不能证明覆盖准确，更不能替代生图后对身份、比例、自然融合、非目标内容和文字的验收。
