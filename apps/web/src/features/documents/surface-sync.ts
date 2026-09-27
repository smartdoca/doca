import { useEffect, useRef, useState } from "react";
import { realtime, fromBase64, toBase64 } from "@web/features/documents/realtime.js";
import { openReplica } from "@web/features/documents/offline-replica.js";
import { UpdateOutbox } from "@web/features/documents/update-outbox.js";
export interface SurfaceBinding<T> {
  value: T;
  vector(): Uint8Array;
  checkpoint(): Uint8Array;
  apply(update: Uint8Array): void | Promise<void>;
  local(fn: (update: Uint8Array, id?: string) => void): () => void;
  dispose(): void;
}
export type SurfaceFactory<T> = (
  bootstrap: { epochId: string; baseline?: any; update: Uint8Array },
  sessionId: string,
) => Promise<SurfaceBinding<T>>;
/** A single host transport and durable outbox for model-specific editor sessions. */
export function useSurfaceSync<T>(
  id: string,
  userId: string | undefined,
  codec: string,
  factory: SurfaceFactory<T>,
  changed: (() => void) | undefined,
  schemaVersion: number,
) {
  const changeRef = useRef(changed);
  changeRef.current = changed;
  const [binding, setBinding] = useState<SurfaceBinding<T> | null>(null),
    [connected, setConnected] = useState(false),
    [error, setError] = useState(""),
    [rank, setRank] = useState(5),
    [status, setStatus] = useState("正在加载…"),
    [revision, setRevision] = useState(0),
    [dirty, setDirty] = useState(false);
  const [presence, setPresence] = useState<{ self: string; sessions: any[] }>({
    self: "",
    sessions: [],
  });
  const blocked = useRef(false);
  const recovery = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    let active = true,
      hydrated = false,
      online = false,
      epochId: string | undefined,
      baseline: any,
      model: SurfaceBinding<T> | undefined,
      stopLocal: (() => void) | undefined,
      replica: Awaited<ReturnType<typeof openReplica>> | undefined;
    let storing = Promise.resolve(),
      receiving = Promise.resolve(),
      writes = 0;
    const sessionId = crypto.randomUUID();
    const publishStatus = (pending: boolean) => {
      if (!active) return;
      setDirty(pending || writes > 0);
      setStatus(
        online
          ? pending || writes
            ? "正在保存…"
            : "已保存到云端"
          : pending
            ? "已保存到本地 · 等待同步"
            : "本地副本 · 等待连接",
      );
    };
    const outbox = new UpdateOutbox(
      (entry) =>
        realtime.send({
          type: "update",
          id: entry.id,
          room: id,
          protocolVersion: 1,
          codec,
          schemaVersion,
          epochId,
          update: toBase64(entry.update),
        }),
      publishStatus,
    );
    recovery.current = async () => {
      const checkpoint = model?.checkpoint();
      await storing;
      const cached = await replica?.load();
      const bytes = checkpoint ?? cached?.checkpoint;
      if (!bytes) throw Error("暂无可导出的本地副本");
      const url = URL.createObjectURL(
        new Blob(
          [
            JSON.stringify({
              protocolVersion: 1,
              resourceId: id,
              codec,
              schemaVersion,
              epochId,
              baseline,
              update: toBase64(bytes),
              pending:
                cached?.pending.map((p) => ({
                  id: p.id,
                  update: toBase64(p.update),
                })) ?? [],
            }),
          ],
          { type: "application/json" },
        ),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `${id}-recovery.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    const fail = (e: unknown) => {
      blocked.current = true;
      online = false;
      outbox.pause();
      if (active) {
        setError((e as Error).message);
        setConnected(false);
        setStatus("同步暂停 · 本地内容保留");
      }
    };
    const store = (update: Uint8Array) => {
      if (replica)
        storing = storing
          .then(async () => {
            await replica!.store(update, undefined, epochId, baseline);
          })
          .catch(fail);
    };
    const prepare = async (update: Uint8Array) => {
      model = await factory({ update, epochId: epochId!, baseline }, sessionId);
      if (!active) {
        model.dispose();
        return;
      }
      stopLocal = model.local((bytes, messageId) => {
        const entry = {
          id: messageId ?? crypto.randomUUID(),
          update: bytes.slice(),
        };
        writes++;
        publishStatus(true);
        setRevision((n) => n + 1);
        storing = storing
          .then(async () => {
            if (!replica) throw Error("无法保存本地副本，请勿关闭页面");
            await replica.store(entry.update, entry, epochId, baseline);
            writes--;
            if (active) outbox.enqueue(entry.update, entry.id);
          })
          .catch(fail);
      });
      setBinding(model);
    };
    const join = () => {
      if (!hydrated || !active || blocked.current) return;
      online = false;
      outbox.pause();
      setConnected(false);
      realtime.send({
        type: "join",
        id: crypto.randomUUID(),
        room: id,
        protocolVersion: 1,
        codec,
        schemaVersion,
        epochId,
        vector: toBase64(model?.vector() ?? new Uint8Array([0])),
      });
    };
    const validate = (m: any) => {
      if (
        m.protocolVersion !== 1 ||
        m.codec !== codec ||
        m.schemaVersion !== schemaVersion ||
        !m.epochId ||
        (epochId && m.epochId !== epochId)
      )
        throw Error("文档版本不匹配，请导出本地恢复文件；原内容未丢弃");
    };
    const unsub = realtime.subscribe((m) => {
      if (m.type === "connected") join();
      if (m.type === "disconnected") {
        online = false;
        outbox.pause();
        setConnected(false);
        setPresence((p) => ({ ...p, sessions: [] }));
        publishStatus(outbox.pending);
      }
      if (m.room !== id) return;
      if (m.type === "cursors") {
        setPresence({ self: m.self, sessions: m.sessions });
        return;
      }
      if (m.type === "error") {
        if (m.operation !== "cursor") fail(Error(m.message));
        return;
      }
      receiving = receiving
        .then(async () => {
          if (!active || blocked.current) return;
          if (m.type === "sync-response" || m.type === "update") {
            validate(m);
            epochId = m.epochId;
            if (m.baseline) {
              if (
                baseline &&
                JSON.stringify(baseline) !== JSON.stringify(m.baseline)
              )
                throw Error("表格基线不匹配");
              baseline = m.baseline;
            }
            const update = fromBase64(m.update);
            if (model) await model.apply(update);
            else await prepare(update);
            store(update);
            setRevision((n) => n + 1);
            if (m.type === "sync-response") {
              setRank(m.rank);
              online = true;
              setConnected(true);
              outbox.resume();
            }
          } else if (m.type === "ack") {
            validate(m);
            storing = storing
              .then(async () => {
                await replica?.acknowledge(m.id);
                if (active) outbox.acknowledge(m.id);
              })
              .catch(fail);
          } else if (m.type === "document.changed") {
            changeRef.current?.();
            if (online)
              realtime.send({
                type: "sync-request",
                id: crypto.randomUUID(),
                room: id,
                protocolVersion: 1,
                codec,
                schemaVersion,
                epochId,
                vector: toBase64(model!.vector()),
              });
          }
        })
        .catch(fail);
    });
    const release = realtime.retain();
    void (async () => {
      try {
        if (userId) {
          replica = await openReplica(userId, id, codec);
          const cached = await replica.load();
          if (!active) {
            replica.close();
            return;
          }
          if (cached.epochId) {
            epochId = cached.epochId;
            baseline = cached.baseline;
            await prepare(cached.checkpoint);
          }
          for (const entry of cached.pending)
            outbox.enqueue(entry.update, entry.id);
        }
        hydrated = true;
        if (realtime.connected) join();
      } catch (e) {
        fail(e);
      }
    })();
    const retry = setInterval(() => {
      if (online && outbox.pending && !blocked.current) {
        outbox.pause();
        outbox.resume();
      }
    }, 8000);
    const guard = (e: BeforeUnloadEvent) => {
      if (writes || outbox.pending || blocked.current) e.preventDefault();
    };
    window.addEventListener("beforeunload", guard);
    return () => {
      try {
        model?.checkpoint();
      } catch {}
      active = false;
      clearInterval(retry);
      window.removeEventListener("beforeunload", guard);
      stopLocal?.();
      outbox.pause();
      realtime.send({ type: "leave" });
      unsub();
      release();
      void receiving.finally(() => model?.dispose());
      void storing.finally(() => replica?.close());
    };
  }, [id, userId, codec, factory, schemaVersion]);
  return {
    binding,
    connected,
    error,
    rank,
    status,
    revision,
    dirty,
    presence,
    blocked: blocked.current,
    exportRecovery: () => recovery.current(),
  };
}
