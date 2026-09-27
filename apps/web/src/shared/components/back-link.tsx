import type { AnchorHTMLAttributes, MouseEvent } from "react";
import { navigateBackOr } from "@web/shared/utils/back-navigation.js";

export function BackLink({
  fallback,
  onClick,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { fallback: `/${string}` }) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented) return;
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    navigateBackOr(fallback);
  };

  return <a {...props} href={`#${fallback}`} onClick={handleClick} />;
}
