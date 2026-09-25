import { Image, Spin, Checkbox } from "antd";
import { Fragment, memo } from "react";
import { CodeHighlighter, Mermaid, XProvider } from "@ant-design/x";
import { antDesignXLocale } from "@web/shared/antd-locale.js";
import { useI18n } from "@web/shared/i18n.js";
import XMarkdown, { type ComponentProps } from "@ant-design/x-markdown";
import "@ant-design/x-markdown/themes/light.css";
import Latex from "@ant-design/x-markdown/plugins/Latex";
import type { FileDelivery, FolderDelivery } from "@core/modules/ai/progress.js";
import { webPluginRegistry } from "@web/plugins/registry.js";
import {
  answerSegments,
  folderExplorerHash,
  isFolderExplorerHref,
  navigationHref,
  resolveExplorerClick,
} from "@web/features/ai/ai-folder-mentions.js";
const markdownConfig = {
  gfm: true,
  extensions: Latex({
    katexOptions: {
      trust: false,
      throwOnError: false,
      maxExpand: 1000,
      maxSize: 20,
    },
  }),
};
const diagramConfig = {
  securityLevel: "strict",
  startOnLoad: false,
  maxTextSize: 30000,
} as const;
function MarkdownCode({
  children,
  className,
  lang,
  block,
  streamStatus,
}: ComponentProps) {
  const code = String(children ?? "");
  const language = (
    lang ||
    className?.replace(/^language-/, "") ||
    "text"
  ).split(/\s/)[0]!;
  if (!block) return <code>{children}</code>;
  if (language === "mermaid") {
    if (streamStatus === "loading")
      return (
        <div className="ai-diagram-loading">
          <Spin size="small" /> 正在生成图表…
        </div>
      );
    return (
      <Mermaid
        config={diagramConfig}
        styles={{ graph: { height: 220 }, code: { maxHeight: 320 } }}
      >
        {code}
      </Mermaid>
    );
  }
  return (
    <CodeHighlighter lang={language} prismLightMode={false}>
      {code}
    </CodeHighlighter>
  );
}
const markdownComponents = {
  code: MarkdownCode,
  pre: ({ children }: ComponentProps) => (
    <div className="ai-markdown-code">{children}</div>
  ),
  input: ({ checked, type }: ComponentProps) =>
    type === "checkbox" ? <Checkbox checked={!!checked} disabled /> : null,
  img: ({ src, alt }: ComponentProps) =>
    /^\/api\/v1\/assets\/[a-f0-9-]{36}\/content$/.test(String(src ?? "")) ? (
      <Image
        src={String(src)}
        alt={String(alt ?? "生成图片")}
        style={{ maxWidth: "100%" }}
      />
    ) : (
      <span>[外部图片]</span>
    ),
};
function MarkdownBody({
  text,
  streaming,
}: {
  text: string;
  streaming?: boolean;
}) {
  return (
    <XMarkdown
      content={text}
      className="x-markdown-light"
      config={markdownConfig}
      escapeRawHtml
      openLinksInNewTab
      streaming={{
        hasNextChunk: !!streaming,
        enableAnimation: !!streaming,
      }}
      dompurifyConfig={{
        USE_PROFILES: { html: true, svg: true, mathMl: true },
        FORBID_TAGS: [
          "style",
          "iframe",
          "video",
          "audio",
          "source",
          "object",
          "embed",
          "form",
          "button",
          "link",
          "meta",
        ],
      }}
      components={markdownComponents}
    />
  );
}

function foldersUnchanged(
  left?: FolderDelivery[],
  right?: FolderDelivery[],
) {
  if (left === right) return true;
  if ((left?.length ?? 0) !== (right?.length ?? 0)) return false;
  return (left ?? []).every(
    (folder, index) =>
      folder.id === right![index]!.id && folder.href === right![index]!.href,
  );
}

function filesUnchanged(
  left?: FileDelivery[],
  right?: FileDelivery[],
) {
  if (left === right) return true;
  if ((left?.length ?? 0) !== (right?.length ?? 0)) return false;
  return (left ?? []).every(
    (file, index) =>
      file.id === right![index]!.id && file.href === right![index]!.href,
  );
}

function AIAnswer({
  text,
  onDocument,
  onFolder,
  folders,
  files,
  ensureFolderCards,
  streaming,
}: {
  text: string;
  onDocument: (id: string) => void;
  onFolder?: (href: string) => void;
  folders?: FolderDelivery[];
  files?: FileDelivery[];
  ensureFolderCards?: boolean;
  streaming?: boolean;
}) {
  const { locale } = useI18n();
  const segments = answerSegments(text, folders, {
    ensureCards: ensureFolderCards,
    files,
    });
  return (
    <XProvider locale={antDesignXLocale(locale)}>
      <div
        className="ai-answer"
        onClickCapture={(event) => {
          const link = (event.target as Element).closest("a");
          const href = link?.getAttribute("href") ?? "";
          const match = /^#\/r\/([a-f0-9-]{36})$/.exec(href);
          if (match) {
            event.preventDefault();
            event.stopPropagation();
            onDocument(match[1]!);
            return;
          }
          if (
            onFolder &&
            isFolderExplorerHref(href)
          ) {
            event.preventDefault();
            event.stopPropagation();
            const next = navigationHref(href)
                ? href
                : resolveExplorerClick(
                    href,
                    files ?? [],
                    link?.textContent ?? "",
                  );
            if (!next) return;
            onFolder(folderExplorerHash(next).slice(1));
          }
        }}
      >
        {segments.map((segment, index) => {
          if (segment.type === "text")
            return segment.text.trim() ? (
              <MarkdownBody
                key={`text-${index}`}
                text={segment.text}
                streaming={streaming && index === segments.length - 1}
              />
            ) : null;
          const block = webPluginRegistry.aiBlocks.getByConflictKey(
            segment.type,
          );
          const payload =
            segment.type === "folder"
              ? segment.folder
              : segment.file;
          const key =
            `${payload.id}-${index}`;
          if (!block)
            return (
              <MarkdownBody
                key={key}
                text={`> ${segment.type}: ${payload.name}`}
              />
            );
          return (
            <Fragment key={key}>
              {block.render(payload, {
                onOpen: onFolder,
                renderLink: (label, href) => (
                  <MarkdownBody
                    text={`[${label}](${folderExplorerHash(href)})`}
                  />
                ),
              })}
            </Fragment>
          );
        })}
      </div>
    </XProvider>
  );
}

export default memo(AIAnswer, (prev, next) =>
  prev.text === next.text &&
  prev.streaming === next.streaming &&
  prev.ensureFolderCards === next.ensureFolderCards &&
  prev.onDocument === next.onDocument &&
  prev.onFolder === next.onFolder &&
  foldersUnchanged(prev.folders, next.folders) &&
  filesUnchanged(prev.files, next.files),
);
