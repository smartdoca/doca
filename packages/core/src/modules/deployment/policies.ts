import type { Transaction } from "kysely";
import type { DB, Schema } from "../../../../db/src/index.js";
export const distributionDefaults = {
  grantMode: "direct" as "direct" | "invite",
  sharedDocuments: "interacted" as "granted" | "interacted",
  libraryMembers: "granted" as "granted" | "interacted",
  publicLibraries: false,
  publicDiscovery: false,
  managerInfoVisible: false,
  ticketReviewers: { access: false, invitation: false },
  normalSearch: "joined" as "joined" | "accessible",
  autoCollectOpened: false,
  defaultVisibility: "invited" as
    "invited" | "requestable" | "authenticated" | "public",
  internetPublication: {
    document: true,
    library: true,
    assistant: true,
  } as Record<InternetPublicationKind, boolean>,
  internetPublicationUsers: [] as string[],
};
export type ContentDistribution = Pick<
  typeof distributionDefaults,
  | "grantMode"
  | "managerInfoVisible"
  | "defaultVisibility"
  | "autoCollectOpened"
  | "ticketReviewers"
>;
export const publicResourceKinds = [
  "document",
  "library",
  "assistant",
  "folder",
] as const;
export type PublicResourceKind = (typeof publicResourceKinds)[number];
export const internetPublicationKinds = [
  "document",
  "library",
  "assistant",
] as const;
export type InternetPublicationKind =
  (typeof internetPublicationKinds)[number];
export type PublicMode = "link" | "discover" | "search";
export function publicMode(
  policy: Distribution,
  kind: PublicResourceKind,
): PublicMode {
  return (
    policy.publicModes?.[kind] ??
    (policy.normalSearch === "accessible" ||
    (kind === "library" && policy.publicLibraries)
      ? "search"
      : policy.publicDiscovery
        ? "discover"
        : "link")
  );
}
export type Distribution = typeof distributionDefaults & {
  revision: number;
  publicModes?: Partial<Record<PublicResourceKind, PublicMode>>;
  resourcePolicies?: Partial<
    Record<"document" | "library", Partial<ContentDistribution>>
  >;
};
export function resourceDistribution(
  policy: Distribution,
  kind?: "document" | "library",
) {
  const override = kind ? policy.resourcePolicies?.[kind] : undefined;
  return {
    ...policy,
    ...override,
    ticketReviewers: {
      ...policy.ticketReviewers,
      ...override?.ticketReviewers,
    },
  };
}
export async function internetPublicationOpen(
  db: DB | Transaction<Schema>,
  actorId: string | undefined,
  kind: InternetPublicationKind,
) {
  const policy = await distributionPolicy(db);
  return (
    policy.internetPublication[kind] ||
    (!!actorId && policy.internetPublicationUsers.includes(actorId))
  );
}
export async function distributionPolicy(
  db: DB | Transaction<Schema>,
  kind?: "document" | "library",
): Promise<Distribution> {
  const row = await db
    .selectFrom("distribution_settings")
    .selectAll()
    .where("id", "=", "system")
    .executeTakeFirstOrThrow();
  const configured = JSON.parse(row.config);
  return resourceDistribution(
    {
      ...distributionDefaults,
      ...configured,
      resourcePolicies: {
        ...configured.resourcePolicies,
        document: {
          defaultVisibility: configured.defaultVisibility ?? "requestable",
          ...configured.resourcePolicies?.document,
        },
      },
      ticketReviewers: {
        ...distributionDefaults.ticketReviewers,
        ...configured.ticketReviewers,
      },
      internetPublication: {
        ...distributionDefaults.internetPublication,
        ...configured.internetPublication,
      },
      internetPublicationUsers: configured.internetPublicationUsers ??
        distributionDefaults.internetPublicationUsers,
      revision: row.revision,
    },
    kind,
  );
}
