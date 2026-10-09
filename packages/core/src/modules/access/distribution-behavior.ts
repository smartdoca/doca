import { publicMode, type Distribution } from "../deployment/policies.js";

/** One policy interpretation for document and library resource lists. */
export function distributionBehavior(
  policy: Distribution,
  kind: "document" | "library",
) {
  return {
    requireAcceptance: policy.grantMode === "invite",
    includeGranted:
      (kind === "library" ? policy.libraryMembers : policy.sharedDocuments) ===
      "granted",
    includePublic: publicMode(policy, kind) === "search",
    requireSearchIntersection: publicMode(policy, kind) !== "search",
    publicDiscovery: publicMode(policy, kind) !== "link",
  };
}
