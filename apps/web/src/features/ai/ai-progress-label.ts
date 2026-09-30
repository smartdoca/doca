import type { MessageKey, MessageValues } from "@doca/i18n";
import type {
  AIApproval,
  AIApprovalCode,
  AIProgress,
  AIProgressEvent,
  AIProgressEventCode,
  AIProgressPhase,
} from "@core/modules/ai/progress.js";

type Translator = (key: MessageKey, values?: MessageValues) => string;

function labelKey(keys: Readonly<Record<string, MessageKey>>, code: string) {
  return Object.hasOwn(keys, code) ? keys[code] : undefined;
}

const phaseKeys = {
  analyzing_request: "ai.progress.phase.analyzing",
  waiting_approval: "ai.progress.phase.waitingApproval",
  approval_rejected: "ai.progress.phase.approvalRejected",
  resuming: "ai.progress.phase.resuming",
  waiting_choice: "ai.progress.phase.waitingChoice",
  waiting_access: "ai.progress.phase.waitingAccess",
  waiting_requirements: "ai.progress.phase.waitingRequirements",
  plan_ready: "ai.progress.phase.planReady",
  thinking: "ai.progress.phase.thinking",
  answering: "ai.progress.phase.answering",
  using_tool: "ai.progress.phase.usingTool",
  reviewing_delivery: "ai.progress.phase.reviewing",
  completed: "ai.progress.phase.completed",
} as const satisfies Record<AIProgressPhase, MessageKey>;

const eventKeys = {
  checkpoint_resumed: "ai.progress.event.checkpointResumed",
  retry_resumed: "ai.progress.event.retryResumed",
  image_saved: "ai.progress.event.imageSaved",
  folder_available: "ai.progress.event.folderAvailable",
  file_available: "ai.progress.event.fileAvailable",
  local_file_saved: "ai.progress.event.localFileSaved",
  history_compressing: "ai.progress.event.historyCompressing",
  history_compressed: "ai.progress.event.historyCompressed",
  history_compression_failed: "ai.progress.event.historyCompressionFailed",
  tool_call: "ai.progress.event.toolCall",
  approval_requested: "ai.progress.event.approvalRequested",
  access_requested: "ai.progress.event.accessRequested",
  shrinking_batch: "ai.progress.event.shrinkingBatch",
  image_receipt_missing: "ai.progress.event.imageReceiptMissing",
  folder_receipt_missing: "ai.progress.event.folderReceiptMissing",
  file_receipt_missing: "ai.progress.event.fileReceiptMissing",
  secret_receipt_missing: "ai.progress.event.secretReceiptMissing",
  spreadsheet_image_receipt_missing:
    "ai.progress.event.spreadsheetImageReceiptMissing",
  document_receipt_missing: "ai.progress.event.documentReceiptMissing",
  reviewing_delivery: "ai.progress.event.reviewingDelivery",
  review_passed: "ai.progress.event.reviewPassed",
  review_needs_action: "ai.progress.event.reviewNeedsAction",
} as const satisfies Record<AIProgressEventCode, MessageKey>;

const toolKeys = {
  task_plan: "ai.progress.tool.taskPlan",
  load_skill: "ai.progress.tool.loadSkill",
  image_generate: "ai.progress.tool.imageGenerate",
  image_show: "ai.progress.tool.imageShow",
  ask_user: "ai.progress.tool.askUser",
  image_insert: "ai.progress.tool.imageInsert",
  web_search: "ai.progress.tool.webSearch",
  web_fetch: "ai.progress.tool.webFetch",
  http_request: "ai.progress.tool.httpRequest",
  note_write: "ai.progress.tool.noteWrite",
  secret_write: "ai.progress.tool.secretWrite",
  secret_delete: "ai.progress.tool.secretDelete",
  knowledge_search: "ai.progress.tool.knowledgeSearch",
  knowledge_assistant_search: "knowledge.toolAssistantSearch",
  knowledge_instructions: "knowledge.toolInstructions",
  knowledge_settings: "knowledge.toolSettings",
  knowledge_subscribe: "knowledge.toolSubscribe",
  knowledge_curate: "knowledge.toolCurate",
  knowledge_assistant: "knowledge.toolAssistant",
  knowledge_entry: "knowledge.toolEntry",
  knowledge_review: "knowledge.toolReview",
  file_search: "ai.progress.tool.fileSearch",
  file_browse: "ai.progress.tool.fileBrowse",
  file_read: "ai.progress.tool.fileRead",
  file_manage: "ai.progress.tool.fileManage",
  file_folder_manage: "ai.progress.tool.fileFolderManage",
  file_download: "ai.progress.tool.fileDownload",
  file_create: "ai.progress.tool.fileCreate",
  page_state: "ai.progress.tool.pageState",
  document_request_access: "ai.progress.tool.documentRequestAccess",
  document_read: "ai.progress.tool.documentRead",
  document_create: "ai.progress.tool.documentCreate",
  document_edit: "ai.progress.tool.documentEdit",
  rich_text_edit: "ai.progress.tool.richTextEdit",
  markdown_edit: "ai.progress.tool.markdownEdit",
  canvas_edit: "ai.progress.tool.canvasEdit",
  presentation_edit: "ai.progress.tool.presentationEdit",
  spreadsheet_edit: "ai.progress.tool.spreadsheetEdit",
  resource_manage: "ai.progress.tool.resourceManage",
} as const satisfies Record<string, MessageKey>;

