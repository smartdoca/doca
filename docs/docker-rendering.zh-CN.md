# Docker 文档渲染器

[English](docker-rendering.md)

本次改造后的镜像使用 WeasyPrint 70.0 导出富文本/Markdown PDF，使用 Node、原生 Canvas 和 resvg 生成 AI 画板图片；不安装 Chromium 或 Playwright 运行时，不需要宿主 seccomp JSON、额外共享内存或浏览器用户命名空间设置。必须重新构建镜像后使用新 Compose；已发布旧镜像不会自动获得新渲染器。

PDF 读取、逐页文字与图像提取及可编辑导入继续使用 PDF.js。LibreOffice Writer、Calc、Impress、Math 继续负责 `.docx`、`.xlsx`、`.pptx` 的视觉转换，中文及 Liberation 字体继续保留。公式、流程图、嵌入图片、长表格和中文分页需要实际导出检查，健康检查不能代替视觉验收。

PDF 任务使用 `DOCA_PDF_PYTHON=/opt/doca-pdf/bin/python` 启动固定 Python 环境，只允许内嵌 data 资源，拒绝网络/宿主文件读取；损坏或无法读取的图片/字体不能静默交付不完整 PDF。每个任务保留 32 MiB 输入、两个并发、60 秒期限以及权限二次校验。Node 画板任务继续通过宿主授权素材回调读取图片，保留场景/选区/裁剪、告警、排队和取消行为。两种任务在超时/取消时终止独立进程。

旧 `DOCA_PDF_CHROMIUM` 配置会明确报错，不自动启用旧渲染器。现有文档、数据库、附件、密钥与持久卷保持原状；已有 SDK 历史读取规则沿用原路径，不转换存量数据。回滚恢复原代码、依赖锁和镜像，并保留之后写入的数据及原部署配置。旧版 `docker/chromium-seccomp.*` 仅保留来源记录和旧版对照验收用途，不再随新部署包交付。

## 镜像体积与更新下载量

移除浏览器会减少镜像内容，但 Python/Pango/resvg 会占用空间，LibreOffice、字体、应用依赖和 Web 资源仍然保留。实际下载量以相同版本/架构构建的压缩层对比为准，不以 Docker Desktop 多架构本地占用推算。

Web、通用依赖及各编辑器继续独立分层，部署路径和权限不变。见[分层核验记录](verification/image-web-layers-2026-10-23.md)。

## 容器验收

```sh
DOCA_RELEASE_QA_IMAGE=your-rebuilt-image node scripts/qa-release-render-image.mjs arm64
```

x86-64 使用 `amd64`。验收在非 root、无网络、只读根文件系统的一次性容器中检查真实 PDF、画板像素和 Office 转换，不挂载用户文档；默认 Docker 安全策略即可。生产部署另须验证实际宿主，单个架构的成功不代表另一架构已验证。

## 可选 SAM 运行环境

默认镜像不包含可用的 SAM2/PyTorch 运行环境、分割工作器或模型权重。PDF/Office 读取不需要 SAM；分割是管理员独立安装的可选能力，AI 任务不会下载安装。

使用精确的已批准 Doca 镜像构建管理员自己的 Linux 运行镜像。以 Bookworm Python 3.11 CPU 环境为例，独立部署 Dockerfile 可写为：

```dockerfile
ARG DOCA_IMAGE
FROM ${DOCA_IMAGE}
USER root
RUN apt-get update \
    && apt-get install --yes --no-install-recommends python3 python3-venv libgomp1 \
    && rm -rf /var/lib/apt/lists/*
USER node
```

构建参数使用真实已批准的镜像摘要，例如 `docker build --build-arg DOCA_IMAGE=docker.io/smartdoca/doca@sha256:YOUR_APPROVED_DIGEST -t doca-sam-runtime:local .`；示例不虚构具体摘要。必须在此 Linux 镜像内、按其 CPU 架构和运行时相同的 `/opt/doca-segment` 路径准备 Python 环境，不能复制 macOS venv。Linux/amd64 可按 [PyTorch 2.5.1 官方 CPU wheel 安装说明](https://pytorch.org/get-started/previous-versions/#v251)安装 torch 2.5.1、torchvision 0.20.1；其他架构须单独核实可用 wheel 与 profile 版本事实。

管理员可信目录包含对应发行版本的工作器、固定依赖、固定官方 SAM2 的无符号链接运行副本、预先提供的权重和严格 profile。所有路径、版本及文件/树摘要都来自真实 Linux 环境，见 [Linux profile 生成步骤](ai-image-segmentation.md#linux-docker-profile)。目录由管理员拥有，并允许容器 UID 1000 读取；文件及目录不得由组或其他账号写入，模型无权选择这些路径。

使用 Docker Compose 2.24.4 或更新版本创建 `compose.segmentation.yaml`；`!reset` 移除基础文件的应用构建配置，避免覆盖独立构建的可信运行镜像：

```yaml
services:
  doca:
    build: !reset null
    image: doca-sam-runtime:local
    pull_policy: never
    environment:
      DOCA_AI_IMAGE_SEGMENT_PROFILE: /opt/doca-segment/profile.json
    volumes:
      - type: bind
        source: /srv/doca-segment-linux
        target: /opt/doca-segment
        read_only: true
        bind:
          create_host_path: false
```

此挂载独立于 `/data`、用户上传文件和凭据，不能加入模型密钥、QA 登录态或家人照片。只在 `.env` 填写变量不会通过基础 Compose 传入，也不会替代挂载。先在不挂载应用数据库的一次性容器中验证 profile；非法配置拒绝启动，运行文件不可用或摘要不符时不开放工具。重建正式容器时须保留所有需要的 override：

```sh
docker compose -f compose.yaml -f compose.segmentation.yaml config --quiet
docker compose -f compose.yaml -f compose.segmentation.yaml up -d
```

安装和摘要校验不证明蒙版或图片质量；每个候选、蒙版和交付仍须实际看图及权限/来源验证。升级权重需要新的完整运行环境和 profile，并协调重启，不转换旧 profile 或持久蒙版。

## 构建隐私

`.dockerignore` 排除 `.cache`、`.local`、数据库、环境文件、测试及脚本；排除不删除本地文件。运行环境包、权重、私有验收产物和凭据应保存在应用构建目录之外。SAM 自定义镜像使用独立的最小构建目录，仅放入批准的部署文件。


Web 输出还独立拆为 CAD、字体、入口、8 个大文件组（至少 512 KiB）和 16 个按稳定文件名分配的其余代码组。Vite 内容哈希导致的改名仍留在原组，部署路径、字节和权限保持相同。真实编译 Web 的 OCI 实验在一次入口代码更新/改名后复用 27 层中的 25 层，新下载压缩层共 334,554 字节；真实 Vite CSS 重建还可复用 27 层中的 13 层，新层共 4,489,097 压缩字节（比旧整块 Web 层少约 77.2%）；这些都是实测案例，每次实际更新量取决于改动，完整 Web 层有少量额外头部开销。详见[分层核验记录](verification/image-web-layers-2026-10-23.md)。
