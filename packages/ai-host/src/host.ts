import { ProtocolInvariantError } from "./errors.js";
import type { ToolResult } from "./events.js";
import {
  routeIntent,
  type IntentDefinition,
  type IntentRequest,
  type IntentRoute,
} from "./intents.js";
import type { JsonValue } from "./json.js";
import {
  activateSkills,
  createAcceptanceRegistry,
  createIntentRegistry,
  createSkillRegistry,
  createToolRegistry,
  createWorkflowRegistry,
  type AcceptanceDefinition,
  type Disposer,
  type EffectRegistry,
  type SkillDefinition,
  type WorkflowDefinition,
} from "./registry.js";
import {
  createToolPipeline,
  type ToolDefinition,
  type ToolExecutionRequest,
  type ToolPipelineOptions,
} from "./tools.js";

export interface DomainAIContribution<Context = unknown> {
  /**
   * When present, IDs must start with "<namespace>." unless validation is
   * explicitly disabled for a legacy contribution.
   */
  readonly namespace?: string;
  readonly validateNamespace?: boolean;
  readonly intents?: readonly IntentDefinition<Context>[];
  readonly tools?: readonly ToolDefinition<Context>[];
  readonly workflows?: readonly WorkflowDefinition<
    JsonValue,
    JsonValue,
    Context
  >[];
  readonly acceptance?: readonly AcceptanceDefinition<JsonValue, Context>[];
  readonly skills?: readonly SkillDefinition<Context>[];
}

export interface AIContributionSnapshot<Context = unknown> {
  readonly intents: readonly IntentDefinition<Context>[];
  readonly tools: readonly ToolDefinition<Context>[];
  readonly workflows: readonly WorkflowDefinition<
    JsonValue,
    JsonValue,
    Context
  >[];
  readonly acceptance: readonly AcceptanceDefinition<JsonValue, Context>[];
  readonly skills: readonly SkillDefinition<Context>[];
}

export type AIContributionKind =
  | "acceptance"
  | "intent"
  | "skill"
  | "tool"
  | "workflow";

export interface AIContributionCatalogEntry {
  readonly id: string;
  readonly kind: AIContributionKind;
  readonly description?: string;
  readonly priority?: number;
}

export interface AIContributionCatalog {
  readonly intents: readonly AIContributionCatalogEntry[];
  readonly tools: readonly AIContributionCatalogEntry[];
  readonly workflows: readonly AIContributionCatalogEntry[];
  readonly acceptance: readonly AIContributionCatalogEntry[];
  readonly skills: readonly AIContributionCatalogEntry[];
}

export type BoundToolExecutionRequest<Context = unknown> = Omit<
  ToolExecutionRequest<Context>,
  "host"
>;

export interface BoundToolPipeline<Context = unknown> {
  execute(request: BoundToolExecutionRequest<Context>): Promise<ToolResult>;
}

export type AIContributionToolPipelineOptions<Context> = Omit<
  ToolPipelineOptions<Context>,
  "tools"
>;

const namespacePattern =
  /^[A-Za-z0-9](?:[A-Za-z0-9_-]*)(?:\.[A-Za-z0-9](?:[A-Za-z0-9_-]*))*$/;

function entries<Context>(
  contribution: DomainAIContribution<Context>,
): readonly {
  readonly kind: AIContributionKind;
  readonly value:
    | AcceptanceDefinition<JsonValue, Context>
    | IntentDefinition<Context>
    | SkillDefinition<Context>
    | ToolDefinition<Context>
    | WorkflowDefinition<JsonValue, JsonValue, Context>;
}[] {
  return [
    ...(contribution.intents ?? []).map((value) => ({
      kind: "intent" as const,
      value,
    })),
    ...(contribution.tools ?? []).map((value) => ({
      kind: "tool" as const,
      value,
    })),
    ...(contribution.workflows ?? []).map((value) => ({
      kind: "workflow" as const,
      value,
    })),
    ...(contribution.acceptance ?? []).map((value) => ({
      kind: "acceptance" as const,
      value,
    })),
    ...(contribution.skills ?? []).map((value) => ({
      kind: "skill" as const,
      value,
    })),
  ];
}

