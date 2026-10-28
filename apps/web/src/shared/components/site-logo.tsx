import { BookOpen } from "lucide-react";
import "./site-logo.css";

export function SiteLogo({ url }: { url: string | null }) {
  return (
    <span
      className={`brand-symbol site-logo${url ? " site-logo-custom" : ""}`}
      aria-hidden="true"
    >
      {url ? <img src={url} alt="" /> : <BookOpen size={22} />}
    </span>
  );
}
