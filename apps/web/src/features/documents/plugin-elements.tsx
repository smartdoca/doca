import {
  Component,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Modal } from "antd";
import type {
  JsonObject,
  PluginElementFormat,
  PluginElementPayload,
} from "@smartdoca/plugin-contracts";
import {
  createPluginElementPayload,
  pluginElementState,
  type PluginElementContribution,
  type PluginElementContext,
  type PluginElementEditorContext,
} from "@smartdoca/web-plugin-registry";
import { webPluginRegistry } from "@web/plugins/registry.js";
import { useI18n } from "@web/shared/i18n.js";
import "./plugin-elements.css";

export function usePluginElements(format: PluginElementFormat) {
  useSyncExternalStore(
    webPluginRegistry.elements.subscribe,
    webPluginRegistry.elements.snapshot,
  );
  return webPluginRegistry.elements
    .list()
    .filter((item) => item.formats.includes(format));
}
export function ElementPlaceholder({
  type,
  reason = "unsupported",
}: {
  type?: string;
  reason?: "unsupported" | "invalid" | "failed";
}) {
  const { t } = useI18n();
  return (
    <span className="plugin-element-error" role="alert" title={type}>
      {t(`editor.element.${reason}`)}
      {type ? ` · ${type}` : ""}
    </span>
  );
}
export class ElementBoundary extends Component<
  { children: ReactNode; type?: string },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <ElementPlaceholder type={this.props.type} reason="failed" />
    ) : (
      this.props.children
    );
  }
}
function ElementEditor({
  provider,
  context,
}: {
  provider: PluginElementContribution<ReactNode>;
  context: PluginElementEditorContext;
}) {
  return provider.renderEditor(context);
}
export function ElementContent({
  provider,
  payload,
  context,
}: {
  provider: PluginElementContribution<ReactNode>;
  payload: PluginElementPayload;
  context: PluginElementContext;
}) {
  // Invoke in a child component so hooks and descendant failures stay contained.
  return provider.render!(structuredClone(payload), context);
}
export interface ElementDialogSession {
  readonly unsupported?: boolean;
  readonly type?: string;
  readonly initialData?: JsonObject;
  commit(payload: PluginElementPayload): void;
  remove?(): void;
}
export function PluginElementDialog({
  documentId,
  format,
  session,
  close,
}: {
  documentId: string;
  format: PluginElementFormat;
  session: ElementDialogSession;
  close(): void;
}) {
  const { locale, t } = useI18n();
  const providers = usePluginElements(format);
  const [selected, setSelected] = useState(session.type ?? "");
  const [error, setError] = useState(false);
  const provider = providers.find((item) => item.id === selected);
  const abort = useMemo(() => new AbortController(), [provider]);
  useEffect(() => () => abort.abort(), [abort]);
  const context: PluginElementEditorContext = {
    documentId,
    format,
    locale,
    readOnly: false,
    signal: abort.signal,
    initialData: session.initialData
      ? structuredClone(session.initialData)
      : null,
    cancel: close,
    submit(data) {
      if (
        abort.signal.aborted ||
        !provider ||
        webPluginRegistry.elements.get(provider.id) !== provider
      )
        return;
      try {
        session.commit(createPluginElementPayload(provider, data, locale));
        close();
      } catch {
        setError(true);
      }
    },
  };
  return (
    <Modal
      open
      title={provider?.title[locale] ?? t("editor.element.insert")}
      footer={null}
      destroyOnHidden
      onCancel={close}
    >
      {format === "spreadsheet" && (
        <p className="subtle">{t("editor.element.cellReplacement")}</p>
      )}
      {error && <p role="alert">{t("editor.element.invalid")}</p>}
      {session.unsupported ? (
        <ElementPlaceholder type={selected} />
      ) : !selected ? (
        <div className="plugin-element-choices">
          {providers.map((item) => (
            <button
              type="button"
              key={item.id}
              onClick={() => {
                setSelected(item.id);
                setError(false);
              }}
            >
              {item.title[locale]}
            </button>
          ))}
          {!providers.length && <p>{t("editor.element.empty")}</p>}
        </div>
      ) : provider ? (
        <ElementBoundary key={provider.id} type={provider.id}>
          <ElementEditor provider={provider} context={context} />
        </ElementBoundary>
      ) : (
        <ElementPlaceholder type={selected} />
      )}
      {session.remove && (
        <button
          type="button"
          className="plugin-element-remove"
          onClick={() => {
            try {
              session.remove!();
              close();
            } catch {
              setError(true);
            }
          }}
        >
          {t("editor.element.remove")}
        </button>
      )}
    </Modal>
  );
}
export { pluginElementState };
