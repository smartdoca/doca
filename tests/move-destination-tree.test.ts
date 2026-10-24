import { describe, expect, it } from "vitest";
import type { Resource } from "../apps/web/src/shared/api.js";
import {
  createDestinationChildren,
  moveDestinationChildren,
} from "../apps/web/src/features/documents/move-destination-tree.js";

function document(id: string, changes: Partial<Resource> = {}): Resource {
  return {
    id,
    kind: "document",
    format: "rich_text",
    title: id,
    owner_id: "owner",
    library_id: "library",
    parent_id: null,
    version: 1,
    role: "owner",
    access_mode: "inherit",
    visibility: "invited",
    created_at: "2026-10-20T00:00:00Z",
    updated_at: "2026-10-20T00:00:00Z",
    deleted_at: null,
    tree_order: 0,
    ...changes,
  };
}

describe("document move destinations", () => {
  it("allows editors to create below a document while moving still requires management", () => {
    const items = [document("editable", { role: "editor" })];
    expect(createDestinationChildren("library", items)).toMatchObject([
      { key: "editable", disabled: false },
    ]);
    expect(
      moveDestinationChildren("library", items, "source", true),
    ).toMatchObject([{ key: "editable", disabled: true }]);
  });

  it("keeps read-only hierarchy and allows an editable child as a capture destination", () => {
    const items = [
      document("read-only", { role: "reader" }),
      document("child", { parent_id: "read-only", role: "editor" }),
    ];
    expect(createDestinationChildren("library", items)).toMatchObject([
      {
        key: "read-only",
        disabled: true,
        children: [{ key: "child", disabled: false }],
      },
    ]);
  });
  it("keeps nested documents under their library in the sidebar order", () => {
    const sheet = document("sheet", {
      parent_id: "guide",
      format: "spreadsheet",
    });
    const nodes = moveDestinationChildren(
      "library",
      [
        document("later", { tree_order: 2 }),
        sheet,
        document("guide", { tree_order: 1 }),
        document("nested", { parent_id: "sheet" }),
        document("other-library", { library_id: "other" }),
        document("deleted", { deleted_at: "2026-10-20T01:00:00Z" }),
      ],
      "source",
      true,
    );
    expect(nodes.map((node) => node.key)).toEqual(["guide", "later"]);
    expect(nodes[0]?.children?.[0]).toMatchObject({
      key: "sheet",
      resource: sheet,
      isLeaf: false,
      children: [{ key: "nested", isLeaf: true }],
    });
  });

  it("keeps a read-only ancestor visible and its manageable descendant selectable", () => {
    const nodes = moveDestinationChildren(
      "library",
      [
        document("read-only", { role: "reader" }),
        document("managed", { parent_id: "read-only", role: "manager" }),
      ],
      "source",
      true,
    );
    expect(nodes).toMatchObject([
      {
        key: "read-only",
        disabled: true,
        children: [{ key: "managed", disabled: false }],
      },
    ]);
  });

  it("prevents moving into the source and every level of its subtree", () => {
    const nodes = moveDestinationChildren(
      "library",
      [
        document("source"),
        document("child", { parent_id: "source" }),
        document("grandchild", { parent_id: "child" }),
        document("sibling", { tree_order: 1 }),
      ],
      "source",
      true,
    );
    expect(nodes).toMatchObject([
      {
        key: "source",
        disabled: true,
        children: [
          {
            key: "child",
            disabled: true,
            children: [{ key: "grandchild", disabled: true }],
          },
        ],
      },
      { key: "sibling", disabled: false },
    ]);
  });

  it("allows copying a single document into a descendant while keeping the source disabled", () => {
    const nodes = moveDestinationChildren(
      "library",
      [document("source"), document("child", { parent_id: "source" })],
      "source",
      false,
    );
    expect(nodes).toMatchObject([
      {
        key: "source",
        disabled: true,
        children: [{ key: "child", disabled: false }],
      },
    ]);
  });

  it("represents an empty knowledge base without invented document nodes", () => {
    expect(moveDestinationChildren("library", [], "source", true)).toEqual([]);
  });
});
