import { useI18n } from "@web/shared/i18n.js";
import { useEffect, useState } from "react";
import { api } from "@web/shared/api.js";
import { Select } from "@web/shared/components/select.js";
import { Feedback } from "@web/shared/components/feedback.js";
import { PersonPicker } from "@web/features/documents/person-picker.js";
import { realtime } from "@web/features/documents/realtime.js";
import {
  resourceDistribution,
  publicResourceKinds,
  publicMode,
  type PublicMode,
  type Distribution,
  type ContentDistribution,
} from "@core/modules/deployment/policies.js";
type DistributionSettingsValue = Distribution & {
  internetPublicationPeople?: {
    id: string;
    display_name: string;
    public_id?: string;
  }[];
};
export function DistributionSettings() {
  const { t } = useI18n();
  const [value, setValue] = useState<DistributionSettingsValue | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    void api<Distribution>("/admin/distribution")
      .then(setValue)
      .catch((e) => setError(e.message));
  }, []);
  async function save(patch: Partial<Distribution>) {
    if (!value || busy) return;
    setBusy(true);
    try {
      const { internetPublicationPeople: _people, ...current } = value;
      setValue(
        await api("/admin/distribution", "PUT", { ...current, ...patch }),
      );
      window.dispatchEvent(new Event("doca-discovery-policy"));
      setError("");
    } catch (e) {
      setError((e as Error).message);
      setValue(await api("/admin/distribution"));
    } finally {
      setBusy(false);
    }
  }
  const contentCard = (kind: "document" | "library", name: string) => {
    const policy = value ? resourceDistribution(value, kind) : null;
    const patch = (v: Partial<ContentDistribution>) =>
      value &&
      void save({
        resourcePolicies: {
          ...value.resourcePolicies,
          [kind]: { ...value.resourcePolicies?.[kind], ...v },
        },
      });
    const toggle = (
      label: string,
      help: string,
      checked: boolean,
      change: (checked: boolean) => void,
    ) => (
      <label className="setting-toggle">
        <span>
          <strong>{label}</strong>
          <small>{help}</small>
        </span>
        <input
          type="checkbox"
          disabled={!value || busy}
          checked={checked}
          onChange={(e) => change(e.target.checked)}
        />
      </label>
    );
    return (
      <section className="admin-card" key={kind}>
        <h3>{name}</h3>
        <label className="policy-row">
          <strong>
            {t(
              kind === "document"
                ? "policy.defaultDocumentVisibility"
                : "policy.defaultLibraryVisibility",
            )}
          </strong>
          <Select
            aria-label={t(
              kind === "document"
                ? "policy.defaultDocumentVisibility"
                : "policy.defaultLibraryVisibility",
            )}
            disabled={!value || busy}
            value={policy?.defaultVisibility ?? "invited"}
            onChange={(e) =>
              patch({
                defaultVisibility: e.target
                  .value as ContentDistribution["defaultVisibility"],
              })
            }
          >
            <option value="invited">{t("policy.private")}</option>
            <option value="requestable">{t("policy.requestable")}</option>
            <option value="authenticated">{t("policy.authenticated")}</option>
            {value?.internetPublication[kind] !== false && (
              <option value="public">{t("policy.public")}</option>
            )}
          </Select>
          <small>{t("policy.newHelp")}</small>
        </label>
        <label className="policy-row">
          <strong>{t("policy.grantMode")}</strong>
          <Select
            aria-label={t("policy.grantLabel", { name })}
            disabled={!value || busy}
            value={policy?.grantMode ?? "direct"}
            onChange={(e) =>
              patch({
                grantMode: e.target.value as ContentDistribution["grantMode"],
              })
            }
          >
            <option value="direct">{t("policy.direct")}</option>
            <option value="invite">{t("policy.invite")}</option>
          </Select>
        </label>
        {toggle(
          t("policy.showManagers"),
          t("policy.showManagersHelp"),
          policy?.managerInfoVisible ?? false,
          (v) => patch({ managerInfoVisible: v }),
        )}
        <h4>{t("policy.list")}</h4>
        <label className="policy-row">
          <strong>
            {kind === "document"
              ? t("policy.sharedDocuments")
              : t("policy.libraries")}
          </strong>
          <Select
            aria-label={t("policy.listLabel", { name })}
            disabled={!value || busy}
            value={
              kind === "document"
                ? (value?.sharedDocuments ?? "interacted")
                : (value?.libraryMembers ?? "granted")
            }
            onChange={(e) =>
              void save({
                [kind === "document" ? "sharedDocuments" : "libraryMembers"]:
                  e.target.value,
              })
            }
          >
            <option value="granted">{t("policy.granted")}</option>
            <option value="interacted">{t("policy.interacted")}</option>
          </Select>
        </label>
        <h4>{t("policy.ticketPeople")}</h4>
        {toggle(
          t("policy.showReviewers"),
          t("policy.showReviewersHelp"),
          policy?.ticketReviewers.access ?? false,
          (v) =>
            patch({
              ticketReviewers: { ...policy!.ticketReviewers, access: v },
            }),
        )}
        {toggle(
          t("policy.showInvitationReviewers"),
          t("policy.showInvitationReviewersHelp"),
          policy?.ticketReviewers.invitation ?? false,
          (v) =>
            patch({
              ticketReviewers: { ...policy!.ticketReviewers, invitation: v },
            }),
        )}
      </section>
    );
  };
  return (
    <>
      <div className="distribution-cards">
        {contentCard("document", t("policy.document"))}
        {contentCard("library", t("policy.library"))}
      </div>
      <section className="admin-card admin-form-section">
        <h3>{t("policy.discovery")}</h3>
        <p>{t("discovery.policyHelp")}</p>
        {publicResourceKinds.map((kind) => (
          <div className="discovery-kind" key={kind}>
          <label className="policy-row">
            <strong>{t(`discovery.kind.${kind}`)}</strong>
            <Select
              disabled={!value || busy}
              value={value ? publicMode(value, kind) : "link"}
              onChange={(e) =>
                value &&
                void save({
                  publicModes: {
                    ...Object.fromEntries(
                      publicResourceKinds.map((k) => [k, publicMode(value, k)]),
                    ),
                    [kind]: e.target.value as PublicMode,
                  },
                })
              }
            >
              {(["link", "discover", "search"] as const).map((mode) => (
                <option key={mode} value={mode}>
                  {t(`discovery.mode.${mode}`)}
                </option>
              ))}
            </Select>
          </label>
            {kind !== "folder" && (
              <label className="setting-toggle">
                <span>
                  <strong>{t("policy.internetPublication")}</strong>
                  <small>{t("policy.internetPublicationHelp")}</small>
                </span>
                <input
                  type="checkbox"
                  disabled={!value || busy}
                  checked={value ? value.internetPublication[kind] : true}
                  onChange={(e) => {
                    if (!value) return;
                    const allowed = e.target.checked;
                    const patch: Partial<Distribution> = {
                      internetPublication: {
                        ...value.internetPublication,
                        [kind]: allowed,
                      },
                    };
                    if (
                      !allowed &&
                      (kind === "document" || kind === "library") &&
                      resourceDistribution(value, kind).defaultVisibility ===
                        "public"
                    )
                      patch.resourcePolicies = {
                        ...value.resourcePolicies,
                        [kind]: {
                          ...value.resourcePolicies?.[kind],
                          defaultVisibility: "authenticated",
                        },
                      };
                    void save(patch);
                  }}
                />
              </label>
            )}
          </div>
        ))}
        <div className="discovery-exception">
          <strong>{t("policy.internetPublicationUsers")}</strong>
          <small>{t("policy.internetPublicationUsersHelp")}</small>
        </div>
        <PersonPicker
          select={(person) => {
            if (!value || value.internetPublicationUsers.includes(person.id))
              return;
            void save({
              internetPublicationUsers: [
                ...value.internetPublicationUsers,
                person.id,
              ],
            });
          }}
        />
        <ul className="discovery-list">
          {value?.internetPublicationPeople?.map((person) => (
            <li key={person.id}>
              <div>
                <strong>{person.display_name}</strong>
                {person.public_id && <small>@{person.public_id}</small>}
              </div>
              <button
                type="button"
                disabled={busy}
                aria-label={t("policy.internetPublicationRemove")}
                onClick={() =>
                  value &&
                  void save({
                    internetPublicationUsers: value.internetPublicationUsers.filter(
                      (id) => id !== person.id,
                    ),
                  })
                }
              >
                {t("policy.internetPublicationRemove")}
              </button>
            </li>
          ))}
        </ul>
      </section>
      <Feedback message={error} tone="error" />
    </>
  );
}

