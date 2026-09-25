# 个人文档扁平化与文档转移设计

日期：2026-09-18。状态：已确认需求（用户六点要求），本文档为实施依据。

## 需求（用户原文要点）

1. 取消个人文档树：个人文档不再有上下级，全部直接挂在个人下；删除侧边栏「我的文档」树。
2. 个人文档权限完全独立，不再有子文档继承（继承只存在于知识库内）。
3. 文档转移：
   - 个人文档可转给另一个人（所有权转移，**目标必须是本文档协作者**）；
   - 个人文档可转移到**自己有管理权限（rank≥4）的知识库节点**下：有知识库管理权限 → 可转到库根；只有库内某些文档的管理权限 → 可转到那些文档下；
   - 知识库文档可转移回个人，**仅文档所有者**可操作。
4. 左侧导航变为：搜索框、主页、AI助手、随手记、知识库、回收站（回收站从个人下拉框移入）。创作日历已从核心移除，未来由插件提供。
5. 打开个人文档（无论是否自己的）→ 独立页面，不显示左侧目录/侧边栏；文档左上角标题处显示返回图标。
6. 知识库文档的打开形态、管理形式完全不变。

## 关键现状（探索结论）

- `resources` 单表：`kind=document|library`，`library_id=null` 即个人文档，`parent_id` 为父文档。
- 权限继承沿 `coalesce(parent_id, library_id)` 链；内存版 `packages/core/src/modules/access/policy.ts: namedPermission`，SQL 版 `access/queries.ts: roleQuery`。个人文档一旦没有 `parent_id`，继承链自然终止 —— **继承代码本身不需要改**。
- 已有接口：`POST /resources/:id/move`（commands.ts:375）、`POST /resources/:id/transfer`（commands.ts:230，已限 owner）、`POST /resources/:id/arrange`（拖拽排序）。
- 前端：hash 路由，`#/r/:id` 统一打开个人/知识库文档，差异仅在侧边栏模式（main.tsx:774-896）。个人树 = `tree.tsx DocumentTree`；回收站在 `account-menu.tsx:146`；`MoveDialog`/`TransferDialog` 在 `dialogs.tsx`；主页 dashboard 已有新建按钮（dashboard.tsx:206）。
- 系统尚未上线，个人文档扁平化直接作为当前模型实现，不新增历史数据迁移。

## 后端设计

不保留个人文档扁平化迁移脚本：系统尚未上线，测试数据库直接按新规则创建。知识库文档移回个人时，服务端在同一事务内将受影响子树扁平化，并物化原继承的命名权限与策略字段。

### commands.ts 行为变更

- **create**：`parentId` 解析后若 `library_id` 为 null（父节点是个人文档）→ `fail(400, "个人文档不支持子文档")`。
- **arrange**：个人文档不再参与：`r.library_id` 或 `target.library_id` 为 null → `fail(400, "个人文档不支持层级排序")`（原先的个人拖拽分支删除）。
- **move**：
  - 目标是个人文档父节点（`parentId` 提供但解析出 `libraryId=null`）→ 400「个人文档不支持子文档」。
  - 源是个人文档：目标必须落入知识库（否则 400「个人文档没有目录层级」）；且要求 `owner_id === actor`（否则 403「仅文档所有者可以转移文档」）；且 actor 对目标容器（目标父文档，或库根）`permission() ≥ 4`（否则 403「需要目标知识库或文档的管理权限」）。
  - 源在知识库、目标为个人（`libraryId=null, parentId=null`）：要求 `owner_id === actor`（403 同上）。保留现有「出库转私有」逻辑（custom + invited）。
  - 知识库内/跨知识库移动：维持现有语义不变（manage_structure + edit_content 目标 + protectManagers）。
- **transfer**（所有权）：源为个人文档时，目标用户必须是本档协作者 —— 存在本资源的 `grants` 行或 `share_members` 行，且不在 `member_exclusions` 中；否则 `fail(400, "只能转移给本文档的协作者")`。知识库文档的 transfer 不变。

### 不需要改的部分

`policy.ts`/`inheritance.ts`/`queries.ts` 的继承递归（个人文档无父级后自然终止）、`trash`/`restore`/`purgeTrash`（个人文档 descendants 恒为自身）、`protectManagers`、`update()` 的 authz_revision 触发字段。

## 前端设计

### main.tsx 侧边栏（个人模式）

- 删除「我的文档」标题栏 + 新建按钮 + 个人 `DocumentTree`（约 main.tsx:858-894 的个人分支）。
- 导航顺序：搜索框（现有按钮）、**主页 `#/home`（新增 nav 项）**、AI助手、随手记、知识库、**回收站 `#/trash`（新增）**。
- `account-menu.tsx`：删除回收站条目。

### 独立个人文档页

- 路由仍为 `#/r/:id`；当已加载详情的文档 `library_id === null` 时：不渲染 `<aside className="sidebar">`；顶栏左侧渲染返回图标按钮（ArrowLeft），点击 `history.back()`，无历史时回退 `#/home`。标题、收藏、右侧操作区保持不变。
- 知识库文档（`library_id` 非空）保持现有知识库模式侧边栏，完全不变。

### 转移相关 UI

- `MoveDialog`（dialogs.tsx）+ `prepareMove`（main.tsx:545-559）：
  - 目标候选只包含：actor rank≥4 的**知识库**（作为库根目标）和 rank≥4 的**知识库内文档**；排除所有个人文档。
  - 源是知识库文档且 actor 是 owner 时，列表顶部提供「个人文档」目标（对应 `libraryId=null, parentId=null`）。
- `TransferDialog`（dialogs.tsx:90-154）：源为个人文档时，目标人选限制为当前协作者 —— 拉取 `GET /resources/:id/permission-overview` 的 members（排除所有者和自己）做选择列表，不再用全站 PersonPicker。知识库文档保持 PersonPicker 不变。
- `DocumentMore` 的「移动位置」入口：个人文档仅 owner 可见（知识库文档仍 role≥manager 不变）。

## 测试

- 新增 `tests/personal-docs-flat.test.ts`：
  - 个人文档 create 带 parentId → 400；arrange 个人文档 → 400；
  - move 个人→知识库：非 owner → 403；owner 但对目标只有 edit(3) → 403；对库根 rank≥4 → 可到库根；只对库内某文档 rank≥4 → 可到该文档下、不能到库根；
  - move 知识库→个人：非 owner manager → 403；owner → 成功且转私有（custom+invited）；
  - transfer 个人文档给非协作者 → 400；给协作者 → 200；知识库文档 transfer 不受影响。
- 修复受影响的现有测试：grep `parentId` 的个人树用法（permission-inheritance / permissions-v2 / tree-order / trash / experience 等），继承场景一律改为在知识库内构造；纯个人层级场景删除或改写。
- 迁移测试不做自动化（测试库建库即跑完全部迁移，无旧数据），用一次性脚本在临时 sqlite 上验证物化逻辑。

## 文档更新

- `docs/permission-inheritance.md`：个人文档不再有层级与继承，继承仅存在于知识库内。
- `docs/product-design.md`：导航结构改为新六点；个人文档独立页 + 返回图标。
- `docs/api.md`：move/transfer/arrange/create 的新约束。
