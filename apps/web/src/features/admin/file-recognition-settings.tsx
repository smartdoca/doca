import { Check, ScanText, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@web/shared/api.js";
import { Feedback } from "@web/shared/components/feedback.js";
import { Select } from "@web/shared/components/select.js";

type FileGroup = "image" | "pdf" | "office" | "text" | "other";
type FileSource = "personal" | "ai" | "documents" | "shared";
type Config = { enabled: boolean; modelId: string | null; ocrEnabled: boolean; recognitionGroups: FileGroup[]; recognitionSources: FileSource[]; searchGroups: FileGroup[] };
type Settings = { revision: number; config: Config; models: Array<{ id: string; name: string; vision: boolean; pdf: boolean }> };

export function FileRecognitionSettings() {
  const [data, setData] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { void api<Settings>("/admin/files/recognition").then(setData).catch((e) => setError(e.message)); }, []);
  async function save() {
    if (!data) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const next = await api<Pick<Settings, "revision" | "config">>("/admin/files/recognition", "PUT", { revision: data.revision, config: data.config });
      setData((old) => old ? { ...old, ...next } : old);
      setMessage("文件识别设置已保存。之后上传的文件会按此配置异步处理。");
    } catch (e) { setError(e instanceof Error ? e.message : "保存失败"); }
    finally { setBusy(false); }
  }
  const update = (patch: Partial<Config>) => setData((old) => old ? { ...old, config: { ...old.config, ...patch } } : old);
  const toggle = <T extends string>(values: T[], value: T) => values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
  const groups = [["image", "图片"], ["pdf", "PDF"], ["office", "Office"], ["text", "文本/Markdown"], ["other", "其他文件"]] as const;
  const sources = [["personal", "我的文件夹"], ["ai", "AI 助手"], ["documents", "文档系统"], ["shared", "共享文件夹"]] as const;
  return <>
    <div className="admin-section-heading"><div><h2>文件识别</h2><p>配置上传文件的 AI 描述与 OCR。PDF、Office 和文本会先解析成 Markdown 再交给识别模型，不要求模型支持原生 PDF。未启用或未选择模型时，文件只保存原始内容，不调用 AI。</p></div></div>
    {error && <Feedback message={error} tone="error" />}
    {message && <Feedback message={message} tone="success" />}
    {!data ? <div className="empty">{error ? "无法加载设置" : "正在加载…"}</div> : <section className="admin-card file-recognition-settings">
      <div className="card-heading"><div><h3>识别策略</h3><p className="subtle">识别结果写入文件存储对象，文件信息可以覆盖它。</p></div><span className={`status-badge ${data.config.enabled ? "success" : ""}`}>{data.config.enabled ? "已启用" : "未启用"}</span></div>
      <button type="button" className={`service-row ${data.config.enabled ? "selected" : ""}`} onClick={() => update({ enabled: !data.config.enabled })}>
        <span className="setting-icon"><ScanText size={20} /></span><span><strong>上传后自动识别</strong><small>图片仍走视觉模型；PDF / Office / 文本先提取正文，再生成检索描述</small></span><span className="choice-dot">{data.config.enabled && <Check size={13} />}</span>
      </button>
      <label className="file-recognition-field">识别模型<Select value={data.config.modelId ?? ""} onChange={(event) => update({ modelId: event.target.value || null })} disabled={!data.config.enabled}><option value="">不选择模型</option>{data.models.map((model) => <option key={model.id} value={model.id}>{model.name}{model.vision ? " · 支持图片" : ""}{model.pdf ? " · 支持 PDF" : ""}</option>)}</Select></label>
      <label className="service-row"><span className="setting-icon"><ShieldCheck size={20} /></span><span><strong>启用 OCR</strong><small>本地提取不到文字的扫描 PDF，再尝试交给视觉模型</small></span><input type="checkbox" checked={data.config.ocrEnabled} onChange={(event) => update({ ocrEnabled: event.target.checked })} /></label>
      <div className="file-recognition-policy"><strong>自动生成说明的文件类型</strong><p>只有勾选类型的新上传文件会进入异步识别队列。</p><div>{groups.map(([value, label]) => <label key={value}><input type="checkbox" checked={data.config.recognitionGroups.includes(value)} onChange={() => update({ recognitionGroups: toggle(data.config.recognitionGroups, value) })} />{label}</label>)}</div></div>
      <div className="file-recognition-policy"><strong>自动识别的来源目录</strong><p>可分别控制个人、AI、文档和共享目录。</p><div>{sources.map(([value, label]) => <label key={value}><input type="checkbox" checked={data.config.recognitionSources.includes(value)} onChange={() => update({ recognitionSources: toggle(data.config.recognitionSources, value) })} />{label}</label>)}</div></div>
      <div className="file-recognition-policy"><strong>写入搜索索引的文件类型</strong><p>未勾选的类型不会出现在平台文件搜索和 AI 文件检索中。</p><div>{groups.map(([value, label]) => <label key={value}><input type="checkbox" checked={data.config.searchGroups.includes(value)} onChange={() => update({ searchGroups: toggle(data.config.searchGroups, value) })} />{label}</label>)}</div></div>
      {!data.models.length && <p className="admin-note">当前没有可用的非向量 AI 模型。请先在“AI 能力”中配置并启用模型。</p>}
      <div className="admin-form-footer"><span className="subtle">未配置时不会消耗 AI Token。</span><button className="primary" disabled={busy || (data.config.enabled && !data.config.modelId)} onClick={() => void save()}>{busy ? "保存中…" : "保存设置"}</button></div>
    </section>}
  </>;
}
