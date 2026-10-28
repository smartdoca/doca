export const handoverEn = {
  "handover.open": "Hand over resources",
  "handover.title": "Resource handover · {name}",
  "handover.intro":
    "Select resources of this disabled account, choose a recipient, and review the changes before confirming. Unselected resources remain with this account.",
  "handover.scope":
    "Documents, libraries, knowledge books and ordinary files are supported. Document attachments follow their document. Personal AI files, private conversations, credentials and plugin business data remain with the original account.",
  "handover.inventory": "Resource inventory",
  "handover.recipient": "Recipient",
  "handover.recipientSearch": "Find an active account",
  "handover.chooseRecipient": "Choose a recipient",
  "handover.refineSearch":
    "More accounts match. Refine your search to find the recipient.",
  "handover.filter": "Search resources",
  "handover.all": "All resources",
  "handover.owned": "Owned resources",
  "handover.access": "Retained grants",
  "handover.managed": "Managed files",
  "handover.selected": "{count} selected",
  "handover.selectPage": "Select this page",
  "handover.clear": "Clear selection",
  "handover.retained": "Ownership unchanged · {count} affected items",
  "handover.cancelInvitations":
    "Cancel {count} pending invitations for the source or recipient on these resources.",
  "handover.previousPage": "Previous page",
  "handover.nextPage": "Next page",
  "handover.folderAdmin": "Folder administrator",
  "handover.name": "Resource",
  "handover.kind.resource": "Document / library / knowledge book",
  "handover.kind.folder": "Folder",
  "handover.kind.file": "File",
  "handover.kind.resource_access": "Document / library grant",
  "handover.kind.folder_access": "Shared folder grant",
  "handover.with_document": "Follows its document",
  "handover.system_file": "Managed by its original business",
  "handover.invalid_metadata": "Metadata needs review",
  "handover.deleted": "In trash",
  "handover.empty": "No matching resources",
  "handover.preview": "Preview handover",
  "handover.review": "Review changes",
  "handover.summary":
    "{count} changes · {affected} affected documents/libraries · {size} of file content",
  "handover.confirmHelp":
    "Selected trees include resources owned by this account and their document attachments. Other owners keep ownership; inherited access may change. Confirmed grants are assigned to the recipient and the source grants are removed. The original account stays disabled.",
  "handover.ownership": "Transfer ownership",
  "handover.attachment": "Follow document",
  "handover.accessChange": "Assign {role} permission",
  "handover.descendants": "Includes descendants",
  "handover.nodeOnly": "This node only",
  "handover.personalRoot": "Move to recipient’s personal root",
  "handover.unchanged": "Keep location",
  "handover.location": "Location: {path}",
  "handover.conflicts":
    "Resolve these conflicts or change the selection before confirming.",
  "handover.conflict.permission_scope":
    "Would broaden permission beyond the source grant",
  "handover.conflict.permission_restricted":
    "Conflicts with the recipient’s existing restrictions",
  "handover.conflict.grant_shape":
    "Different node and descendant roles require separate permission review",
  "handover.conflict.protected_file":
    "Contains a protected or unrecognized file binding",
  "handover.confirm": "Confirm handover",
  "handover.back": "Change selection",
  "handover.success":
    "{count} changes committed. The inventory has been refreshed; remaining resources are listed below.",
  "handover.selectionLimit":
    "Select up to 500 entries per batch. Selecting a parent includes its eligible children.",
  "handover.error.forbidden":
    "Only an active system administrator can hand over resources.",
  "handover.error.sourceDisabled":
    "This account is no longer disabled. Handover is paused.",
  "handover.error.targetActive": "Choose a different, active recipient.",
  "handover.error.changed":
    "Resources or permissions changed, or this batch was already committed. Refresh the inventory and preview again.",
  "handover.error.conflict":
    "This batch contains permission or file conflicts. Review the preview.",
  "handover.error.selection": "Select between 1 and 500 available entries.",
} as const;

