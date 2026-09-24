import type { Resource } from "../../../../db/src/index.js";
export const policyFields = {
  visibility: 1,
  public_role: 2,
  requests_enabled: 4,
  discoverable: 8,
  history_readers: 16,
  share_links_enabled: 32,
} as const;
export type PolicyField = keyof typeof policyFields;
export function policySource(
  resource: Resource,
  resources: Resource[],
  field: PolicyField,
): Resource {
  const seen = new Set<string>();
  let current = resource;
  while (
    current.access_mode === "inherit" &&
    !((current.permission_overrides ?? 0) & policyFields[field]) &&
    !seen.has(current.id)
  ) {
    seen.add(current.id);
    const parent = resources.find(
      (r) => r.id === (current.parent_id ?? current.library_id),
    );
    if (!parent) break;
    current = parent;
  }
  return current;
}
export function effectiveResource(
  resource: Resource,
  resources: Resource[],
): Resource {
  const result = { ...resource };
  for (const field of Object.keys(policyFields) as PolicyField[])
    Object.assign(result, {
      [field]: policySource(resource, resources, field)[field],
    });
  return result;
}
