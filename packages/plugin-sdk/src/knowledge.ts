import { defineService } from "./index.js";
import type { KnowledgeSourceRegistryV1 } from "@smartdoca/knowledge-capability";
export * from "@smartdoca/knowledge-capability";
export const knowledgeSourceRegistryToken = defineService<Pick<KnowledgeSourceRegistryV1, "register">>("knowledge.sources.v1");
