# Docker 文档渲染器

[English](docker-rendering.md)

当前检出的 Dockerfile 安装 Debian Bookworm 的 Chromium、沙箱组件、中文及 Liberation 字体，以及 LibreOffice Writer、Calc、Impress、Math。必须重新构建并发布镜像后才具有这些新增能力，不能据此声称已发布的 `0.1.11` 镜像包含它们。

镜像显式设置 `DOCA_PDF_CHROMIUM=/usr/bin/chromium`、`DOCA_OFFICE_RENDERER=/usr/bin/soffice`，使用非 root 的 `node` 用户运行。Writer、Calc、Impress 覆盖支持的 `.docx`、`.xlsx`、`.pptx` 视觉转换，Math 提供嵌入公式渲染；`--no-install-recommends` 避免完整 LibreOffice 元包及无关推荐程序，Draw 等必要的间接依赖仍会安装。浏览器、字体和 Office 会增加镜像体积与渲染内存占用。缺少原稿字体可能改变换行和公式，健康检查不能替代实际文档的视觉检查。

每次 Office 转换都在私有 `/tmp/doca-office-render-*` 临时目录中启动独立 headless 进程和全新的 LibreOffice 用户配置，120 秒超时，成功或失败后均清理临时目录。容器 `node` 用户必须能写入 `/tmp`；不要挂载桌面用户的 Office 配置，或改为 root 才能运行。旧二进制 Office 格式、主动内容和不支持的外部资源仍会拒绝，转换失败不会伪装成完整文本读取。详见 [AI 附件](ai-attachments.md)。

## Linux Chromium 沙箱

应用明确启用 Chromium 沙箱，容器及宿主安全策略须允许用户命名空间。安装沙箱包并以非 root 运行仍不足以赋予这些权限。[Playwright 官方 Docker 文档](https://playwright.dev/docs/docker)使用默认 seccomp 策略，加上用户命名空间所需的 `clone`、`setns`、`unshare` 许可。

基础 Compose 已加载固定、未修改的 Playwright v1.62.1 官方策略 `docker/chromium-seccomp.json`，SHA-256 为 `cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849`，并提供独立共享内存。宿主策略文件须与 Compose 来自同一批准检出/发行版本，应用启动时不会下载或改写它。[来源与许可证](../docker/chromium-seccomp.md)已随文件保留。自定义部署须保留以下设置：

```yaml
services:
  doca:
    security_opt:
      - seccomp=./docker/chromium-seccomp.json
    shm_size: "1gb"
```

校验并应用基础部署：

```sh
docker compose config --quiet
docker compose up -d
```

基础 Compose 已设置 `init: true`；独立共享内存避免共享宿主 IPC。这套配置不需要 `--privileged`、`seccomp=unconfined` 或 `--no-sandbox`。宿主仍禁止用户命名空间时，应由管理员配置受支持的宿主策略或执行环境，应用不会因启动失败而关闭沙箱。部署时必须实际导出 PDF，不能只检查版本命令；[Playwright 不保证任意外部 Chromium 版本](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-option-executable-path)，浏览器或 Playwright 升级后须重验。

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
