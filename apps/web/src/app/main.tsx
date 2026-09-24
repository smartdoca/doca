import { createRoot } from "react-dom/client";
import { App } from "./app.js";
import { FeedbackViewport } from "@web/shared/components/feedback.js";

createRoot(document.getElementById("root")!).render(
  <>
    <App />
    <FeedbackViewport />
  </>,
);
