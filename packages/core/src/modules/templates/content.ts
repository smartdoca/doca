export const TEMPLATE_FORMATS = [
  "rich_text",
  "spreadsheet",
  "markdown",
  "canvas",
  "presentation",
] as const;
export type TemplateFormat = (typeof TEMPLATE_FORMATS)[number];

const blankPresentation = {
  id: "presentation-2d029fbc-7b09-46a7-95cc-bad600c2ed7b",
  schemaVersion: 2,
  title: "未命名演示文稿",
  size: { width: 12192000, height: 6858000 },
  slideOrder: ["slide-8a8fac18-e84e-4c80-aeac-fad2aa420249"],
  slides: {
    "slide-8a8fac18-e84e-4c80-aeac-fad2aa420249": {
      id: "slide-8a8fac18-e84e-4c80-aeac-fad2aa420249",
      background: "#ffffff",
      elementOrder: ["text-77f569d3-6b5e-44f4-a66b-d306421e9f0e"],
      elements: {
        "text-77f569d3-6b5e-44f4-a66b-d306421e9f0e": {
          id: "text-77f569d3-6b5e-44f4-a66b-d306421e9f0e",
          type: "text",
          transform: { x: 914400, y: 914400, width: 4572000, height: 914400, rotation: 0 },
          paragraphs: [
            { type: "paragraph", children: [{ text: "EPPT 协同演示文稿", fontSize: 24 }] },
          ],
          fill: "#202124",
        },
      },
    },
  },
};

export function blankTemplateContent(format: TemplateFormat): unknown {
  if (format === "markdown") return "";
  if (format === "rich_text")
    return [{ id: crypto.randomUUID(), type: "paragraph", children: [{ text: "" }] }];
  if (format === "canvas")
    return { version: 1, name: "模板", scene: { children: [] } };
  if (format === "presentation") return structuredClone(blankPresentation);
  const sheetId = crypto.randomUUID();
  return {
    id: "template",
    name: "模板",
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
  };
}
