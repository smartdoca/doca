import { defineService } from "@doca/plugin-sdk";
import type { AIContributionHost } from "@doca/ai-host";
import type { SearchSource } from "@doca/search-host";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Actor } from "@core/modules/identity/passwords.js";
import type { DB } from "@db/index.js";
import type { CreateAppOptions } from "../app/create-app.js";
import type { registerRuntimeSettings } from "../routes/runtime-settings.js";
import type { registerSearch } from "../routes/search.js";
import type { registerRealtime } from "../services/realtime/gateway.js";
import type { AIContributionExecutionContext } from "../services/ai/runner.js";

export type SearchRegistration = Awaited<ReturnType<typeof registerSearch>>;

export interface SearchRegistrationService {
  require(): SearchRegistration;
}

export interface ServerRuntimeService {
  readonly api: FastifyInstance;
  readonly db: DB;
  readonly auth: (request: FastifyRequest) => Actor;
  readonly admin: (request: FastifyRequest) => Actor;
  readonly origin: URL;
  readonly runtime: Awaited<ReturnType<typeof registerRuntimeSettings>>;
  readonly options: CreateAppOptions;
  readonly realtime: Awaited<ReturnType<typeof registerRealtime>>;
}

export const serverRuntimeToken = defineService<ServerRuntimeService>(
  "doca.server.runtime",
);

export const searchRegistrationToken =
  defineService<SearchRegistrationService>("doca.server.search-registration");

export const searchSourceRegistryToken = defineService<{
  register(source: SearchSource<any, any>): { dispose(): void };
}>("search.sources.v1");

export const aiContributionToken =
  defineService<AIContributionHost<AIContributionExecutionContext>>(
    "doca.ai.contributions",
  );
