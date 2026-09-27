import { checkDocumentSize } from "../../access/operation-policy.js";
import {
  projectExlsxWorkbook,
  projectExlsxPlainText,
} from "@online-office/univer-sheet/model";
import {
  createExlsxBaseline,
  EXLSX_SCHEMA_VERSION,
  createExlsxCollaborationSession,
  restoreExlsxDocument,
  type ExlsxBaseline,
} from "@online-office/univer-sheet/yjs";
import { CANVAS_CODEC, CanvasModel } from "aidcanvas/model";
import {
  createPresentation,
  createYDocument,
  readDocument,
  resolveAnchor,
} from "@eppt/editor/core";
import {
  validatePresentation,
  validatePresentationUpdate,
  PPT_CODEC,
  PPT_SCHEMA,
} from "./presentation.js";
import type { Transaction } from "kysely";
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import type { DB, Resource, Schema } from "../../../../../db/src/index.js";
import { fail } from "../../../shared/errors.js";
import { enqueueProjection } from "../../automation/jobs.js";
import { enqueueKnowledge } from "../../knowledge/service.js";
import { b64, unb64 } from "../../collaboration/documents.js";
import { detachUnreferencedDocumentFiles, textMediaIds } from "../media.js";
import {
  checkProtocol,
  checkReceipt,
  saveReceipt,
  type EditorInput,
} from "../../collaboration/protocol.js";
import { recordVersion } from "../../history/repository.js";
import type { Actor } from "../../identity/passwords.js";
import { notify, validateNewMentions } from "../../interactions/community.js";
export const surfaceCodec = (format: string) =>
  format === "canvas"
    ? CANVAS_CODEC
    : format === "presentation"
      ? PPT_CODEC
      : "exlsx-cell-registers";
