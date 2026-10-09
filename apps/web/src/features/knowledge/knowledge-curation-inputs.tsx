import {Select} from "@web/shared/components/select.js";
import { useEffect, useState } from "react";
import { Paperclip, BookOpen } from "lucide-react";
import { api } from "@web/shared/api.js";
import { useI18n } from "@web/shared/i18n.js";
import { Dialog } from "@web/features/documents/dialogs.js";
import { SourcePicker } from "./knowledge-source-picker.js";
import { uploadDroppedTree } from "@web/features/files/upload-tree.js";
export function CurationInputs({
  libraryId,
  added,
}: {
  libraryId: string;
  added: (label: string) => void;
}) {
  const { t, locale } = useI18n();
  const [mode, setMode] = useState<"upload" | "reference">(),
    [targets, setTargets] = useState<Array<{ id: string; name: string }>>([]),
    [target, setTarget] = useState(""),
    [name, setName] = useState(""),
    [files, setFiles] = useState<File[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (mode === "upload")
      void api<{ items: typeof targets }>(
        `/knowledge/libraries/${libraryId}/upload-targets`,
      )
        .then((x) => setTargets(x.items))
        .catch((e) => setError(e.message));
  }, [mode, libraryId]);
  async function work(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      setMode(undefined);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="kc-composer-tools">
      <button
        type="button"
        onClick={() => {
          setError("");
          setMode("upload");
        }}
      >
        <Paperclip size={15} />
        {t("curator.upload")}
      </button>
      {mode && (
        <Dialog
          title={t(mode === "upload" ? "curator.upload" : "curator.reference")}
          close={() => {
            if (!busy) setMode(undefined);
          }}
          className="knowledge-source-picker-dialog"
        >
          {error && <p role="alert">{error}</p>}
          {mode === "reference" ? (
            <SourcePicker
              contentAdded={label=>{added(label);setMode(undefined);}}
              libraryId={libraryId}
              locale={locale}
              busy={busy}
              bind={(sourceKind, sourceIds, urls, title, guide) =>
                void work(async () => {
                  await api(
                    `/knowledge/libraries/${libraryId}/subscriptions`,
                    "POST",
                    {
                      sourceKind,
                      title,
                      guide,
                      ...(sourceKind === "url" ? { urls } : { sourceIds }),
                    },
                  );
                  added(title);
                })
              }
            />
          ) : (
            <div className="curator-form">
              <p>{t("curator.uploadHint")}</p>
              <label>
                {t("curator.destination")}
                <Select
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  disabled={busy}
                >
                  <option value="">{t("curator.newFolder")}</option>
                  {targets.map((folder) => (
                    <option key={folder.id} value={folder.id}>
                      {folder.name}
                    </option>
                  ))}
                </Select>
              </label>
              {!target && (
                <label>
                  {t("sourceGroup.name")}
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    disabled={busy}
                  />
                </label>
              )}
              <input
                type="file"
                multiple
                disabled={busy}
                onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
              />
              <button
                type="button"
                className="primary"
                disabled={busy || !files.length || (!target && !name.trim())}
                onClick={() =>
                  void work(async () => {
                    let folderId = target;
                    let label =
                      targets.find((x) => x.id === target)?.name ?? name.trim();
                    if (!folderId) {
                      const folder = await api<{ id: string }>(
                        "/files/folders",
                        "POST",
                        { name: name.trim() },
                      );
                      folderId = folder.id;
                      setTarget(folderId);
                      setTargets((old) => [
                        ...old,
                        { id: folderId, name: label },
                      ]);
                    }
                    // Existing upload endpoint verifies the current caller's write permission on every file.
                    await uploadDroppedTree(
                      files.map((file) => ({ path: file.name, file })),
                      folderId,
                      undefined,
                      { rootConflict: "merge" },
                    );
                    await api(
                      `/knowledge/libraries/${libraryId}/subscriptions`,
                      "POST",
                      {
                        sourceKind: "folder",
                        sourceId: folderId,
                        title: label,
                      },
                    );
                    added(label);
                    setFiles([]);
                  })
                }
              >
                {t(busy ? "bot.uploading" : "curator.upload")}
              </button>
            </div>
          )}
        </Dialog>
      )}
    </div>
  );
}
