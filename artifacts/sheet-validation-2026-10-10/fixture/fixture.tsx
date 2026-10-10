import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { SpreadsheetEditor } from "@smartdoca/sheet";
import "@smartdoca/sheet/style.css";
function Fixture() {
  const [readOnly, setReadOnly] = useState(false);
  const [locale, setLocale] = useState("zh");
  return <main style={{ height: "100%", display: "flex", flexDirection: "column" }}>
    <header style={{ padding: 12, display: "flex", gap: 12 }}>
      <button onClick={() => setReadOnly(v => !v)}>Toggle readonly</button>
      <button onClick={() => setLocale(v => v === "zh" ? "en" : "zh")}>Toggle locale</button>
    </header>
    <SpreadsheetEditor workbookId="isolated-sheet-validation" locale={locale}
      readOnly={readOnly} toolbarLayout="two-row" showHeader={false}
      showInsertToolbar={false} showSaveState={false} autoSave={false}
      autoFitContent={false} style={{ flex: 1, minHeight: 0 }}
      onReady={handle => { window.qaHandle = handle; }}
      onError={e => { console.error(e); }} />
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
