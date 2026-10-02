import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Drawer, Modal, Tooltip } from "antd";
import { Package } from "lucide-react";
import type {
  ExtensionContext,
  ExtensionResource,
  ExtensionScope,
  ExtensionSlot,
} from "@smartdoca/web-plugin-registry";
import { webPluginRegistry } from "./registry.js";
import { extensionViews, openExtensionView } from "./extension-ui.js";
import { notifyFeedback } from "@web/shared/components/feedback.js";
import { useI18n } from "@web/shared/i18n.js";
import "./extensions.css";

function capabilities(resource?: ExtensionResource) {
  if (!resource) return [];
  const rank = [
    "none",
    "reader",
    "commenter",
    "editor",
    "manager",
    "owner",
  ].indexOf(resource.role ?? "none");
  return [
    rank >= 1 ? "resource.read" : "",
    rank >= 2 ? "resource.comment" : "",
    rank >= 3 ? "resource.edit" : "",
    rank >= 4 ? "resource.manage" : "",
  ].filter(Boolean);
}
export function useExtensionContext(
  scope: ExtensionScope,
  resource?: ExtensionResource,
  resources?: readonly ExtensionResource[],
): ExtensionContext {
  const { locale } = useI18n();
  const project = (row: ExtensionResource): ExtensionResource => ({
    id: row.id,
    kind: row.kind,
    format: row.format,
    title: row.title,
    role: row.role,
  });
  resource = resource ? project(resource) : undefined;
  resources = resources?.map(project);
  const identity = JSON.stringify([scope, resource, resources]);
  const [session, setSession] = useState<{
    identity: string;
    controller: AbortController;
  } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setSession({ identity, controller });
    return () => controller.abort();
  }, [identity]);
  const inactive = useMemo(() => AbortSignal.abort(), []);
  return {
    scope,
    resource,
    resources,
    target: location.hash.startsWith("#/m/plugins/") ? "mobile" : "web",
    locale,
    capabilities: capabilities(resource),
    signal:
      session?.identity === identity ? session.controller.signal : inactive,
  };
}
export function PluginSlot({
  slot,
  scope,
  resource,
  resources,
  display = "both",
}: {
  slot: ExtensionSlot;
  scope: ExtensionScope;
  resource?: ExtensionResource;
  resources?: readonly ExtensionResource[];
  display?: "both" | "icon";
}) {
  const context = useExtensionContext(scope, resource, resources);
  const [running, setRunning] = useState<string[]>([]);
  useEffect(() => {
    setRunning([]);
  }, [context.signal]);
  const placements = webPluginRegistry.extensions(slot, context);
  if (!placements.length) return null;
  return (
    <div
      className={`plugin-slot plugin-slot-${slot.replaceAll(".", "-")} plugin-slot-display-${display}`}
    >
      {placements.map((placement) => {
        const command = placement.commandId
          ? webPluginRegistry.commands.get(placement.commandId)
          : undefined;
        const view = placement.viewId
          ? webPluginRegistry.views.get(placement.viewId)
          : undefined;
        if (view && !placement.presentation)
          if (display === "icon")
            return (
              <details className="plugin-inline-view" key={placement.id}>
                <Tooltip
                  title={view.title[context.locale]}
                  placement="bottom"
                  mouseEnterDelay={0.3}
                >
                  <summary aria-label={view.title[context.locale]}>
                    <Package size={20} />
                  </summary>
                </Tooltip>
                <section className="plugin-view">
                  <header>{view.title[context.locale]}</header>
                  {view.render(context)}
                </section>
              </details>
            );
          else
            return (
              <section className="plugin-view" key={placement.id}>
                <header>{view.title[context.locale]}</header>
                {view.render(context)}
              </section>
            );
        const title = command?.title ?? view?.title;
        return (
          <Tooltip
            key={placement.id}
            title={display === "icon" ? title?.[context.locale] : undefined}
            placement="bottom"
            mouseEnterDelay={0.3}
          >
            <button
              type="button"
              aria-label={title?.[context.locale]}
              disabled={running.includes(placement.id)}
              onClick={() => {
                if (context.signal.aborted) return;
                if (view && placement.presentation) {
                  try {
                    openExtensionView(view.pluginId, {
                      viewId: view.id,
                      presentation: placement.presentation,
                      context,
                    });
                  } catch (error) {
                    notifyFeedback(
                      error instanceof Error ? error.message : String(error),
                      "error",
                    );
                  }
                  return;
                }
                if (command) {
                  setRunning((ids) => [...ids, placement.id]);
                  Promise.resolve()
                    .then(() => {
                      context.signal.throwIfAborted();
                      return command.execute(context);
                    })
                    .catch((error) => {
                      if (!context.signal.aborted)
                        notifyFeedback(
                          error instanceof Error
                            ? error.message
                            : String(error),
                          "error",
                        );
                    })
                    .finally(() => {
                      if (!context.signal.aborted)
                        setRunning((ids) =>
                          ids.filter((id) => id !== placement.id),
                        );
                    });
                }
              }}
            >
              {display === "icon" ? (
                <Package size={20} />
              ) : (
                title?.[context.locale]
              )}
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}
export function PluginExtensionHost() {
  const active = useSyncExternalStore(
    extensionViews.subscribe,
    extensionViews.snapshot,
  );
  const { locale, t } = useI18n();
  useEffect(() => {
    const close = () => extensionViews.close();
    window.addEventListener("hashchange", close);
    return () => {
      window.removeEventListener("hashchange", close);
      extensionViews.close();
    };
  }, []);
  const view = active ? webPluginRegistry.views.get(active.viewId) : undefined;
  if (!active || !view || active.context.signal.aborted) return null;
  const content = view.render({ ...active.context, locale });
  const title = view.title[locale];
  if (active.presentation === "dialog")
    return (
      <Modal
        open
        title={title}
        footer={null}
        onCancel={extensionViews.close}
        destroyOnHidden
      >
        {content}
      </Modal>
    );
  return (
    <Drawer
      open
      title={title}
      onClose={extensionViews.close}
      size={active.presentation === "sidebar" ? 380 : 560}
      destroyOnHidden
      aria-label={t("plugin.panel")}
    >
      {content}
    </Drawer>
  );
}
