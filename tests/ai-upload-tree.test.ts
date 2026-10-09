import { afterEach, expect, it, vi } from "vitest";
import { uploadDroppedTree } from "@web/features/files/upload-tree.js";

afterEach(() => vi.unstubAllGlobals());
const entries = () => [
  { path: "pdf2png/first.txt", file: new File(["first"], "first.txt"), directory: false },
  { path: "pdf2png/photos/dad.txt", file: new File(["dad"], "dad.txt"), directory: false },
];
it("creates a fresh AI upload root when an earlier conversation used the same folder name", async () => {
  const folders: any[] = [], files: URL[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (url === "/api/v1/files/folders") {
      const body = JSON.parse(String(init.body)); folders.push(body);
      if (body.name === "pdf2png") return Response.json({ message: "Already exists" }, { status: 409 });
      return Response.json({ id: body.parentId ? "new-photos" : "new-root", name: body.name }, { status: 201 });
    }
    expect(init.method).toBe("POST");
    files.push(new URL(url, "http://localhost"));
    return Response.json({ id: "uploaded-file" }, { status: 201 });
  }));
  const uploaded = await uploadDroppedTree(entries(), null, undefined, { rootConflict: "create-new" });
  expect(uploaded.folders).toEqual([{ id: "new-root", name: "pdf2png (2)" }]);
  expect(folders).toEqual([
    { name: "pdf2png", parentId: null }, { name: "pdf2png (2)", parentId: null },
    { name: "photos", parentId: "new-root" },
  ]);
  expect(files.map(url => url.searchParams.get("parentId"))).toEqual(["new-root", "new-photos"]);
});
it("keeps explicit file-manager merge uploads in their selected existing folder", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (url === "/api/v1/files/folders") return Response.json({ message: "Already exists" }, { status: 409 });
    if (url === "/api/v1/files?parentType=system&parentId=root") return Response.json({ folders: [{ id: "selected-root", name: "pdf2png" }] });
    const upload = new URL(url, "http://localhost");
    expect(init.method).toBe("POST");
    expect(upload.searchParams.get("parentId")).toBe("selected-root");
    return Response.json({ id: "uploaded-file" }, { status: 201 });
  }));
  expect((await uploadDroppedTree(entries().slice(0, 1), null, undefined, { rootConflict: "merge" })).folders)
    .toEqual([{ id: "selected-root", name: "pdf2png" }]);
});
it("does not retry or reinterpret a permission or storage failure as a name collision", async () => {
  const fetcher = vi.fn(async () => Response.json({ message: "Denied" }, { status: 403 }));
  vi.stubGlobal("fetch", fetcher);
  await expect(uploadDroppedTree(entries(), null, undefined, { rootConflict: "create-new" })).rejects.toMatchObject({ status: 403 });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