const approvalTitleKeys = {
  download_file: "ai.approval.downloadFile.title",
  create_file: "ai.approval.createFile.title",
  session_document_access: "ai.approval.sessionAccess.title",
  request_document_read_access: "ai.approval.requestRead.title",
  request_document_edit_access: "ai.approval.requestEdit.title",
  update_knowledge_instructions: "ai.approval.knowledgeInstructions.title",
  update_knowledge_settings: "ai.approval.knowledgeSettings.title",
  subscribe_knowledge_source: "ai.approval.knowledgeSubscribe.title",
  curate_knowledge: "ai.approval.knowledgeCurate.title",
  configure_knowledge_assistant: "ai.approval.knowledgeAssistant.title",
  write_knowledge_entry: "ai.approval.knowledgeWrite.title",
  review_knowledge_entry: "ai.approval.knowledgeReview.title",
  delete_files: "ai.approval.deleteFiles.title",
  copy_files: "ai.approval.copyFiles.title",
  rename_file: "ai.approval.renameFile.title",
  move_files: "ai.approval.moveFiles.title",
  create_folder: "ai.approval.createFolder.title",
  delete_folder: "ai.approval.deleteFolder.title",
  rename_folder: "ai.approval.renameFolder.title",
  copy_folder: "ai.approval.copyFolder.title",
  move_folder: "ai.approval.moveFolder.title",
  create_documents: "ai.approval.createDocuments.title",
  rename_document: "ai.approval.renameDocument.title",
  move_document: "ai.approval.moveDocument.title",
} as const satisfies Record<AIApprovalCode, MessageKey>;

const approvalDetailKeys = {
  download_file: "ai.approval.downloadFile.detail",
  create_file: "ai.approval.createFile.detail",
  session_document_access: "ai.approval.sessionAccess.detail",
  request_document_read_access: "ai.approval.requestAccess.detail",
  request_document_edit_access: "ai.approval.requestAccess.detail",
  update_knowledge_instructions: "ai.approval.knowledgeInstructions.detail",
  update_knowledge_settings: "ai.approval.knowledgeSettings.detail",
  subscribe_knowledge_source: "ai.approval.knowledgeSubscribe.detail",
  curate_knowledge: "ai.approval.knowledgeCurate.detail",
  configure_knowledge_assistant: "ai.approval.knowledgeAssistant.detail",
  write_knowledge_entry: "ai.approval.knowledgeWrite.detail",
  review_knowledge_entry: "ai.approval.knowledgeReview.detail",
  delete_files: "ai.approval.files.detail",
  copy_files: "ai.approval.files.detail",
  rename_file: "ai.approval.renameFile.detail",
  move_files: "ai.approval.files.detail",
  create_folder: "ai.approval.folders.detail",
  delete_folder: "ai.approval.folders.detail",
  rename_folder: "ai.approval.renameFolder.detail",
  copy_folder: "ai.approval.folders.detail",
  move_folder: "ai.approval.folders.detail",
  create_documents: "ai.approval.createDocuments.detail",
  rename_document: "ai.approval.renameDocument.detail",
  move_document: "ai.approval.moveDocument.detail",
} as const satisfies Record<AIApprovalCode, MessageKey>;

export function aiToolLabel(toolName: string, t: Translator) {
  const key = labelKey(toolKeys, toolName);
  return key ? t(key) : t("ai.progress.tool.generic", { name: toolName });
}

export function aiPhaseLabel(
  progress: AIProgress | null | undefined,
  t: Translator,
) {
  if (!progress) return t("chat.processing");
  if (progress.phase === "using_tool")
    return aiToolLabel(String(progress.phaseData?.toolName ?? "unknown"), t);
  const key = labelKey(phaseKeys, progress.phase);
  return key ? t(key) : t("chat.processing");
}

export function aiEventLabel(event: AIProgressEvent, t: Translator) {
  if (event.kind === "reasoning" || event.kind === "text") return event.text;
  if (event.code === "tool_call")
    return aiToolLabel(String(event.data?.toolName ?? "unknown"), t);
  const key = labelKey(eventKeys, event.code);
  return key ? t(key, event.data) : t("ai.progress.event.generic");
}

export function aiEventDetail(event: AIProgressEvent, t: Translator) {
  if (event.kind === "reasoning" || event.kind === "text") return undefined;
  return event.detailCode === "tool_failed_recovering"
    ? t("ai.progress.detail.toolFailedRecovering", event.detailData)
    : undefined;
}

function approvalValues(approval: AIApproval, t: Translator): MessageValues {
  const values = { ...approval.data };
  if (
    (approval.code === "create_documents" ||
      approval.code === "move_document") &&
    !values.path
  )
    values.path = t("ai.approval.location.personalDocuments");
  return values;
}

export function aiApprovalTitle(approval: AIApproval, t: Translator) {
  const key = labelKey(approvalTitleKeys, approval.code);
  return key
    ? t(key, approvalValues(approval, t))
    : t("ai.approval.generic.title");
}

export function aiApprovalDetail(approval: AIApproval, t: Translator) {
  const key = labelKey(approvalDetailKeys, approval.code);
  return key
    ? t(key, approvalValues(approval, t))
    : t("ai.approval.generic.detail");
}