export const DEFAULT_SPREADSHEET_SCHEMA = EXLSX_SCHEMA_VERSION;
// Bound recursive untrusted payloads and keep asset URLs out of persisted state.
function validateJSON(value: unknown, depth = 0, budget = { n: 0 }) {
  if (++budget.n > 200000 || depth > 64) fail(413, "内容结构过大");
  if (!value || typeof value !== "object") return;
  for (const [key, v] of Object.entries(value)) {
    if (["__proto__", "constructor", "prototype"].includes(key))
      fail(400, "非法内容属性");
    if (
      ["url", "href", "sourceUrl", "resourcePath"].includes(key) &&
      typeof v === "string" &&
      /^(javascript:|data:|blob:)/i.test(v.trim())
    )
      fail(400, "不能保存不安全或临时资源地址");
    validateJSON(v, depth + 1, budget);
  }
}
export async function restoreSurface(
  tx: DB | Transaction<Schema>,
  id: string,
  format: string,
) {
  const state = await tx
    .selectFrom("document_states")
    .selectAll()
    .where("resource_id", "=", id)
    .executeTakeFirst();
  const epoch = await tx
    .selectFrom("editor_epochs")
    .selectAll()
    .where("resource_id", "=", id)
    .executeTakeFirst();
  if (!state || !epoch || state.codec !== surfaceCodec(format))
    fail(
      409,
      "此文档使用旧编码或尚未初始化；原数据保留，请新建文档使用新版编辑器",
    );
  if (
    format === "spreadsheet" &&
    (!epoch.baseline ||
      (JSON.parse(epoch.baseline) as ExlsxBaseline).schemaVersion !==
        DEFAULT_SPREADSHEET_SCHEMA)
  )
    fail(409, "此文档表格结构与当前编辑器不匹配，请新建文档");
  const updates = await tx
    .selectFrom("document_updates")
    .select("data")
    .where("resource_id", "=", id)
    .where("seq", ">", state.checkpoint_seq)
    .orderBy("seq")
    .execute();
  const update = Y.mergeUpdates([
    unb64(state.checkpoint, 16 * 1024 * 1024),
    ...updates.map((u) => unb64(u.data)),
  ]);
  return {
    state,
    epochId: epoch.epoch_id,
    baseline: epoch.baseline
      ? (JSON.parse(epoch.baseline) as ExlsxBaseline)
      : undefined,
    update,
  };
}
export async function provisionSurface(
  tx: Transaction<Schema>,
  resource: Resource,
  projection?: any,
) {
  const epochId = randomUUID(),
    now = new Date().toISOString();
  let baseline: ExlsxBaseline | undefined, update: Uint8Array;
  if (resource.format === "presentation") {
    const value = {
      ...(projection ?? createPresentation()),
      id: resource.id,
      title: resource.title,
    };
    await validatePresentation(tx, resource.id, value);
    const doc = createYDocument(value);
    try {
      update = Y.encodeStateAsUpdate(doc);
    } finally {
      doc.destroy();
    }
  } else if (resource.format === "canvas") {
    const model = CanvasModel.initialize(epochId, {
      version: 1,
      name: resource.title,
      scene: projection?.scene ?? { children: [] },
    });
    try {
      update = model.checkpoint().update;
    } finally {
      model.dispose();
    }
  } else {
    const sheetId = randomUUID();
    const bundle = await createExlsxBaseline(
      projection
        ? { ...projection, id: resource.id, name: resource.title }
        : ({
            id: resource.id,
            name: resource.title,
            appVersion: "0.25.1",
            locale: "zhCN",
            styles: {},
            sheetOrder: [sheetId],
            sheets: {
              [sheetId]: {
                id: sheetId,
                name: "Sheet1",
                rowCount: 1000,
                columnCount: 100,
                cellData: {},
              },
            },
          } as any),
      epochId,
      { schemaVersion: DEFAULT_SPREADSHEET_SCHEMA },
    );
    baseline = bundle.baseline;
    update = bundle.update;
  }
  if (projection !== undefined)
    await checkDocumentSize(
      tx,
      resource.id,
      Buffer.byteLength(JSON.stringify(projection)),
    );
  await tx
    .insertInto("editor_epochs")
    .values({
      resource_id: resource.id,
      epoch_id: epochId,
      baseline: baseline ? JSON.stringify(baseline) : null,
    })
    .execute();
  await tx
    .insertInto("document_states")
    .values({
      resource_id: resource.id,
      codec: surfaceCodec(resource.format),
      checkpoint: b64(update),
      checkpoint_seq: 0,
      seq: 0,
      text: "",
      updated_at: now,
    })
    .execute();
}
/** Independent copy only: a new resource, new baseline and new epoch; never used for checkpoint compaction. */
export async function copySurface(
  tx: Transaction<Schema>,
  source: Resource,
  target: Resource,
  assets: Map<string, string>,
) {
  const loaded = await restoreSurface(tx, source.id, source.format);
  let projection: any;
  if (source.format === "presentation") {
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, loaded.update);
      projection = readDocument(doc);
    } finally {
      doc.destroy();
    }
  } else if (source.format === "canvas") {
    const model = CanvasModel.restore({
      codec: CANVAS_CODEC,
      schemaVersion: 1,
      epochId: loaded.epochId,
      update: loaded.update,
    });
    try {
      projection = model.getValue();
    } finally {
      model.dispose();
    }
  } else {
    projection = await projectExlsxWorkbook({
      baseline: loaded.baseline!,
      update: loaded.update,
      checkpointSeq: loaded.state.checkpoint_seq,
    });
  }
  const rewrite = (value: any): void => {
    if (!value || typeof value !== "object") return;
    for (const [key, v] of Object.entries(value)) {
      if (typeof v === "string" && assets.has(v)) value[key] = assets.get(v);
      else rewrite(v);
    }
  };
  rewrite(projection);
  await provisionSurface(tx, target, projection);
}
export async function exchangeSurface(
  tx: Transaction<Schema>,
  actor: Actor | null,
  resource: Resource,
  rank: number,
  input: EditorInput,
) {
  const id = resource.id,
    codec = surfaceCodec(resource.format),
    now = new Date().toISOString();
  const epoch =
    resource.format === "spreadsheet"
      ? await tx
          .selectFrom("editor_epochs")
          .select("baseline")
          .where("resource_id", "=", id)
          .executeTakeFirst()
      : null;
  const schemaVersion =
    resource.format === "presentation"
      ? PPT_SCHEMA
      : resource.format === "spreadsheet"
        ? DEFAULT_SPREADSHEET_SCHEMA
        : 1;
  if (input.restoreVersion)
    fail(409, "此编辑器尚未提供保持锚点身份的历史回滚接口");
  // Reject invalid negotiation before provisioning.
  if (
    input.codec !== codec ||
    input.schemaVersion !== schemaVersion ||
    input.protocolVersion !== 1
  )
    fail(409, "编辑器协议不匹配");
  const existing = await tx
    .selectFrom("document_states")
    .select("codec")
    .where("resource_id", "=", id)
    .executeTakeFirst();
  if (!existing) {
    if (input.update !== undefined || input.epochId)
      fail(409, "请先加载服务端基线");
    await provisionSurface(tx, resource);
  }
  const loaded = await restoreSurface(tx, id, resource.format);
  checkProtocol(input, codec, schemaVersion, loaded.epochId);
  if (input.update !== undefined && (!actor || rank < 3))
    fail(403, "当前文档为只读");
  const receipt = await checkReceipt(tx, id, loaded.epochId, input);
  let contentBytes = 0;
  let embeddedMedia: Set<string> | null = null;
  let encoded = loaded.update,
    text = loaded.state.text;
  if (input.update !== undefined && !receipt?.old)
    encoded = Y.mergeUpdates([encoded, unb64(input.update)]);
  if (encoded.length > 16 * 1024 * 1024) fail(413, "文档达到协同容量上限");
  if (resource.format === "presentation") {
    const result = await validatePresentationUpdate(tx, id, encoded);
    text = result.text;
    contentBytes = result.contentBytes;
    encoded = result.update;
  } else if (resource.format === "canvas") {
    const candidate = new Y.Doc();
    try {
      Y.applyUpdate(candidate, encoded);
      if (candidate.store.pendingDs || candidate.store.pendingStructs)
        fail(409, "更新缺少依赖");
      for (const key of candidate.share.keys())
        if (!["meta", "elements"].includes(key)) fail(400, "未知画布数据通道");
      validateJSON(candidate.toJSON());
    } finally {
      candidate.destroy();
    }
    const model = CanvasModel.restore({
      codec: CANVAS_CODEC,
      schemaVersion: 1,
      epochId: loaded.epochId,
      update: encoded,
    });
    try {
      const value = model.getValue();
      contentBytes = Buffer.byteLength(JSON.stringify(value));
      validateJSON(value);
      const collect = (n: any): string =>
        [
          typeof n.text === "string" ? n.text : "",
          ...(n.children ?? []).map(collect),
        ].join("\n");
      text = collect(value.scene);
      embeddedMedia = textMediaIds(JSON.stringify(value));
      const assets = (n: any) => {
        if (
          n.tag === "Image" &&
          !/^[a-f0-9-]{36}$/.test(n.data?.resourcePath ?? "")
        )
          fail(400, "图片必须通过本系统上传");
        (n.children ?? []).forEach(assets);
      };
      assets(value.scene);
      encoded = model.checkpoint().update;
    } finally {
      model.dispose();
    }
  } else {
    const doc = await restoreExlsxDocument({
      baseline: loaded.baseline!,
      update: encoded,
      checkpointSeq: loaded.state.checkpoint_seq,
    });
    try {
      if (doc.store.pendingDs || doc.store.pendingStructs)
        fail(409, "更新缺少依赖");
      if (doc.getMap("exlsx:metadata").size !== 5) fail(400, "非法表格元数据");
      validateJSON(doc.toJSON());
      text = await projectExlsxPlainText({
        baseline: loaded.baseline!,
        update: encoded,
        checkpointSeq: loaded.state.checkpoint_seq,
      });
      encoded = Y.encodeStateAsUpdate(doc);
      const workbook = await projectExlsxWorkbook({
        baseline: loaded.baseline!,
        update: encoded,
        checkpointSeq: loaded.state.checkpoint_seq,
      });
      embeddedMedia = textMediaIds(JSON.stringify(workbook));
      contentBytes = Buffer.byteLength(JSON.stringify(workbook));
    } finally {
      doc.destroy();
    }
  }
  // Normalize full encodings on both sides, not a diff's byte length (delete sets persist).
  const before = new Y.Doc();
  Y.applyUpdate(before, loaded.update);
  const prior = b64(Y.encodeStateAsUpdate(before));
  before.destroy();
  const changed =
    input.update !== undefined && !receipt?.old && b64(encoded) !== prior;
  const seq = loaded.state.seq + Number(changed),
    checkpoint =
      changed &&
      (seq % 50 === 0 ||
        Date.now() - Date.parse(loaded.state.updated_at) > 300000);
  if (changed) {
    await checkDocumentSize(tx, id, contentBytes);
    await enqueueProjection(tx, "search", id, { resourceId: id });
    await enqueueKnowledge(tx, "document", id);
    if (embeddedMedia)
      await detachUnreferencedDocumentFiles(tx, id, embeddedMedia);
    if (resource.format === "spreadsheet") {
      const users = (snapshot: any) => {
        const ids = new Set<string>();
        for (const sheet of Object.values(snapshot.sheets) as any[])
          for (const row of Object.values(sheet.cellData ?? {}) as any[])
            for (const cell of Object.values(row) as any[]) {
              for (const range of cell?.p?.body?.customRanges ?? []) {
                const node = range.properties?.exlsxInlineV1;
                if (node?.type === "user" && typeof node.refId === "string")
                  ids.add(node.refId);
              }
              const o = cell?.custom?.officeObject;
              if (
                o?.version === 1 &&
                o.kind === "mention" &&
                typeof o.id === "string" &&
                cell.v === "@" + o.label
              )
                ids.add(o.id);
            }
        return ids;
      };
      const before = users(
        await projectExlsxWorkbook({
          baseline: loaded.baseline!,
          update: loaded.update,
          checkpointSeq: loaded.state.checkpoint_seq,
        }),
      );
      const after = users(
        await projectExlsxWorkbook({
          baseline: loaded.baseline!,
          update: encoded,
          checkpointSeq: loaded.state.checkpoint_seq,
        }),
      );
      await validateNewMentions(tx, actor!, after, before);
      await notify(
        tx,
        actor!,
        resource,
        "document.mentioned",
        [...after].filter((id) => !before.has(id)),
        undefined,
        `document:${id}:${seq}`,
      );
    }
    await tx
      .insertInto("document_updates")
      .values({
        resource_id: id,
        seq,
        data: input.update!,
        author_id: actor!.id,
        created_at: now,
      })
      .execute();
    await tx
      .updateTable("document_states")
      .set({
        seq,
        text,
        ...(checkpoint
          ? { checkpoint: b64(encoded), checkpoint_seq: seq, updated_at: now }
          : {}),
      })
      .where("resource_id", "=", id)
      .execute();
    if (checkpoint) {
      await tx
        .deleteFrom("document_updates")
        .where("resource_id", "=", id)
        .where("seq", "<=", seq)
        .execute();
      await recordVersion(tx, {
        id: randomUUID(),
        resource_id: id,
        seq,
        checkpoint: b64(encoded),
        title: resource.title,
        author_id: actor!.id,
        created_at: now,
      });
      await tx
        .insertInto("audit_events")
        .values({
          id: randomUUID(),
          resource_id: id,
          actor_id: actor!.id,
          action: "document.updated",
          created_at: now,
        })
        .execute();
    }
    await tx
      .updateTable("resources")
      .set({
        version: resource.version + 1,
        updated_at: now,
        last_editor_id: actor!.id,
        last_edited_at: now,
      })
      .where("id", "=", id)
      .execute();
  }
  await saveReceipt(tx, id, loaded.epochId, input, receipt, seq);
  const last = resource.last_editor_id
    ? await tx
        .selectFrom("users")
        .select("display_name")
        .where("id", "=", resource.last_editor_id)
        .executeTakeFirst()
    : null;
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, encoded);
    return {
      codec,
      schemaVersion,
      protocolVersion: 1,
      epochId: loaded.epochId,
      baseline: loaded.baseline,
      seq,
      checkpointSeq: checkpoint ? seq : loaded.state.checkpoint_seq,
      rank,
      changed: !!changed,
      notificationsChanged: changed && resource.format === "spreadsheet",
      metadata: {
        title: resource.title,
        version: resource.version + Number(changed),
        updated_at: changed ? now : resource.updated_at,
        lastEditorName: changed
          ? actor!.display_name
          : (last?.display_name ?? null),
        lastEditedAt: changed ? now : resource.last_edited_at,
      },
      vector: b64(Y.encodeStateVector(doc)),
      update: b64(
        Y.encodeStateAsUpdate(
          doc,
          input.vector === undefined ? undefined : unb64(input.vector, 65536),
        ),
      ),
    };
  } finally {
    doc.destroy();
  }
}
export async function surfaceAnchor(
  tx: DB | Transaction<Schema>,
  id: string,
  format: string,
  anchor: any,
) {
  const loaded = await restoreSurface(tx, id, format);
  if (format === "presentation") {
    const ids =
      anchor?.type === "element" ? [anchor.elementId] : anchor?.elementIds;
    if (
      anchor?.epochId !== loaded.epochId ||
      !["element", "elements"].includes(anchor?.type) ||
      typeof anchor.slideId !== "string" ||
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 100 ||
      !ids.every((v: unknown) => typeof v === "string" && v.length < 160)
    )
      fail(400, "幻灯片选区无效");
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, loaded.update);
      const resolved = resolveAnchor(doc, {
        type: "elements",
        slideId: anchor.slideId,
        elementIds: ids,
      });
      if (!resolved) fail(409, "所选内容已删除");
      return {
        type: "elements",
        epochId: loaded.epochId,
        slideId: resolved.slideId,
        elementIds: resolved.elementIds,
      };
    } finally {
      doc.destroy();
    }
  }
  if (format === "canvas") {
    if (
      anchor?.type !== "elements" ||
      anchor.epochId !== loaded.epochId ||
      !Array.isArray(anchor.elementIds) ||
      anchor.elementIds.length > 100 ||
      !anchor.elementIds.every(
        (v: unknown) => typeof v === "string" && v.length < 160,
      )
    )
      fail(400, "画布选区无效");
    const model = CanvasModel.restore({
      codec: CANVAS_CODEC,
      schemaVersion: 1,
      epochId: loaded.epochId,
      update: loaded.update,
    });
    try {
      const resolved = model.resolveAnchor(anchor);
      if (!resolved.valid) fail(409, "所选内容已删除");
      return model.captureAnchor(resolved.elementIds);
    } finally {
      model.dispose();
    }
  }
  if (
    anchor?.version === 4 &&
    loaded.baseline?.schemaVersion === DEFAULT_SPREADSHEET_SCHEMA
  ) {
    const validIds = (ids: unknown): ids is string[] =>
      Array.isArray(ids) &&
      ids.length > 0 &&
      ids.length <= 10000 &&
      new Set(ids).size === ids.length &&
      ids.every(
        (id) =>
          typeof id === "string" &&
          /^(?:[br]:(?:0|[1-9]\d*)|i:[a-f0-9-]{36})$/.test(id),
      );
    if (
      typeof anchor.sheetId !== "string" ||
      !anchor.sheetId ||
      anchor.sheetId.length > 160 ||
      anchor.epochId !== loaded.epochId ||
      !validIds(anchor.rowIds) ||
      !validIds(anchor.columnIds)
    )
      fail(400, "表格评论身份范围无效");
    const normalized = {
      version: 4 as const,
      epochId: loaded.epochId,
      sheetId: anchor.sheetId,
      rowIds: anchor.rowIds,
      columnIds: anchor.columnIds,
      startRowId: anchor.rowIds[0],
      endRowId: anchor.rowIds.at(-1),
      startColumnId: anchor.columnIds[0],
      endColumnId: anchor.columnIds.at(-1),
    };
    const doc = await restoreExlsxDocument({
      baseline: loaded.baseline,
      update: loaded.update,
      checkpointSeq: loaded.state.checkpoint_seq,
    });
    try {
      const session = await createExlsxCollaborationSession({
        doc,
        baseline: loaded.baseline,
        sessionId: "anchor-validation",
        readOnly: true,
      });
      try {
        if (!session.resolveCellAnchorRanges?.(normalized).length)
          fail(409, "所选内容已删除");
        return normalized;
      } finally {
        session.dispose();
      }
    } finally {
      doc.destroy();
    }
  }
  fail(400, "表格评论锚点无效");
}
