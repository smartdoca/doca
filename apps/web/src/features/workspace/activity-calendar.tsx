import { Feedback } from "@web/shared/components/feedback.js";
import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { api } from "@web/shared/api.js";
import { FileIcon } from "@web/features/documents/document-controls.js";
import { activityHeatLevel, activityHeatLevels } from "@web/features/workspace/activity-heat.js";

type Data = {
  today: string;
  days: { day: string; read: number; edited: number }[];
  documents: {
    id: string;
    title: string;
    format?: "rich_text" | "spreadsheet" | "presentation" | "markdown" | "canvas";
    readAt: string | null;
    editedAt: string | null;
  }[];
};
const dayKey = (d: Date) =>
  new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
const monthTitle = (month: string) =>
  `${Number(month.slice(0, 4))}年${Number(month.slice(5))}月`;
const dayTitle = (day: string, today: string) => {
  const date = new Date(`${day}T12:00:00+08:00`);
  const week = "日一二三四五六"[date.getDay()];
  return `${Number(day.slice(5, 7))}月${Number(day.slice(8))}日 周${week}${day === today ? " · 今天" : ""}`;
};

export function ActivityCalendar({ refresh = 0 }: { refresh?: number }) {
  const tooltipId = useId();
  const [tip, setTip] = useState<{ text: string; left: number; top: number } | null>(null);
  const [today, setToday] = useState(dayKey(new Date()));
  const [month, setMonth] = useState(today.slice(0, 7));
  const [selected, setSelected] = useState<string | null>(today);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const timer = setInterval(() => setToday(dayKey(new Date())), 60000);
    return () => clearInterval(timer);
  }, []);
  const dates = Array.from(
    { length: new Date(Number(month.slice(0, 4)), Number(month.slice(5)), 0).getDate() },
    (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`,
  );
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    void api<Data>(
      `/me/activity?from=${dates[0]}&to=${dates.at(-1)}${selected ? `&day=${selected}` : ""}`,
      "GET",
      undefined,
      controller.signal,
    )
      .then(setData)
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => controller.abort();
  }, [month, selected, today, refresh]);
  function shift(delta: number) {
    const date = new Date(`${month}-15T12:00:00+08:00`);
    date.setMonth(date.getMonth() + delta);
    const next = dayKey(date).slice(0, 7);
    setMonth(next);
    setSelected((current) => (current?.startsWith(next) ? current : null));
  }
  const leading = (new Date(`${month}-01T12:00:00+08:00`).getDay() + 6) % 7;
  return (
    <section className="home-activity" aria-label="创作日历">
      <h2>创作日历</h2>
      <div>
        <div className="activity-month">
          <button type="button" title="上个月" aria-label="上个月" onClick={() => shift(-1)}>
            <ChevronLeft size={16} />
          </button>
          <strong>{monthTitle(month)}</strong>
          <button
            type="button"
            title="下个月"
            aria-label="下个月"
            disabled={month >= today.slice(0, 7)}
            onClick={() => shift(1)}
          >
            <ChevronRight size={16} />
          </button>
        </div>
        <div className="activity-grid month">
          {["一", "二", "三", "四", "五", "六", "日"].map((d) => (
            <small key={d}>{d}</small>
          ))}
          {Array.from({ length: leading }, (_, i) => (
            <span key={`blank-${i}`} />
          ))}
          {dates.map((day) => {
            const value = data?.days.find((d) => d.day === day);
            const read = value?.read ?? 0;
            const edited = value?.edited ?? 0;
            const label = data
              ? `${day === today ? "今天" : day} · 阅读 ${read} 篇 · 创作/编辑 ${edited} 篇`
              : "正在加载创作记录…";
            const showTip = (el: HTMLElement) => {
              const rect = el.getBoundingClientRect();
              setTip({
                text: label,
                left: Math.max(8, Math.min(innerWidth - 252, rect.left)),
                top: Math.min(innerHeight - 48, rect.bottom + 8),
              });
            };
            return (
              <button
                key={day}
                type="button"
                disabled={day > today}
                className={`${activityHeatLevel(read, edited)} ${day === today ? "today" : ""} ${selected === day ? "selected" : ""}`}
                aria-label={label}
                aria-pressed={selected === day}
                aria-describedby={tip?.text === label ? tooltipId : undefined}
                onMouseEnter={(e) => showTip(e.currentTarget)}
                onMouseLeave={() => setTip(null)}
                onFocus={(e) => showTip(e.currentTarget)}
                onBlur={() => setTip(null)}
                onClick={() => {
                  setTip(null);
                  setSelected(day);
                }}
              >
                {Number(day.slice(-2))}
              </button>
            );
          })}
        </div>
        <div className="activity-legend" aria-label="创作 / 编辑文档数量图例">
          {activityHeatLevels.map(({ className, label }) => (
            <span key={className}>
              <i className={className} aria-hidden="true" />
              {label}
            </span>
          ))}
        </div>
      </div>
      <div className="home-activity-day">
        <h3>{selected ? dayTitle(selected, today) : "选择日期"}</h3>
        {selected &&
          data?.documents.map((d) => (
            <a className="activity-document" key={d.id} href={`#/r/${d.id}`}>
              <FileIcon r={{ kind: "document", format: d.format ?? "rich_text" }} size="compact" />
              <span>{d.title}</span>
              <small>{d.editedAt ? "创作 / 编辑" : "阅读"}</small>
            </a>
          ))}
        {selected && data && !data.documents.length && (
          <p className="subtle">当天暂无可查看的文档活动</p>
        )}
        {!selected && <p className="subtle">选择一天，查看当天阅读和创作的文档。</p>}
        {!data && selected && <p className="subtle">正在加载创作记录…</p>}
      </div>
      {error && <Feedback message={error} tone="error" />}
      {tip &&
        createPortal(
          <div className="activity-tooltip" id={tooltipId} role="tooltip" style={{ left: tip.left, top: tip.top }}>
            {tip.text}
          </div>,
          document.body,
        )}
    </section>
  );
}
