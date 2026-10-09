import { createHash, randomUUID } from "node:crypto";
import { expect } from "vitest";
import { completionResponse } from "../ai-mock.js";

export function fixtureSolidPagePDF(pageCount: number): Buffer {
  const paint = "0.2 0.4 0.6 rg\n0 0 80 60 re f\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Count ${pageCount} /Kids [${Array.from({ length: pageCount }, (_, i) => `${3 + i * 2} 0 R`).join(" ")}] >>`,
  ];
  for (let i = 0; i < pageCount; i++)
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 80 60] /Resources << >> /Contents ${4 + i * 2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(paint)} >>\nstream\n${paint}endstream`,
    );
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets
      .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
      .join("") +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

/** Separate metered source-planning reply for the solid-color runner fixtures.
 * It neither accepts a candidate nor advances the executor's scripted steps.
 */
export function fixtureSolidScenePlan(body: any): Response | undefined {
  const content = body.messages.flatMap((message: any) =>
    Array.isArray(message.content) ? message.content : [],
  );
  const part = content.find(
    (part: any) => part.type === "text" && part.text.startsWith('{"binding"'),
  );
  if (!part) return;
  const metadata = JSON.parse(part.text);
  if (!metadata.outputSchema?.properties?.roleMappings) return;
  const images = content.filter((part: any) => part.type === "image_url");
  expect(images).toHaveLength(metadata.binding.references.length);
  expect(images.length).toBeGreaterThan(0);
  for (const [index, image] of images.entries()) {
    expect(image.image_url.url).toMatch(/^data:image\/jpeg;base64,/);
    expect(
      createHash("sha256")
        .update(Buffer.from(image.image_url.url.split(",")[1], "base64"))
        .digest("hex"),
    ).toBe(metadata.binding.references[index].transmittedSHA256);
  }
  return completionResponse(
    {
      id: randomUUID(),
      object: "chat.completion",
      created: 1,
      model: body.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: JSON.stringify({
              summary:
                "The isolated frozen originals are solid-color test images without identifiable people, actions or readable words.",
              reviewPrecision: {
                mode: "semantic",
                criterionIndices: [],
                requestIndices: [],
                reason:
                  "No applicable formal pixel or typography precision requirement is mapped in these fixtures.",
              },
              objects: [],
              roleMappings: [],
              actions: [],
              crossPage: [],
              requirements: [],
              uncertainties: [],
            }),
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    },
    !!body.stream,
  );
}