function validateContributionNamespace<Context>(
  contribution: DomainAIContribution<Context>,
): void {
  const shouldValidate =
    contribution.validateNamespace ??
    contribution.namespace !== undefined;
  if (!shouldValidate) return;
  if (!contribution.namespace || !namespacePattern.test(contribution.namespace)) {
    throw new ProtocolInvariantError(
      "invalid_contribution_namespace",
      "A validated contribution requires a valid dot-separated namespace",
    );
  }
  const prefix = `${contribution.namespace}.`;
  for (const entry of entries(contribution)) {
    if (!entry.value.id.startsWith(prefix)) {
      throw new ProtocolInvariantError(
        "contribution_namespace_mismatch",
        `${entry.kind} "${entry.value.id}" must start with "${prefix}"`,
      );
    }
  }
}

function catalogEntry(
  kind: AIContributionKind,
  entry: { readonly id: string; readonly description?: string },
  priority?: number,
): AIContributionCatalogEntry {
  return Object.freeze({
    id: entry.id,
    kind,
    ...(entry.description === undefined
      ? {}
      : { description: entry.description }),
    ...(priority === undefined ? {} : { priority }),
  });
}

/**
 * Adapter-neutral composition root for AI domain contributions.
 */
export class AIContributionHost<Context = unknown> {
  readonly intents: EffectRegistry<IntentDefinition<Context>>;
  readonly tools: EffectRegistry<ToolDefinition<Context>>;
  readonly workflows: EffectRegistry<
    WorkflowDefinition<JsonValue, JsonValue, Context>
  >;
  readonly acceptance: EffectRegistry<
    AcceptanceDefinition<JsonValue, Context>
  >;
  readonly skills: EffectRegistry<SkillDefinition<Context>>;

  constructor() {
    this.intents = createIntentRegistry<Context>();
    this.tools = createToolRegistry<Context>();
    this.workflows = createWorkflowRegistry<JsonValue, JsonValue, Context>();
    this.acceptance = createAcceptanceRegistry<JsonValue, Context>();
    this.skills = createSkillRegistry<Context>();
  }

  registerDomain(contribution: DomainAIContribution<Context>): Disposer {
    validateContributionNamespace(contribution);
    const disposers: Disposer[] = [];
    try {
      for (const intent of contribution.intents ?? []) {
        disposers.push(this.intents.register(intent));
      }
      for (const tool of contribution.tools ?? []) {
        disposers.push(this.tools.register(tool));
      }
      for (const workflow of contribution.workflows ?? []) {
        disposers.push(this.workflows.register(workflow));
      }
      for (const evaluator of contribution.acceptance ?? []) {
        disposers.push(this.acceptance.register(evaluator));
      }
      for (const skill of contribution.skills ?? []) {
        disposers.push(this.skills.register(skill));
      }
    } catch (error) {
      for (const dispose of disposers.reverse()) dispose();
      throw error;
    }

    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      for (const dispose of disposers.reverse()) dispose();
    };
  }

  snapshot(): AIContributionSnapshot<Context> {
    return Object.freeze({
      intents: this.intents.list(),
      tools: this.tools.list(),
      workflows: this.workflows.list(),
      acceptance: this.acceptance.list(),
      skills: this.skills.list(),
    });
  }

  catalog(): AIContributionCatalog {
    const snapshot = this.snapshot();
    return Object.freeze({
      intents: Object.freeze(
        snapshot.intents.map((entry) =>
          catalogEntry("intent", entry, entry.priority ?? 0),
        ),
      ),
      tools: Object.freeze(
        snapshot.tools.map((entry) => catalogEntry("tool", entry)),
      ),
      workflows: Object.freeze(
        snapshot.workflows.map((entry) => catalogEntry("workflow", entry)),
      ),
      acceptance: Object.freeze(
        snapshot.acceptance.map((entry) =>
          catalogEntry("acceptance", entry),
        ),
      ),
      skills: Object.freeze(
        snapshot.skills.map((entry) => catalogEntry("skill", entry)),
      ),
    });
  }

  routeIntent(
    request: IntentRequest,
    context: Context,
  ): Promise<IntentRoute> {
    return routeIntent(this.intents, request, context);
  }

  createToolPipeline(
    context: Context,
    options: AIContributionToolPipelineOptions<Context> = {},
  ): BoundToolPipeline<Context> {
    const pipeline = createToolPipeline({
      ...options,
      tools: this.tools,
    });
    return Object.freeze({
      execute: (request: BoundToolExecutionRequest<Context>) =>
        pipeline.execute({ ...request, host: context }),
    });
  }

  activateSkills(context: Context): Disposer {
    return activateSkills(this.skills, context);
  }
}
