import { Image, Spin, Checkbox } from "antd";
import { memo } from "react";
import { CodeHighlighter, Mermaid, XProvider } from "@ant-design/x";
import xZhCN from "@ant-design/x/locale/zh_CN";
import XMarkdown, { type ComponentProps } from "@ant-design/x-markdown";
import "@ant-design/x-markdown/themes/light.css";
import Latex from "@ant-design/x-markdown/plugins/Latex";
import type { FileDelivery, FolderDelivery, MailDelivery } from "@core/modules/ai/progress.js";
import { FolderDeliveryCard } from "@web/features/ai/ai-folder-card.js";
import { FileDeliveryCard } from "@web/features/ai/ai-file-card.js";
import { MailDeliveryCard } from "@web/features/ai/ai-mail-card.js";
import {
  answerSegments,
  folderExplorerHash,
  isFolderExplorerHref,
  isMailHref,
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

function mailsUnchanged(left?: MailDelivery[], right?: MailDelivery[]) {
  if (left === right) return true;
  if ((left?.length ?? 0) !== (right?.length ?? 0)) return false;
  return (left ?? []).every(
    (mail, index) =>
      mail.id === right![index]!.id &&
      mail.mailboxId === right![index]!.mailboxId &&
      mail.href === right![index]!.href,
  );
}

function AIAnswer({
  text,
  onDocument,
  onFolder,
  folders,
  files,
  mails,
  ensureFolderCards,
  streaming,
}: {
  text: string;
  onDocument: (id: string) => void;
  onFolder?: (href: string) => void;
  folders?: FolderDelivery[];
  files?: FileDelivery[];
  mails?: MailDelivery[];
  ensureFolderCards?: boolean;
  streaming?: boolean;
}) {
  const segments = answerSegments(text, folders, {
    ensureCards: ensureFolderCards,
    files,
    mails,
  });
  return (
    <XProvider locale={xZhCN}>
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
          if (onFolder && (isFolderExplorerHref(href) || isMailHref(href))) {
            event.preventDefault();
            event.stopPropagation();
            onFolder(folderExplorerHash(href).slice(1));
          }
        }}
      >
        {segments.map((segment, index) =>
          segment.type === "folder" ? (
            onFolder ? (
              <FolderDeliveryCard
                key={`${segment.folder.id}-${index}`}
                folder={segment.folder}
                onOpen={onFolder}
              />
            ) : (
              <MarkdownBody
                key={`${segment.folder.id}-${index}`}
                text={`[${segment.folder.path ?? segment.folder.name}](${folderExplorerHash(segment.folder.href)})`}
              />
            )
          ) : segment.type === "mail" ? (
            <MailDeliveryCard
              key={`${segment.mail.mailboxId}-${segment.mail.id}-${index}`}
              mail={segment.mail}
              onOpen={onFolder}
            />
          ) : segment.type === "file" ? (
            <FileDeliveryCard
              key={`${segment.file.id}-${index}`}
              file={segment.file}
              onOpen={onFolder}
            />
          ) : segment.text.trim() ? (
            <MarkdownBody
              key={`text-${index}`}
              text={segment.text}
              streaming={streaming && index === segments.length - 1}
            />
          ) : null,
        )}
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
  filesUnchanged(prev.files, next.files) &&
  mailsUnchanged(prev.mails, next.mails),
);
