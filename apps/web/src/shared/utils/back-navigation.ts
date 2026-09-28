export type BackNavigationTarget = {
  location: {
    hash: string;
  };
};

const currentBrowser = () => window as unknown as BackNavigationTarget;

/** Open the section list. Detail pages must not walk browser history. */
export function navigateBackOr(
  fallback: `/${string}`,
  target: BackNavigationTarget = currentBrowser(),
) {
  target.location.hash = fallback;
}
