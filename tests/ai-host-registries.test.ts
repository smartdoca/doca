import { describe, expect, it } from "vitest";
import {
  activateSkills,
  createAcceptanceRegistry,
  createIntentRegistry,
  createSkillRegistry,
  createToolRegistry,
  createWorkflowRegistry,
  EffectRegistry,
  routeIntent,
} from "../packages/ai-host/src/index.js";

describe("AI host registries", () => {
  it("registers entries as disposable effects without ambient runner state", () => {
    const first = new EffectRegistry<{ id: string; value: number }>();
    const second = new EffectRegistry<{ id: string; value: number }>();
    const dispose = first.register({ id: "b", value: 2 });
    first.register({ id: "a", value: 1 });
    second.register({ id: "b", value: 20 });

    expect(first.list().map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(second.get("b")?.value).toBe(20);
    expect(Object.isFrozen(first.get("a"))).toBe(true);
    expect(() => first.register({ id: "a", value: 3 })).toThrow(
      /already registered/,
    );

    dispose();
    dispose();
    expect(first.has("b")).toBe(false);
    expect(second.has("b")).toBe(true);
  });

  it("provides independent typed registries for every extension kind", () => {
    const intents = createIntentRegistry();
    const tools = createToolRegistry();
    const workflows = createWorkflowRegistry();
    const acceptance = createAcceptanceRegistry();
    const skills = createSkillRegistry();

    intents.register({
      id: "intent",
      evaluate: () => ({ eligible: true, confidence: 1 }),
    });
    tools.register({
      id: "tool",
      execute: () => ({ ok: true }),
    });
    workflows.register({
      id: "workflow",
      run: () => ({ ok: true }),
    });
    acceptance.register({
      id: "acceptance",
      evaluate: () => ({ verdict: "accepted" }),
    });
    skills.register({ id: "skill", activate: () => undefined });

    expect([
      intents.size,
      tools.size,
      workflows.size,
      acceptance.size,
      skills.size,
    ]).toEqual([1, 1, 1, 1, 1]);
  });

  it("routes only eligible intents by confidence, priority, then stable ID", async () => {
    const registry = createIntentRegistry<{ tenant: string }>();
    registry.register({
      id: "ineligible-high",
      priority: 100,
      evaluate: (_request, context) => ({
        eligible: context.tenant === "other",
        confidence: 1,
      }),
    });
    registry.register({
      id: "low-confidence",
      priority: 100,
      evaluate: () => ({ eligible: true, confidence: 0.7 }),
    });
    registry.register({
      id: "priority-one",
      priority: 1,
      evaluate: () => ({ eligible: true, confidence: 0.9 }),
    });
    registry.register({
      id: "priority-two-z",
      priority: 2,
      evaluate: () => ({ eligible: true, confidence: 0.9 }),
    });
    registry.register({
      id: "priority-two-a",
      priority: 2,
      evaluate: () => ({
        eligible: true,
        confidence: 0.9,
        reason: "best stable tie",
      }),
    });

    const route = await routeIntent(
      registry,
      { text: "make it" },
      { tenant: "doca" },
    );
    expect(route.selected).toEqual({
      intentId: "priority-two-a",
      eligible: true,
      confidence: 0.9,
      priority: 2,
      reason: "best stable tie",
    });
    expect(route.candidates.at(-1)?.intentId).toBe("ineligible-high");
    expect(Object.isFrozen(route.candidates)).toBe(true);
  });

  it("rejects invalid router confidence", async () => {
    const registry = createIntentRegistry();
    registry.register({
      id: "invalid",
      evaluate: () => ({ eligible: true, confidence: Number.NaN }),
    });
    await expect(
      routeIntent(registry, { text: "hello" }, undefined),
    ).rejects.toMatchObject({ code: "invalid_intent_confidence" });
  });

  it("activates skill effects deterministically and disposes in reverse", () => {
    const registry = createSkillRegistry<string>();
    const lifecycle: string[] = [];
    registry.register({
      id: "b",
      activate: (context) => {
        lifecycle.push(`start-b-${context}`);
        return () => lifecycle.push("stop-b");
      },
    });
    registry.register({
      id: "a",
      activate: (context) => {
        lifecycle.push(`start-a-${context}`);
        return () => lifecycle.push("stop-a");
      },
    });

    const dispose = activateSkills(registry, "host");
    dispose();
    dispose();
    expect(lifecycle).toEqual([
      "start-a-host",
      "start-b-host",
      "stop-b",
      "stop-a",
    ]);
  });

  it("rolls back active skills if a later activation fails", () => {
    const registry = createSkillRegistry<string>();
    const lifecycle: string[] = [];
    registry.register({
      id: "a",
      activate: () => {
        lifecycle.push("start-a");
        return () => lifecycle.push("stop-a");
      },
    });
    registry.register({
      id: "b",
      activate: () => {
        throw new Error("activation failed");
      },
    });

    expect(() => activateSkills(registry, "host")).toThrow(
      "activation failed",
    );
    expect(lifecycle).toEqual(["start-a", "stop-a"]);
  });
});
