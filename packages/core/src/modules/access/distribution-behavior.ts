import { publicMode, type Distribution } from "../deployment/policies.js";

/** One policy interpretation for resource lists, Q&A discovery and AI connections. */
export function distributionBehavior(
  policy: Distribution,
  kind: "document" | "library" | "assistant",
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
export type AudienceFacts = {
  owner: boolean;
  granted: boolean;
  accepted: boolean;
  public: boolean;
  interacted: boolean;
  hidden: boolean;
};
export function audienceDecision(policy: Distribution, facts: AudienceFacts) {
  const behavior = distributionBehavior(policy, "assistant");
  const named =
    facts.granted && (!behavior.requireAcceptance || facts.accepted);
  const accessible = facts.owner || named || facts.public;
  const defaultIncluded =
    accessible &&
    !facts.hidden &&
    (facts.owner ||
      facts.accepted ||
      (named && behavior.includeGranted) ||
      (facts.public && !behavior.requireSearchIntersection));
  return {
    accessible,
    defaultIncluded,
    invitationPending:
      facts.granted &&
      behavior.requireAcceptance &&
      !facts.accepted &&
      !facts.owner,
  };
}
