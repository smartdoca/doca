import { createRoot } from "react-dom/client";
import { App } from "./app.js";
import { FeedbackViewport } from "@web/shared/components/feedback.js";
import { LocaleProvider } from "@web/shared/i18n.js";

createRoot(document.getElementById("root")!).render(
  <LocaleProvider>
    <App />
    <FeedbackViewport />
  </LocaleProvider>,
);
