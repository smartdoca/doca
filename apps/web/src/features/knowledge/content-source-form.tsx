import { useState } from "react";
import type { ContentSourceDescriptor } from "@smartdoca/plugin-sdk/content";
import type { JsonObject } from "@smartdoca/plugin-sdk";
import { api } from "@web/shared/api.js";
import { Select } from "@web/shared/components/select.js";
import { useI18n } from "@web/shared/i18n.js";

export function ContentSourceForm({
  libraryId,
  source,
  back,
  added,
  initial,
}: {
  initial?: { groupId: string; title: string; config: JsonObject };
  libraryId: string;
  source: ContentSourceDescriptor;
  back: () => void;
  added: (title: string) => void;
}) {
  const { t, locale } = useI18n();
  const title = locale.startsWith("zh") ? source.title.zh : source.title.en;
  const [name, setName] = useState(initial?.title ?? title),
    [values, setValues] = useState<JsonObject>(initial?.config ?? {}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const fields = Object.entries(
    (source.configSchema.properties ?? {}) as Record<
      string,
      {
        type?: string;
        title?: string;
        description?: string;
        enum?: string[];
        items?: { type?: string };
        minimum?: number;
        maximum?: number;
      }
    >,
  );
  const supported = fields.every(
    ([, field]) =>
      ["string", "number", "integer", "boolean"].includes(field.type ?? "") ||
      (field.type === "array" && field.items?.type === "string"),
  );
  const required = Array.isArray(source.configSchema.required)
    ? source.configSchema.required
    : [];
  const valid =
    supported &&
    name.trim() &&
    required.every(
      (key) =>
        typeof key === "string" &&
        values[key] !== undefined &&
        values[key] !== "" &&
        (!Array.isArray(values[key]) || values[key].length > 0),
    );
  const set = (key: string, value: JsonObject[string]) =>
    setValues((old) => ({ ...old, [key]: value }));
  async function save() {
    setBusy(true);
    setError("");
    try {
      await api(
        initial
          ? `/knowledge/libraries/${libraryId}/content-source-groups/${initial.groupId}`
          : `/knowledge/libraries/${libraryId}/content-subscriptions`,
        initial ? "PUT" : "POST",
        { sourceId: source.id, title: name.trim(), config: values },
      );
      added(name.trim());
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="source-wizard-form">
      <button type="button" disabled={busy} onClick={back}>
        {t("library.relations.back")}
      </button>
      <h3>{title}</h3>
      <label>
        {t("sourceGroup.name")}
        <input
          maxLength={200}
          value={name}
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      {supported ? (
        fields.map(([key, field]) => (
          <label key={key}>
            {field.title || key}
            {field.enum ? (
              <Select
                disabled={busy}
                value={String(values[key] ?? "")}
                onChange={(e) => set(key, e.target.value)}
              >
                <option value="">{t("content.chooseValue")}</option>
                {field.enum.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </Select>
            ) : field.type === "boolean" ? (
              <Select
                disabled={busy}
                value={values[key] === undefined ? "" : String(values[key])}
                onChange={(e) => set(key, e.target.value === "true")}
              >
                <option value="" disabled>
                  {t("content.chooseValue")}
                </option>
                <option value="true">{t("content.enabled")}</option>
                <option value="false">{t("content.disabled")}</option>
              </Select>
            ) : field.type === "array" ? (
              <textarea
                disabled={busy}
                rows={3}
                value={Array.isArray(values[key]) ? values[key].join("\n") : ""}
                placeholder={t("content.onePerLine")}
                onChange={(e) =>
                  set(
                    key,
                    e.target.value
                      .split("\n")
                      .map((value) => value.trim())
                      .filter(Boolean),
                  )
                }
              />
            ) : (
              <input
                disabled={busy}
                type={field.type === "string" ? "text" : "number"}
                min={field.minimum}
                max={field.maximum}
                step={field.type === "integer" ? 1 : undefined}
                value={String(values[key] ?? "")}
                onChange={(e) =>
                  set(
                    key,
                    field.type === "string" || e.target.value === ""
                      ? e.target.value
                      : Number(e.target.value),
                  )
                }
              />
            )}
            {field.description && <small>{field.description}</small>}
          </label>
        ))
      ) : (
        <p>{t("content.configUnsupported")}</p>
      )}
      {error && <p role="alert">{error}</p>}
      <button
        type="button"
        className="primary"
        disabled={busy || !valid}
        onClick={() => void save()}
      >
        {t(
          busy
            ? "content.connecting"
            : initial
              ? "sourceGroup.save"
              : "sourceGroup.create",
        )}
      </button>
    </div>
  );
}