export function Invitations({ changed }: { changed: () => void }) {
  const { t } = useI18n();
  const [items, setItems] = useState<
      {
        id: string;
        title: string;
        kind: string;
        state: string;
        role: string;
        version: number;
      }[]
    >([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const load = () =>
    api<{ items: typeof items }>("/me/invitations").then((d) =>
      setItems(d.items),
    );
  useEffect(() => {
    void load().catch((e) => setError(e.message));
    return realtime.subscribe((m) => {
      if (["notifications.changed", "connected"].includes(m.type))
        void load().catch(() => {});
    });
  }, []);
  return (
    <details className="invitation-inbox">
      <summary>
        {t("invitations.pending")}
        {items.length ? ` · ${items.length}` : ""}
      </summary>
      <div>
        {!items.length && <p className="subtle">{t("invitations.empty")}</p>}
        {items.map((i) => (
          <div className="invitation-row" key={i.id}>
            <span>
              <strong>{i.title}</strong>
              <small>
                {i.kind === "library"
                  ? t("policy.library")
                  : t("policy.document")}{" "}
                ·{" "}
                {i.state === "pending"
                  ? t("invitations.acceptHelp")
                  : t("invitations.joinHelp")}
              </small>
            </span>
            {[true, false].map((accept) => (
              <button
                key={String(accept)}
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await api(`/me/invitations/${i.id}`, "POST", {
                      accept,
                      version: i.version,
                    });
                    await load();
                    changed();
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {accept ? t("invitations.accept") : t("invitations.decline")}
              </button>
            ))}
          </div>
        ))}
        <Feedback message={error} tone="error" />
      </div>
    </details>
  );
}
