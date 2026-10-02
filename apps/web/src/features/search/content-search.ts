import type { ContentSourceDescriptor } from "@smartdoca/plugin-sdk/content";

export function searchableSources(sources: readonly ContentSourceDescriptor[]) {
  return sources.filter(source => source.purposes.includes("search") && source.capabilities.search);
}

/** Document filters cannot describe a plugin's business scope. */
export function contentQuerySources(
  sources: readonly ContentSourceDescriptor[],
  selection: { compact: boolean; contentMode: "all" | "documents" | "files"; selectedSourceId: string | null; filterCount: number },
) {
  if (selection.compact || selection.contentMode !== "all" || selection.filterCount) return [];
  return searchableSources(sources).filter(source => !selection.selectedSourceId || source.id === selection.selectedSourceId);
}
