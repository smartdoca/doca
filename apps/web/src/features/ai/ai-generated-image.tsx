import { useEffect, useRef, useState } from "react";
import { Alert, Button, Image, Modal, Space } from "antd";
import { Download, FilePlus2 } from "lucide-react";
import { api, assetUrl } from "@web/shared/api.js";
import { SearchPanel } from "@web/features/search/search.js";

export function AIGeneratedImage({
  image,
  currentDocument,
  sessionId,
}: {
  image: {
    assetId: string;
    filename: string;
    width: number;
    height: number;
    ready: boolean;
  };
  currentDocument?: { id: string; title: string };
  sessionId?: string | null;
}) {
  const [picking, setPicking] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [inserted, setInserted] = useState<{ id: string; title: string }>();
  const [ready, setReady] = useState(image.ready);
  const [pending, setPending] = useState(!image.ready);
  useEffect(() => {
    setReady(image.ready);
    setPending(!image.ready);
  }, [image.assetId, image.ready]);
  useEffect(() => {
    if (ready || !pending) return;
    let active = true;
    const poll = async () => {
      try {
        const status = await api<{ ready: boolean; pending: boolean }>(
          `/ai/images/${image.assetId}/status`,
        );
        if (active) {
          setReady(status.ready);
          setPending(status.pending);
        }
      } catch (e) {
        if (active) {
          setError((e as Error).message);
          setPending(false);
        }
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [image.assetId, ready, pending]);
  const requests = useRef(new Map<string, string>());
  async function insert(resource: { id: string; title: string }) {
    if (busy) return;
    setBusy(true);
    setError("");
    const requestId = requests.current.get(resource.id) ?? crypto.randomUUID();
    requests.current.set(resource.id, requestId);
    try {
      await api("/ai/images/insert", "POST", {
        assetId: image.assetId,
        resourceId: resource.id,
        requestId,
        sessionId: sessionId ?? undefined,
      });
      setInserted(resource);
      setPicking(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!ready)
    return (
      <Alert
        type="info"
        title={pending ? "图片已生成，审核通过后可预览和下载" : "图片暂不可用"}
        action={
          <Button
            size="small"
            onClick={async () => {
              try {
                const r = await api<{ ready: boolean; pending: boolean }>(
                  `/ai/images/${image.assetId}/status`,
                );
                setReady(r.ready);
                setPending(r.pending);
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            检查状态
          </Button>
        }
        description={error || undefined}
      />
    );
  return (
    <div className="ai-generated-image">
      <Image
        src={assetUrl(image.assetId)}
        alt="AI 生成图片"
        width="100%"
        style={{ maxHeight: 320, objectFit: "contain", borderRadius: 10 }}
      />
      <Space size={8} wrap>
        <Button
          size="small"
          icon={<Download size={14} />}
          href={assetUrl(image.assetId) + "?download=1"}
          download={image.filename}
        >
          下载图片
        </Button>
        {currentDocument && (
          <Button
            size="small"
            loading={busy}
            onClick={() => void insert(currentDocument)}
            disabled={inserted?.id === currentDocument.id}
          >
            加入当前文档
          </Button>
        )}
        <Button
          size="small"
          icon={<FilePlus2 size={14} />}
          onClick={() => {
            setError("");
            setPicking(true);
          }}
        >
          加入到文档
        </Button>
      </Space>
      {inserted && (
        <p className="subtle">
          已加入 <a href={`#/r/${inserted.id}`}>{inserted.title}</a>
        </p>
      )}
      {error && !picking && <Alert type="error" title={error} />}
      <Modal
        title="将图片加入文档"
        open={picking}
        footer={null}
        onCancel={() => {
          if (!busy) setPicking(false);
        }}
        width={600}
      >
        <p className="subtle">
          文档追加到末尾，表格和画板放在已有内容下方，演示文稿新增一页图片。
        </p>
        {error && <Alert type="error" title={error} />}
        <SearchPanel compact select={(r) => void insert(r)} />
      </Modal>
    </div>
  );
}