export const handoverZh: Record<keyof typeof handoverEn, string> = {
  "handover.open": "资源交接",
  "handover.title": "资源交接 · {name}",
  "handover.intro":
    "勾选已停用账号的资源，选择接收人，预览变化后确认交接。未选择的资源继续保留在原账号名下。",
  "handover.scope":
    "支持文档、知识库、知识册和普通文件。文档附件随文档交接；个人 AI 文件、私有会话、凭据和插件业务数据保留在原账号。",
  "handover.inventory": "资源清单",
  "handover.recipient": "接收人",
  "handover.recipientSearch": "搜索正常使用的账号",
  "handover.chooseRecipient": "请选择接收人",
  "handover.refineSearch": "还有更多匹配账号，请缩小搜索范围查找接收人。",
  "handover.filter": "搜索资源名称",
  "handover.all": "全部资源",
  "handover.owned": "名下资源",
  "handover.access": "保留的授权",
  "handover.managed": "业务管理的文件",
  "handover.selected": "已选 {count} 项",
  "handover.selectPage": "选择本页",
  "handover.clear": "清空选择",
  "handover.retained": "所有权保留 · {count} 项关联内容",
  "handover.cancelInvitations":
    "取消这些资源中原账号或接收人的 {count} 个待接受邀请。",
  "handover.previousPage": "上一页",
  "handover.nextPage": "下一页",
  "handover.folderAdmin": "文件夹管理员",
  "handover.name": "资源",
  "handover.kind.resource": "文档 / 知识库 / 知识册",
  "handover.kind.folder": "文件夹",
  "handover.kind.file": "文件",
  "handover.kind.resource_access": "文档 / 知识库授权",
  "handover.kind.folder_access": "共享文件夹授权",
  "handover.with_document": "随所属文档交接",
  "handover.system_file": "由原业务管理，保留归属",
  "handover.invalid_metadata": "元数据需要核实",
  "handover.deleted": "回收站中",
  "handover.empty": "没有匹配的资源",
  "handover.preview": "预览交接",
  "handover.review": "确认交接内容",
  "handover.summary":
    "共 {count} 项变更 · 影响 {affected} 个文档或知识库 · 文件内容 {size}",
  "handover.confirmHelp":
    "所选目录包含原账号拥有的子项及文档附件。其他人的所有权保留，继承权限可能变化。确认的授权将授予接收人并移除原授权，原账号保持停用。",
  "handover.ownership": "转移所有权",
  "handover.attachment": "随文档交接",
  "handover.accessChange": "授予{role}权限",
  "handover.descendants": "包含后代",
  "handover.nodeOnly": "仅本节点",
  "handover.personalRoot": "移至接收人的个人根目录",
  "handover.unchanged": "保留当前位置",
  "handover.location": "当前位置：{path}",
  "handover.conflicts": "请先解决以下冲突或调整选择，再确认交接。",
  "handover.conflict.permission_scope": "交接会扩大原授权范围",
  "handover.conflict.permission_restricted": "与接收人已有的明确限制冲突",
  "handover.conflict.grant_shape": "本节点和后代角色不同，需要单独复核权限",
  "handover.conflict.protected_file": "包含受保护或无法识别的文件绑定",
  "handover.confirm": "确认交接",
  "handover.back": "调整选择",
  "handover.success":
    "已完成 {count} 项变更，清单已重新扫描，下方显示剩余资源。",
  "handover.selectionLimit":
    "每批最多选择 500 项；选择父级会包含可交接的子项。",
  "handover.error.forbidden": "仅正常使用的系统管理员可以交接资源。",
  "handover.error.sourceDisabled": "原账号已不再停用，交接已暂停。",
  "handover.error.targetActive": "请选择另一个正常使用的接收账号。",
  "handover.error.changed":
    "资源或权限已变化，或本批次已完成。请刷新清单并重新预览。",
  "handover.error.conflict": "本批次存在权限或文件冲突，请检查预览。",
  "handover.error.selection": "请选择 1 至 500 项可交接资源。",
};
