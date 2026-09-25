import { createRoot } from "react-dom/client";
import { App } from "./app.js";
import { FeedbackViewport } from "@web/shared/components/feedback.js";
import { LocaleProvider } from "@web/shared/i18n.js";
import { loadWebPlugins } from "../plugins/load.js";

void loadWebPlugins().catch(error => console.error("Plugin discovery failed", error)).finally(() => {
createRoot(document.getElementById("root")!).render(
  <LocaleProvider>
    <App />
    <FeedbackViewport />
  </LocaleProvider>,
);
});
