import { useState } from "react";
import { Alert, Button, Modal } from "antd";
import { useI18n } from "@web/shared/i18n.js";
import { useAIChatRuntime } from "./ai-runtime.js";

export function AISessionDeleteDialog({
  sessionId,
  active,
  onClose,
  onDeleted,
}: {
  sessionId: string;
  active: boolean;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { t } = useI18n();
  const api = useAIChatRuntime().request;
  const [error, setError] = useState("");
  const [blocked, setBlocked] = useState(active);
  const [stopRequested, setStopRequested] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const busy = deleting || stopping;
  const remove = async () => {
    setDeleting(true);
    setError("");
    try {
      await api(`/ai/sessions/${sessionId}`, "DELETE");
    } catch (failure) {
      setError((failure as Error).message);
      if ((failure as { status?: number }).status === 409) {
        setBlocked(true);
        setStopRequested(false);
      }
      setDeleting(false);
      return;
    }
    onDeleted();
  };
  const stop = async () => {
    setStopping(true);
    setError("");
    try {
      const conversation = await api<{
        jobs: { id: string; status: string }[];
      }>(`/ai/sessions/${sessionId}`);
      const jobs = conversation.jobs.filter((job) =>
        ["queued", "running", "awaiting_approval"].includes(job.status),
      );
      await Promise.all(
        jobs.map((job) => api(`/ai/jobs/${job.id}/cancel`, "POST")),
      );
      setBlocked(false);
      setStopRequested(true);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setStopping(false);
    }
  };
  return (
    <Modal
      open
      title={t("chat.deleteConfirm")}
      okText={t("common.confirm")}
      cancelText={t("common.cancel")}
      okButtonProps={{ danger: true, disabled: stopping || blocked }}
      cancelButtonProps={{ disabled: busy }}
      confirmLoading={deleting}
      closable={!busy}
      mask={{ closable: !busy }}
      keyboard={!busy}
      onCancel={onClose}
      onOk={() => void remove()}
    >
      <div style={{ display: "grid", gap: 12 }}>
        <p style={{ margin: 0 }}>{t("chat.deleteHelp")}</p>
        {error && <Alert type="error" title={error} />}
        {blocked && (
          <Alert
            type="warning"
            title={t("chat.deleteStopHelp")}
            action={
              <Button
                loading={stopping}
                disabled={deleting}
                onClick={() => void stop()}
              >
                {t("chat.stop")}
              </Button>
            }
          />
        )}
        {stopRequested && (
          <Alert type="info" title={t("chat.deleteStopRequested")} />
        )}
      </div>
    </Modal>
  );
}
