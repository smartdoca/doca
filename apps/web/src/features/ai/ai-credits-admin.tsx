import { useEffect, useState } from "react";
import { api } from "@web/shared/api.js";
import { Feedback } from "@web/shared/components/feedback.js";
import { PersonPicker } from "@web/features/documents/person-picker.js";
import "@web/features/ai/ai.css";
export function AICreditsAdmin() {
  const [config, setConfig] = useState<any>(null),
    [levels, setLevels] = useState<any[]>([]),
    [revision, setRevision] = useState(0),
    [message, setMessage] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [usage, setUsage] = useState<any>(null);
  const [recipient, setRecipient] = useState<{
    id: string;
    display_name: string;
  } | null>(null);
  const [usageUser, setUsageUser] = useState<{
    id: string;
    display_name: string;
  } | null>(null);
  const load = async () => {
    const r = await api<any>("/admin/ai/credits");
    const { revision, levels, ...c } = r;
    setRevision(revision);
    setConfig(c);
    setLevels(r.levels);
  };
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, []);
  const act = async (fn: () => Promise<any>, reload = true) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const r = await fn();
      setMessage(r?.message ?? "已保存");
      if (reload) await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!config) return <p>{error || "正在加载积分设置…"}</p>;
  return (
    <section className="ai-admin ai-credits-admin">
      <h3>AI 积分</h3>
      <p className="subtle">统一设置等级额度、模型消耗、积分加量和用量对账。</p>
      <Feedback message={error} tone="error" />
      <Feedback message={message} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void act(() =>
            api("/admin/ai/credits", "PUT", {
              revision,
              limits: config.limits,
              taskBudget: config.taskBudget,
              models: config.models.map(
                ({
                  id,
                  inputRate,
                  outputRate,
                  cacheRate,
                  imageRate,
                  imageSizeRates,
                }: any) => ({
                  id,
                  inputRate,
                  outputRate,
                  cacheRate,
                  imageRate,
                  imageSizeRates,
                }),
              ),
            }),
          );
        }}
      >
        <h3>模型消耗倍率</h3>
        <p className="subtle">
          对话按“实际 Token ÷ 100 万 ×
          倍率”计费；缓存输入单独计费，倍率支持三位小数。向量模型由平台索引统一调用，仅输入倍率相关。生图使用独立的每张图片积分，可按尺寸分档，与对话共用会员额度及额外积分。
        </p>
        {!config.models.length ? (
          <p className="ai-admin-empty">
            暂无模型，请先在 AI 模型管理中添加厂商与模型。
          </p>
        ) : (
          <div className="account-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>模型 / 厂商</th>
                  <th>输入倍率</th>
                  <th>输出倍率</th>
                  <th>缓存输入倍率</th>
                  <th>每张图片积分</th>
                </tr>
              </thead>
              <tbody>
                {config.models.map((m: any) => (
                  <tr key={m.id}>
                    <th>
                      {m.name}
                      <small className="ai-muted"> · {m.vendor}</small>
                    </th>
                    {["inputRate", "outputRate", "cacheRate", "imageRate"].map((key, i) => (
                      <td key={key}>
                        {m.embedding && key !== "inputRate" ? (
                          "—"
                        ) : (
                          <input
                            aria-label={`${m.name}${["输入倍率", "输出倍率", "缓存输入倍率", "每张图片积分"][i]}`}
                            type="number"
                            required

                            min={0}
                            max={1000}
                            step="0.001"
                            value={m[key] ?? (key === "imageRate" ? 0 : "")}
                            onChange={(e) =>
                              setConfig({
                                ...config,
                                models: config.models.map((x: any) =>
                                  x.id === m.id
                                    ? { ...x, [key]: Number(e.target.value) }
                                    : x,
                                ),
                              })
                            }
                          />
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {config.models.some((m: any) => m.imageGeneration) && (
          <>
            <h4>按尺寸分档的生图积分</h4>
            <p className="subtle">
              为指定尺寸设置单独的每张图片积分；未列出的尺寸按上表“每张图片积分”结算。
            </p>
            {config.models
              .filter((m: any) => m.imageGeneration)
              .map((m: any) => {
                const setRates = (rates: Record<string, number>) =>
                  setConfig({
                    ...config,
                    models: config.models.map((x: any) =>
                      x.id === m.id ? { ...x, imageSizeRates: rates } : x,
                    ),
                  });
                return (
                  <div key={m.id}>
                    <p>
                      {m.name}
                      <small className="ai-muted"> · {m.vendor}</small>
                    </p>
                    {Object.entries(m.imageSizeRates ?? {}).map(
                      ([size, rate], i) => (
                        <div className="ai-actions" key={i}>
                          <input
                            aria-label={`${m.name}分档尺寸`}
                            placeholder="1024x1024"
                            pattern="[0-9]{2,4}x[0-9]{2,4}"
                            required
                            value={size}
                            onChange={(e) => {
                              const rates = { ...(m.imageSizeRates ?? {}) };
                              delete rates[size];
                              rates[e.target.value] = rate as number;
                              setRates(rates);
                            }}
                          />
                          <input
                            aria-label={`${m.name}${size}每张图片积分`}
                            type="number"
                            required
                            min={0}
                            max={1000}
                            step="0.001"
                            value={rate as number}
                            onChange={(e) =>
                              setRates({
                                ...(m.imageSizeRates ?? {}),
                                [size]: Number(e.target.value),
                              })
                            }
                          />
                          <button
                            type="button"
                            onClick={() => {
                              const rates = { ...(m.imageSizeRates ?? {}) };
                              delete rates[size];
                              setRates(rates);
                            }}
                          >
                            删除
                          </button>
                        </div>
                      ),
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        const rates = { ...(m.imageSizeRates ?? {}) };
                        const size = [
                          "1024x1024",
                          "2048x2048",
                          "1536x864",
                          "864x1536",
                        ].find((s) => !(s in rates));
                        if (size) setRates({ ...rates, [size]: 0 });
                      }}
                    >
                      添加尺寸档位
                    </button>
                  </div>
                );
              })}
          </>
        )}
        <label>
          每任务积分预算
          <input
            type="number"
            min={100}
            max={10000000}
            placeholder="不限"
            value={config.taskBudget ?? ""}
            onChange={(e) =>
              setConfig({
                ...config,
                taskBudget:
                  e.target.value === "" ? null : Number(e.target.value),
              })
            }
          />
        </label>
        <p className="subtle">
          每次模型调用会按上下文和最大输出预留积分，完成后按实际用量结算。
          任务预算留空表示不限，仅按会员等级积分额度控制；设置了上限时也需要覆盖这笔预留。
        </p>
        <h3>等级基础积分</h3>
        <p>
          三个周期共同限制基础消耗；额外积分可以补足。留空表示不限，0
          表示不赠送基础积分。
        </p>
        <table>
          <thead>
            <tr>
              <th>用户等级</th>
              <th>每日</th>
              <th>每周</th>
              <th>每月</th>
            </tr>
          </thead>
          <tbody>
            {levels.map((l) => (
              <tr key={l.id}>
                <td>{l.name}</td>
                {["day", "week", "month"].map((p) => (
                  <td key={p}>
                    <input
                      aria-label={`${l.name} ${p}`}
                      type="number"
                      min={0}
                      placeholder="不限"
                      value={
                        (config.limits[l.id] ?? { day: 0, week: 0, month: 0 })[
                          p
                        ] ?? ""
                      }
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          limits: {
                            ...config.limits,
                            [l.id]: {
                              day: 0,
                              week: 0,
                              month: 0,
                              ...config.limits[l.id],
                              [p]:
                                e.target.value === ""
                                  ? null
                                  : Number(e.target.value),
                            },
                          },
                        })
                      }
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="ai-muted">
          用户还需在“等级与会员”中具备 AI
          辅助创作权益；积分不会提高文档访问权限。
        </p>
        <button className="primary" disabled={busy}>
          保存 AI 积分设置
        </button>
      </form>
      <h3>单独增加积分</h3>
      <form
        className="ai-admin-grid"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          void act(
            () =>
              api("/admin/ai/grants", "POST", {
                id: crypto.randomUUID(),
                userId: recipient?.id,
                amount: Number(f.get("amount")),
                reason: f.get("reason"),
                expiresAt: f.get("expires")
                  ? new Date(String(f.get("expires"))).toISOString()
                  : null,
              }),
            false,
          );
        }}
      >
        <div>
          <p>发放给</p>
          <PersonPicker
            selected={recipient}
            select={setRecipient}
            clear={() => setRecipient(null)}
          />
        </div>
        <label>
          增加积分
          <input type="number" name="amount" min={1} required />
        </label>
        <label>
          原因
          <input name="reason" required />
        </label>
        <label>
          到期时间（留空永久）
          <input type="datetime-local" name="expires" />
        </label>
        <button disabled={busy || !recipient}>发放积分</button>
      </form>
      <h3>用量与对账</h3>
      <form
        className="ai-actions"
        onSubmit={(e) => {
          e.preventDefault();
          void act(
            async () =>
              setUsage(
                await api(
                  "/admin/ai/usage" +
                    (usageUser
                      ? `?userId=${encodeURIComponent(usageUser.id)}`
                      : ""),
                ),
              ),
            false,
          );
        }}
      >
        <PersonPicker
          selected={usageUser}
          select={setUsageUser}
          clear={() => setUsageUser(null)}
        />
        <button>查询</button>
      </form>
      {usage && (
        <table>
          <thead>
            <tr>
              <th>用户 / 模型</th>
              <th>实际用量</th>
              <th>缓存命中</th>
              <th>积分</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {usage.calls.map((c: any) => (
              <tr key={c.id}>
                <td>
                  {c.userName ?? usageUser?.display_name ?? "用户"} ·{" "}
                  {c.model ?? c.model_snapshot?.model}
                </td>
                <td>
                  {(c.input ?? c.input_tokens) + (c.output ?? c.output_tokens)}{" "}
                  Token
                  {c.callKind === "image" && <> · {c.images ?? 0} 张图片</>}
                </td>
                <td>
                  {c.callKind === "image"
                    ? "—"
                    : (c.cached ?? c.cached_tokens ?? 0).toLocaleString()}
                </td>
                <td>{c.points}</td>
                <td>
                  {(
                    {
                      confirmed: "已结算",
                      reserved: "预占中",
                      pending: "待对账",
                      site_test: "站点测试",
                      failed: "失败",
                      reconciled: "已对账",
                    } as Record<string, string>
                  )[c.state] ?? c.state}
                  {c.state === "pending" && (
                    <button
                      onClick={() => {
                        const images =
                          c.callKind === "image"
                            ? window.prompt(
                                "已核对的生成图片数量（0 或 1）",
                                "1",
                              )
                            : undefined;
                        if (images === null) return;
                        const input = window.prompt("已核对的输入 Token", "0"),
                          output =
                            input !== null
                              ? window.prompt("已核对的输出 Token")
                              : null,
                          cached =
                            output !== null
                              ? window.prompt("输入中命中缓存的 Token", "0")
                              : null;
                        if (
                          input !== null &&
                          output !== null &&
                          cached !== null
                        )
                          void act(async () => {
                            await api(
                              `/admin/ai/calls/${c.id}/reconcile`,
                              "POST",
                              {
                                input: Number(input),
                                output: Number(output),
                                cached: Number(cached),
                                ...(images === undefined
                                  ? {}
                                  : { images: Number(images) }),
                              },
                            );
                            setUsage(
                              await api(
                                "/admin/ai/usage" +
                                  (usageUser
                                    ? `?userId=${encodeURIComponent(usageUser.id)}`
                                    : ""),
                              ),
                            );
                          }, false);
                      }}
                    >
                      核对结算
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
