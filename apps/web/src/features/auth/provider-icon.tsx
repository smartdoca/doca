import { Globe, KeyRound, ShieldCheck } from "lucide-react";
import { GitHubIcon } from "./github-icon.js";
import { GoogleIcon, QQIcon, WeChatIcon } from "./provider-brand-icons.js";

export function ProviderIcon({ type }: { type: string }) {
  return (
    <span className={`provider-icon ${type}`} aria-hidden="true">
      {type === "github" ? (
        <GitHubIcon />
      ) : type === "google" ? (
        <GoogleIcon />
      ) : type === "wechat" ? (
        <WeChatIcon />
      ) : type === "qq" ? (
        <QQIcon />
      ) : type === "oidc" ? (
        <ShieldCheck size={20} />
      ) : type === "oauth2" ? (
        <KeyRound size={20} />
      ) : (
        <Globe size={20} />
      )}
    </span>
  );
}
