import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

export type I18nCandidate = {
  file: string;
  line: number;
  kind: "jsx" | "attribute" | "literal" | "template" | "format";
  text: string;
};

/** Candidates require review: user content, prompts, and protocol values are not UI copy. */
export function scanI18nSource(file: string, source: string): I18nCandidate[] {
  const ast = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const result: I18nCandidate[] = [];
  const add = (node: ts.Node, kind: I18nCandidate["kind"], text: string) =>
    result.push({
      file,
      line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
      kind,
      text: text.replace(/\s+/g, " ").trim(),
    });
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node) && /\p{Script=Han}/u.test(node.text))
      add(node, "jsx", node.text);
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      /\p{Script=Han}/u.test(node.text)
    ) {
      add(
        node,
        ts.isJsxAttribute(node.parent) ? "attribute" : "literal",
        node.text,
      );
    }
    if (
      ts.isTemplateExpression(node) &&
      /\p{Script=Han}/u.test(
        node.head.text +
          node.templateSpans.map((span) => span.literal.text).join(""),
      )
    ) {
      add(node, "template", node.getText(ast));
    }
    if (
      (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
      /(?:toLocale(?:Date|Time)?String|Intl\.(?:DateTimeFormat|NumberFormat|RelativeTimeFormat|Collator)|localeCompare)$/.test(
        node.expression.getText(ast),
      )
    ) {
      const args = node.arguments ?? [];
      const localeArgument = /localeCompare$/.test(node.expression.getText(ast))
        ? args[1]
        : args[0];
      if (
        !localeArgument ||
        ts.isStringLiteral(localeArgument) ||
        ts.isArrayLiteralExpression(localeArgument)
      ) {
        add(node, "format", node.getText(ast));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return result;
}

export function scanI18nTree(root: string): I18nCandidate[] {
  if (statSync(root).isFile())
    return scanI18nSource(
      relative(process.cwd(), resolve(root)),
      readFileSync(root, "utf8"),
    );
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = resolve(root, entry.name);
    if (entry.isDirectory()) {
      return ["node_modules", "dist", ".git", "catalogs"].includes(entry.name)
        ? []
        : scanI18nTree(file);
    }
    return /\.tsx?$/.test(file)
      ? scanI18nSource(
          relative(process.cwd(), file),
          readFileSync(file, "utf8"),
        )
      : [];
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const roots = process.argv.slice(2).filter((arg) => arg !== "--json");
  const candidates = (
    roots.length ? roots : ["apps/web/src", "apps/mobile/src"]
  ).flatMap(scanI18nTree);
  if (process.argv.includes("--json"))
    console.log(JSON.stringify(candidates, null, 2));
  else {
    const counts = new Map<string, number>();
    for (const item of candidates)
      counts.set(item.file, (counts.get(item.file) ?? 0) + 1);
    console.log("Review candidates (not a confirmed defect count):");
    for (const [file, count] of [...counts].sort((a, b) => b[1] - a[1]))
      console.log(`${count}\t${file}`);
    console.log(
      `${candidates.length} candidates in ${counts.size} files. Use --json for locations and snippets.`,
    );
  }
}
