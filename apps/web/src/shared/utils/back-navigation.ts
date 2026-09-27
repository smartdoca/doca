export type BackNavigationTarget = {
  history: {
    length: number;
    back: () => void;
  };
  location: {
    hash: string;
  };
  navigation?: {
    canGoBack?: boolean;
  };
};

const currentBrowser = () => window as unknown as BackNavigationTarget;

export function hasPreviousHistory(target: BackNavigationTarget = currentBrowser()) {
  const canGoBack = target.navigation?.canGoBack;
  return typeof canGoBack === "boolean" ? canGoBack : target.history.length > 1;
}

export function navigateBackOr(
  fallback: `/${string}`,
  target: BackNavigationTarget = currentBrowser(),
) {
  if (hasPreviousHistory(target)) {
    target.history.back();
    return;
  }
  target.location.hash = fallback;
}
