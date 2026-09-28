import { defineService } from "./index.js";
import type { KnowledgeSourceRegistryV1 } from "@doca/knowledge-capability";
export * from "@doca/knowledge-capability";
export const knowledgeSourceRegistryToken = defineService<Pick<KnowledgeSourceRegistryV1, "register">>("knowledge.sources.v1");
