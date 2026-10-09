import { useState, useEffect, useRef } from "react";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Collapse,
  Input,
  Space,
  Tag,
} from "antd";
import { Search, CheckCircle2, Link2 } from "lucide-react";
import { api } from "@web/shared/api.js";
import { useI18n } from "@web/shared/i18n.js";
import MarkdownPreview from "@web/features/documents/markdown-preview.js";

type Check = {
  url: string;
  valid: boolean;
  title?: string;
  characters?: number;
  preview?: string;
  checkedAt: string;
  error?: "invalid_url" | "unavailable" | "empty" | "too_large";
};
type Result = {
  title: string;
  url: string;
  snippet: string;
  retrievedAt: string;
};
export function BookWebSources({
  bookId,
  value,
  disabled,
  changed,
  verified,
}: {
  bookId: string;
  value: string;
  disabled: boolean;
  changed: (value: string) => void;
  verified: (ready: boolean) => void;
}) {
  const { t, locale } = useI18n();
  const alive = useRef(true),
    controllers = useRef(new Set<AbortController>());
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      for (const controller of controllers.current) controller.abort();
    };
  }, []);
  const [query, setQuery] = useState(""),
    [sites, setSites] = useState(""),
    [results, setResults] = useState<Result[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [checks, setChecks] = useState<Check[]>([]),
    [loading, setLoading] = useState(false),
    [checking, setChecking] = useState(false),
    [error, setError] = useState("");
  const urls = value
    .split(/\r?\n/)
    .map((url) => url.trim())
    .filter(Boolean);
  async function search() {
    const controller = new AbortController();
    controllers.current.add(controller);
    setLoading(true);
    setError("");
    setResults([]);
    setSelected([]);
    try {
      const response = await api<{ sources: Result[] }>(
        `/knowledge-books/${bookId}/source-search`,
        "POST",
        { query, sites, language: locale.startsWith("zh") ? "zh" : "en" },
        controller.signal,
      );
      if (!alive.current) return;
      setResults(response.sources);
      if (!response.sources.length) setError(t("books.noWebResults"));
    } catch {
      if (alive.current) setError(t("books.webSearchFailed"));
    } finally {
      controllers.current.delete(controller);
      if (alive.current) setLoading(false);
    }
  }
  async function check(candidates: string[], append = false) {
    if (!candidates.length) return;
    const controller = new AbortController();
    controllers.current.add(controller);
    setChecking(true);
    setError("");
    verified(false);
    try {
      const response = await api<{ items: Check[] }>(
        `/knowledge-books/${bookId}/source-web-check`,
        "POST",
        { urls: candidates },
        controller.signal,
      );
      if (!alive.current) return;
      setChecks(response.items);
      const withinLimit =
        response.items.reduce(
          (total, item) => total + (item.characters ?? 0),
          0,
        ) <= 120000;
      const ready =
        withinLimit &&
        response.items.length > 0 &&
        response.items.every((item) => item.valid);
      if (!ready)
        setError(
          t(withinLimit ? "books.webChecksFailed" : "books.webGroupTooLarge"),
        );
      if (append && ready) {
        changed([...new Set([...urls, ...candidates])].join("\n"));
        verified(false);
      } else verified(ready);
    } catch {
      if (alive.current) setError(t("books.webCheckFailed"));
    } finally {
      controllers.current.delete(controller);
      if (alive.current) setChecking(false);
    }
  }
  return (
    <div className="book-web-sources">
      <div className="book-web-search">
        <Input
          aria-label={t("books.webQuery")}
          placeholder={t("books.webQuery")}
          value={query}
          disabled={disabled || loading}
          onChange={(event) => setQuery(event.target.value)}
          onPressEnter={() => {
            if (query.trim()) void search();
          }}
        />
        <Button
          icon={<Search size={14} />}
          loading={loading}
          disabled={disabled || !query.trim()}
          onClick={() => void search()}
        >
          {t("books.findWebSources")}
        </Button>
      </div>
      <Input
        aria-label={t("books.webSites")}
        placeholder={t("books.webSitesHelp")}
        value={sites}
        disabled={disabled || loading}
        onChange={(event) => setSites(event.target.value)}
      />
      {error && <Alert type="warning" message={error} />}
      {!!results.length && (
        <>
          <p className="book-section-note">{t("books.webResultsHelp")}</p>
          <div className="book-web-results">
            {results.map((result) => (
              <Card
                size="small"
                key={result.url}
                title={
                  <a href={result.url} target="_blank" rel="noreferrer">
                    {result.title}
                  </a>
                }
              >
                <small title={result.url}>{result.url}</small>
                <p>{result.snippet}</p>
                <Checkbox
                  checked={selected.includes(result.url)}
                  disabled={disabled || checking}
                  onChange={(event) =>
                    setSelected((old) =>
                      event.target.checked
                        ? [...old, result.url]
                        : old.filter((url) => url !== result.url),
                    )
                  }
                >
                  {t("books.selectWebSource")}
                </Checkbox>
              </Card>
            ))}
          </div>
          <Button
            icon={<Link2 size={14} />}
            loading={checking}
            disabled={disabled || !selected.length}
            onClick={() => void check(selected, true)}
          >
            {t("books.useWebResults")}
          </Button>
        </>
      )}
      <Input.TextArea
        aria-label={t("books.bulkUrls")}
        placeholder={t("books.bulkUrlsHelp")}
        rows={4}
        value={value}
        disabled={disabled || checking}
        onChange={(event) => {
          changed(event.target.value);
          verified(false);
          setChecks([]);
        }}
      />
      <Space>
        <Button
          icon={<CheckCircle2 size={14} />}
          loading={checking}
          disabled={disabled || !urls.length || urls.length > 50}
          onClick={() => void check(urls)}
        >
          {t("books.checkWebLinks")}
        </Button>
        <span className="book-section-note">{t("books.checkWebHelp")}</span>
      </Space>
      {!!checks.length && (
        <div className="book-web-checks">
          {checks.map((item) => (
            <Card
              size="small"
              key={item.url}
              title={<span title={item.url}>{item.title || item.url}</span>}
              extra={
                <Tag color={item.valid ? "green" : "red"}>
                  {t(item.valid ? "books.webVerified" : "books.webUnavailable")}
                </Tag>
              }
            >
              <a
                href={item.url}
                target="_blank"
                rel="noreferrer"
                title={item.url}
              >
                {item.url}
              </a>
              {item.valid ? (
                <>
                  <p>
                    {t("books.webCharacterCount", {
                      count: item.characters ?? 0,
                    })}
                  </p>
                  <Collapse
                    ghost
                    items={[
                      {
                        key: "preview",
                        label: t("books.webPreview"),
                        children: (
                          <div className="book-markdown">
                            <MarkdownPreview value={item.preview ?? ""} />
                          </div>
                        ),
                      },
                    ]}
                  />
                </>
              ) : (
                <p>{t(`books.webError.${item.error ?? "unavailable"}`)}</p>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
