import { useI18n } from "@web/shared/i18n.js";
import { blankTemplateContent } from "@core/modules/templates/content.js";
import { useEffect, useRef, useState } from "react";
import { createYDocument, readDocument } from "@smartdoca/slides/core";
import {
  PresentationWorkspace,
  type PresentationWorkspaceHandle,
} from "@smartdoca/slides";
import { CanvasEditor, type CanvasEditorResources } from "@smartdoca/canvas";
import { CanvasModel, type SceneNode } from "@smartdoca/canvas/model";
import {
  SpreadsheetEditor,
  createDefaultSpreadsheetRuntime,
  type SpreadsheetRuntimeFactory,
} from "@smartdoca/sheet";
import {
  createExlsxBaseline,
  createExlsxCollaborationSession,
  restoreExlsxDocument,
  type ExlsxCollaborationSession,
} from "@smartdoca/sheet/yjs";
import { projectExlsxWorkbook } from "@smartdoca/sheet/model";
import * as Y from "yjs";
import {
  RichTextEditor,
  type EditorValue,
  type RichTextEditorHandle,
} from "@smartdoca/slate";
import { renderKatex } from "@smartdoca/slate/katex";
import { mentionPlugin } from "@web/features/documents/document-mentions.js";
import { documentLinkPlugin } from "@web/features/documents/document-link.js";
import { Feedback } from "@web/shared/components/feedback.js";
import type { Resource } from "@web/shared/api.js";
import VersionPreview from "@web/features/documents/version-preview.js";
import MarkdownPreview from "@web/features/documents/markdown-preview.js";
import "@smartdoca/slate/style.css";
import "@web/features/documents/editor.css";
import "@smartdoca/canvas/style.css";
import "@smartdoca/sheet/style.css";
import "@smartdoca/slides/styles.css";
import "@smartdoca/markdown/style.css";
import "katex/dist/katex.min.css";
import "@web/features/documents/markdown.css";
import "@web/features/documents/surface.css";

const plugins = [mentionPlugin, documentLinkPlugin];
const spreadsheetRuntimeOwners = new WeakMap<HTMLElement, object>();
// Univer disposes its nested React root from the editor effect cleanup. That
// cleanup runs while the template dialog is still committing, which makes React
// reject the synchronous unmount. Dispose on the next turn, and skip a runtime
// that has already been replaced in the same container.
const templateSpreadsheetRuntime: SpreadsheetRuntimeFactory = (context) => {
  const runtime = createDefaultSpreadsheetRuntime(context);
  spreadsheetRuntimeOwners.set(context.container, runtime);
  const dispose = runtime.univer.dispose.bind(runtime.univer);
  runtime.univer.dispose = () => {
    window.setTimeout(() => {
      if (spreadsheetRuntimeOwners.get(context.container) !== runtime) return;
      spreadsheetRuntimeOwners.delete(context.container);
      dispose();
    }, 0);
  };
  return runtime;
};
const denyUpload = async () => {
  throw Error("模板不能上传素材");
};
const canvasResources: CanvasEditorResources = {
  uploadImage: denyUpload,
  resolveUrl: () => "",
  resolveDownloadUrl: () => "",
  readImage: denyUpload,
};

export function TemplateSurface({
  format,
  content,
  readOnly = false,
  onContent,
}: {
  format: Resource["format"];
  content: unknown;
  readOnly?: boolean;
  onContent?: (read: () => Promise<unknown>) => void;
}) {
  if (format === "markdown")
    return (
      <MarkdownSurface
        content={typeof content === "string" ? content : ""}
        readOnly={readOnly}
        onContent={onContent}
      />
    );
  if (format === "rich_text")
    return (
      <RichSurface
        content={
          Array.isArray(content)
            ? (content as EditorValue)
            : (blankTemplateContent("rich_text") as EditorValue)
        }
        readOnly={readOnly}
        onContent={onContent}
      />
    );
  if (format === "spreadsheet")
    return (
      <SheetSurface
        content={content}
        readOnly={readOnly}
        onContent={onContent}
      />
    );
  if (format === "canvas")
    return (
      <CanvasSurface
        content={content}
        readOnly={readOnly}
        onContent={onContent}
      />
    );
  return (
    <SlideSurface content={content} readOnly={readOnly} onContent={onContent} />
  );
}

function MarkdownSurface({
  content,
  readOnly,
  onContent,
}: {
  content: string;
  readOnly: boolean;
  onContent?: (read: () => Promise<unknown>) => void;
}) {
  const [text, setText] = useState(content);
  const latest = useRef(text);
  latest.current = text;
  useEffect(() => {
    onContent?.(() => Promise.resolve(latest.current));
  }, [onContent]);
  if (readOnly) return <MarkdownPreview value={text} />;
  return (
    <textarea
      className="template-markdown"
      aria-label="模板正文"
      value={text}
      onChange={(event) => setText(event.target.value)}
    />
  );
}

