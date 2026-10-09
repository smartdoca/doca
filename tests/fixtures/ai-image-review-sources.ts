import { randomUUID } from "node:crypto";
import type { ImageReviewUserRequestMetadata } from "../../apps/server/src/services/ai/image-review.js";

/** Explicit host-source facts for isolated verifier requests; no production defaults. */
export function fixtureReviewRequestMetadata(
  requests: readonly string[],
  originalJobId: string,
): ImageReviewUserRequestMetadata {
  return {
    nonCitable: true,
    requests: requests.map((_text, requestIndex) => {
      const jobId = requestIndex === 0 ? originalJobId : randomUUID();
      return {
        requestIndex,
        kind: requestIndex === 0 ? "original" : "batch-clarification",
        jobId,
        rootJobId: jobId,
        messageId: jobId,
        boundToRootJobId: requestIndex === 0 ? null : originalJobId,
        question: null,
      };
    }),
    rules: [
      "host_scope fixture: source metadata and rules are nonCitable; only formal body can authorize changes",
    ],
  };
}
