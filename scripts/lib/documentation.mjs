import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, relative, resolve } from "node:path";
import { parseDocument, DomUtils } from "htmlparser2";
import { fromMarkdown } from "mdast-util-from-markdown";
import ts from "typescript";

export const repository = "https://github.com/workhold/doca/blob/main/";
export const skillReferences = [
  [
    "collaboration-sdk-contract.md",
    "doca-collaboration/references/contract.md",
  ],
  [
    "editor-file-exchange-contract.md",
    "doca-collaboration/references/file-exchange.md",
  ],
  [
    "editor-integration.md",
    "doca-editor-integration/references/integration.md",
  ],
  [
    "editor-file-exchange-contract.md",
    "doca-editor-integration/references/file-exchange.md",
  ],
  ["i18n.md", "doca-i18n/references/contract.md"],
];

// Fixtures are document inputs, not repository documentation. Never scan generated output.
export async function markdownFiles(root) {
  const { stdout } = await promisify(execFile)(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      "*.md",
      "*.mdx",
    ],
    { cwd: root },
  );
  return [
    ...new Set(
      stdout
        .split("\0")
        .filter((path) => path && !path.startsWith("tests/fixtures/")),
    ),
  ]
    .sort()
    .map((path) => resolve(root, path));
}

export const headingText = (node) =>
  node.value ?? node.alt ?? (node.children ?? []).map(headingText).join("");

export function headingIds(tree, style = "docsify") {
  const ids = new Set();
  const counts = new Map();
  function visit(node) {
    if (node.type === "heading") {
      let id = headingText(node).trim().normalize("NFC");
      if (style === "docsify") {
        id = id
          .replace(/\uFE0F/g, "")
          .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "")
          .replace(/[A-Z]+/g, (value) => value.toLowerCase())
          .replace(/<[^>]+>/g, "")
          .replace(
            /[\u2000-\u206F\u2E00-\u2E7F\\'!"#$%&()*+,./:;<=>?@[\]^`{|}~]/g,
            "",
          )
          .replace(/\s/g, "-")
          .replace(/^(\d)/, "_$1");
      } else {
        id = id
          .toLowerCase()
          .replace(/<[^>]+>/g, "")
          .replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, "")
          .replace(/\s/g, "-");
      }
      const base = id;
      if (style === "docsify") {
        // The vendored runtime counts each raw slug, even if a suffixed heading collides.
        const count = counts.get(base) ?? 0;
        counts.set(base, count + 1);
        if (count) id = `${base}-${count}`;
      } else {
        let count = counts.get(base) ?? 0;
        while (ids.has(id)) id = `${base}-${++count}`;
        counts.set(base, count);
      }
      ids.add(id);
    }
    if (node.type === "html") {
      for (const element of DomUtils.getElementsByTagName(
        "*",
        parseDocument(node.value).children,
        true,
      )) {
        if (element.attribs.id) ids.add(element.attribs.id);
        if (element.name === "a" && element.attribs.name)
          ids.add(element.attribs.name);
      }
    }
    for (const child of node.children ?? []) visit(child);
  }
  visit(tree);
  return ids;
}

export function documentLinks(tree) {
  const links = [];
  function visit(node) {
    if (["link", "image", "definition"].includes(node.type))
      links.push({ href: node.url, node });
    if (node.type === "html") {
      for (const element of DomUtils.getElementsByTagName(
        "*",
        parseDocument(node.value).children,
        true,
      )) {
        for (const name of ["href", "src"]) {
          if (element.attribs[name])
            links.push({ href: element.attribs[name], node, html: true });
        }
      }
    }
    for (const child of node.children ?? []) visit(child);
  }
  visit(tree);
  return links;
}

// Resolve only local links and this repository's main-branch links, never network requests.
export function repositoryTarget(root, path, href) {
  const own = href.match(
    /^https:\/\/(?:github\.com\/workhold\/doca\/(?:blob|tree)\/main|raw\.githubusercontent\.com\/workhold\/doca\/main)\/(.*)$/,
  );
  if (!own && /^(?:[a-z][a-z0-9+.-]*:|\/\/|#\/)/i.test(href)) return null;
  const value = own ? own[1] : href;
  const hash = value.indexOf("#");
  const local = (hash < 0 ? value : value.slice(0, hash)).split("?")[0];
  const fragment = hash < 0 ? "" : decodeURIComponent(value.slice(hash + 1));
  const destination = local
    ? resolve(own ? root : dirname(path), decodeURIComponent(local))
    : path;
  const repoPath = relative(root, destination).split("\\").join("/");
  return {
    destination,
    fragment,
    repoPath,
    outside: repoPath === ".." || repoPath.startsWith("../"),
  };
}

// Installed skills may live outside the checkout. Keep prose identical and links portable.
export function portableSkillReference(markdown, source) {
  const replacements = [];
  for (const { href, node } of documentLinks(fromMarkdown(markdown))) {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href)) continue;
    const [path, fragment] = href.split("#");
    const destination = new URL(path, `${repository}docs/${source}`).href;
    const start = node.position.start.offset;
    const segment = markdown.slice(start, node.position.end.offset);
    const offset = segment.indexOf(href, segment.indexOf("]") + 1);
    if (offset < 0)
      throw new Error(`Unsupported skill-reference link in ${source}: ${href}`);
    replacements.push({
      start: start + offset,
      end: start + offset + href.length,
      value: destination + (fragment ? `#${fragment}` : ""),
    });
  }
  for (const edit of replacements.sort((a, b) => b.start - a.start))
    markdown =
      markdown.slice(0, edit.start) + edit.value + markdown.slice(edit.end);
  return markdown;
}

export async function expectedSkillReferences(root) {
  return Promise.all(
    skillReferences.map(async ([source, target]) => [
      target,
      portableSkillReference(
        await readFile(resolve(root, "docs", source), "utf8"),
        source,
      ),
    ]),
  );
}

export function databaseInventory(root) {
  const path = resolve(root, "packages/db/src/schema.ts");
  const program = ts.createProgram([path], {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    noEmit: true,
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(path);
  const node = source.statements.find(
    (node) => ts.isInterfaceDeclaration(node) && node.name.text === "Schema",
  );
  return checker
    .getTypeAtLocation(node)
    .getProperties()
    .map((table) => ({
      name: table.name,
      fields: checker
        .getTypeOfSymbolAtLocation(table, node)
        .getProperties()
        .map((field) => field.name),
    }));
}
