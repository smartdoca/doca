import { ProtocolInvariantError } from "./errors.js";
import type { EffectRegistry, RegistryEntry } from "./registry.js";

export interface IntentEvaluation {
  readonly eligible: boolean;
  readonly confidence: number;
  readonly reason?: string;
}

export interface IntentDefinition<Context = unknown> extends RegistryEntry {
  readonly description?: string;
  readonly priority?: number;
  /** Workflow, acceptance, and lazily activated skill IDs owned by this intent. */
  readonly workflowIds?: readonly string[];
  readonly acceptanceIds?: readonly string[];
  readonly skillIds?: readonly string[];
  readonly positiveExamples?: readonly string[];
  readonly negativeExamples?: readonly string[];
  readonly evaluate: (
    request: IntentRequest,
    context: Context,
  ) => IntentEvaluation | Promise<IntentEvaluation>;
}

export interface IntentRequest {
  readonly text: string;
  readonly sessionId?: string;
  readonly turnId?: string;
}

export interface IntentCandidate {
  readonly intentId: string;
  readonly eligible: boolean;
  readonly confidence: number;
  readonly priority: number;
  readonly reason?: string;
}

export interface IntentRoute {
  readonly selected?: IntentCandidate;
  readonly candidates: readonly IntentCandidate[];
}

function lexical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareCandidates(
  left: IntentCandidate,
  right: IntentCandidate,
): number {
  if (left.eligible !== right.eligible) return left.eligible ? -1 : 1;
  if (left.confidence !== right.confidence) {
    return right.confidence - left.confidence;
  }
  if (left.priority !== right.priority) return right.priority - left.priority;
  return lexical(left.intentId, right.intentId);
}

/**
 * Routes against a registry snapshot. Eligibility is a hard gate; confidence
 * wins first, priority breaks equal confidence, and ID is the final stable
 * tie-break independent of registration order.
 */
export async function routeIntent<Context>(
  registry: EffectRegistry<IntentDefinition<Context>>,
  request: IntentRequest,
  context: Context,
): Promise<IntentRoute> {
  const candidates: IntentCandidate[] = [];
  for (const intent of registry.list()) {
    const evaluation = await intent.evaluate(request, context);
    if (
      !Number.isFinite(evaluation.confidence) ||
      evaluation.confidence < 0 ||
      evaluation.confidence > 1
    ) {
      throw new ProtocolInvariantError(
        "invalid_intent_confidence",
        `Intent "${intent.id}" returned confidence outside [0, 1]`,
      );
    }
    const priority = intent.priority ?? 0;
    if (!Number.isFinite(priority)) {
      throw new ProtocolInvariantError(
        "invalid_intent_priority",
        `Intent "${intent.id}" has a non-finite priority`,
      );
    }
    candidates.push(
      Object.freeze({
        intentId: intent.id,
        eligible: evaluation.eligible,
        confidence: evaluation.confidence,
        priority,
        ...(evaluation.reason === undefined
          ? {}
          : { reason: evaluation.reason }),
      }),
    );
  }
  candidates.sort(compareCandidates);
  const selected = candidates.find((candidate) => candidate.eligible);
  return Object.freeze({
    ...(selected === undefined ? {} : { selected }),
    candidates: Object.freeze(candidates),
  });
}
