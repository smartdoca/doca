import { expect, it, vi } from "vitest";
import type { ReactElement } from "react";

vi.mock("@web/features/files/files.js", () => ({
  FilesExplorer: () => null,
  FolderFilePicker: () => null,
  SharedFoldersPage: () => null,
}));
vi.mock("@web/features/ai/ai-file-card.js", () => ({ FileDeliveryCard: () => null }));
vi.mock("@web/features/ai/ai-folder-card.js", () => ({ FolderDeliveryCard: () => null }));

import { createBuiltinWebPluginRegistry } from "@web/plugins/registry.js";
import { FilesExplorer, SharedFoldersPage } from "@web/features/files/files.js";
import { pluginRouteScope } from "@web/app/plugin-route-scope.js";

it("opens shared-folder links through redemption before matching a folder ID", () => {
  const registry = createBuiltinWebPluginRegistry();
  const context = { sharedFolderName: "Shared", onFileNavigationChange: () => {} };
  const join = registry.resolveRoute("/shared-files/join?token=example-token")!;
  expect(join.contribution.id).toBe("doca.files.route.shared-join");
  expect(pluginRouteScope(join.contribution.id)).toBe("shared-files");
  expect((join.contribution.render(context, join.match) as ReactElement).type)
    .toBe(SharedFoldersPage);
  const id = "12345678-1234-4234-8234-123456789abc";
  const folder = registry.resolveRoute(`/shared-files/${id}`)!;
  const view = folder.contribution.render(context, folder.match) as ReactElement<{
    initialRoot: { type: string; id: string };
  }>;
  expect(view.type).toBe(FilesExplorer);
  expect(view.props.initialRoot).toMatchObject({ type: "folder", id });
});