function RichSurface({
  content,
  readOnly,
  onContent,
}: {
  content: EditorValue;
  readOnly: boolean;
  onContent?: (read: () => Promise<unknown>) => void;
}) {
  const { locale } = useI18n();
  const handle = useRef<RichTextEditorHandle | null>(null);
  useEffect(() => {
    onContent?.(() => Promise.resolve(handle.current?.getValue() ?? content));
  }, [onContent, content]);
  if (readOnly) return <VersionPreview value={content} />;
  return (
    <div className="template-rich">
      <RichTextEditor
        locale={locale}
        formulaRenderer={renderKatex}
        plugins={plugins}
        initialValue={content}
        mode="edit"
        resources={{
          uploadImage: denyUpload,
          uploadVideo: denyUpload,
          uploadAttachment: denyUpload,
          resolveUrl: () => "",
        }}
        onReady={(next) => {
          handle.current = next;
        }}
        placeholder="编辑模板内容"
      />
    </div>
  );
}

function SheetSurface({
  content,
  readOnly,
  onContent,
}: {
  content: unknown;
  readOnly: boolean;
  onContent?: (read: () => Promise<unknown>) => void;
}) {
  const { locale } = useI18n();
  const [session, setSession] = useState<ExlsxCollaborationSession | null>(
    null,
  );
  const [workbookId, setWorkbookId] = useState("template");
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    let dispose = () => {};
    void (async () => {
      const source = content ?? blankTemplateContent("spreadsheet");
      const bundle = await createExlsxBaseline(
        structuredClone(source) as never,
        crypto.randomUUID(),
      );
      const doc = await restoreExlsxDocument({
        baseline: bundle.baseline,
        update: bundle.update,
        checkpointSeq: 0,
      });
      const value = await createExlsxCollaborationSession({
        doc,
        baseline: bundle.baseline,
        sessionId: "template",
        readOnly,
      });
      dispose = () => {
        value.dispose();
        doc.destroy();
      };
      if (!alive) {
        dispose();
        return;
      }
      onContent?.(async () =>
        projectExlsxWorkbook({
          baseline: bundle.baseline,
          update: Y.encodeStateAsUpdate(doc),
          checkpointSeq: 0,
        }),
      );
      setWorkbookId(bundle.baseline.workbookId);
      setSession(value);
    })().catch((reason: Error) => {
      if (alive) setError(reason.message || "表格模板无法打开");
    });
    return () => {
      alive = false;
      dispose();
    };
  }, [content, onContent, readOnly]);
  return (
    <div className="surface-editor template-surface">
      {error && <Feedback message={error} tone="error" />}
      {!session && !error && <p className="empty">正在打开表格模板…</p>}
      {session && (
        <SpreadsheetEditor
          locale={locale}
          workbookId={workbookId}
          collaboration={session}
          runtimeFactory={templateSpreadsheetRuntime}
          readOnly={readOnly}
          autoSave={false}
          showHeader={false}
          showSaveState={false}
          onError={(reason) => setError(reason.message)}
        />
      )}
    </div>
  );
}

function CanvasSurface({
  content,
  readOnly,
  onContent,
}: {
  content: unknown;
  readOnly: boolean;
  onContent?: (read: () => Promise<unknown>) => void;
}) {
  const { locale } = useI18n();
  const [model, setModel] = useState<CanvasModel | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const source = (content ?? blankTemplateContent("canvas")) as {
      scene?: SceneNode;
      name?: string;
    };
    let next: CanvasModel;
    try {
      next = CanvasModel.initialize(crypto.randomUUID(), {
        version: 1,
        name: source.name || "模板",
        scene: source.scene ?? { children: [] },
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "画板模板无法打开");
      return;
    }
    next.setReadOnly(readOnly);
    setModel(next);
    onContent?.(() =>
      Promise.resolve(JSON.parse(JSON.stringify(next.getValue()))),
    );
    return () => {
      next.dispose();
      setModel(null);
    };
  }, [content, onContent, readOnly]);
  return (
    <div className="surface-editor template-surface">
      {error && <Feedback message={error} tone="error" />}
      {!model && !error && <p className="empty">正在打开画板模板…</p>}
      {model && (
        <CanvasEditor
          locale={locale}
          model={model}
          hostManaged
          autoSave={false}
          mode={readOnly ? "readonly" : "edit"}
          showHeader={false}
          className="doca-canvas"
          resources={canvasResources}
          style={{ height: "100%", minHeight: 0 }}
        />
      )}
    </div>
  );
}

function SlideSurface({
  content,
  readOnly,
  onContent,
}: {
  content: unknown;
  readOnly: boolean;
  onContent?: (read: () => Promise<unknown>) => void;
}) {
  const { locale } = useI18n();
  const handle = useRef<PresentationWorkspaceHandle | null>(null);
  const [doc, setDoc] = useState<Y.Doc | null>(null);
  useEffect(() => {
    const next = createYDocument(
      (content ?? blankTemplateContent("presentation")) as never,
    );
    setDoc(next);
    onContent?.(() => {
      handle.current?.commitTextEdit();
      return Promise.resolve(readDocument(next));
    });
    return () => {
      next.destroy();
      setDoc(null);
    };
  }, [content, onContent]);
  return (
    <div className="surface-editor template-surface">
      {!doc && <p className="empty">正在打开演示文稿模板…</p>}
      {doc && (
        <PresentationWorkspace
          locale={locale}
          ref={handle}
          document={doc}
          chrome="embedded"
          readOnly={readOnly}
          resources={{
            resolveUrl: () => "",
            uploadImage: denyUpload,
          }}
        />
      )}
    </div>
  );
}
