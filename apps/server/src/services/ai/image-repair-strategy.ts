type RepairPage = {
  requirementsDigest: string;
  failures: Set<string>;
  comparedAt: number;
  selectedAssetId?: string;
};
/** Quality progress is independent of technical views, new asset IDs and paid fees. */
export class ImageRepairStrategy {
  private pages = new Map<string, RepairPage>();
  observe(
    referenceImageId: string,
    assetId: string,
    requirementsDigest: string,
    passed: boolean,
  ) {
    const current = this.pages.get(referenceImageId);
    if (passed) {
      this.pages.delete(referenceImageId);
      return;
    }
    const state: RepairPage =
      current?.requirementsDigest === requirementsDigest
        ? current
        : {
            requirementsDigest,
            failures: new Set<string>(),
            comparedAt: -1,
          };
    state.failures.add(assetId);
    if (state.selectedAssetId === assetId) {
      // Reviewing an older chosen candidate concludes this comparison. It is
      // not another generation round that should reopen the same comparison.
      state.comparedAt = state.failures.size;
      delete state.selectedAssetId;
    }
    this.pages.set(referenceImageId, state);
  }
  selected(referenceImageId: string, requirementsDigest: string, assetId: string) {
    const state = this.pages.get(referenceImageId);
    if (state?.requirementsDigest === requirementsDigest) {
      state.comparedAt = state.failures.size;
      state.selectedAssetId = assetId;
    }
  }
  beforePaid(referenceImageId: string, requirementsDigest: string) {
    const state = this.pages.get(referenceImageId);
    if (
      !state ||
      state.requirementsDigest !== requirementsDigest ||
      state.failures.size < 3
    )
      return null;
    return {
      failedAssetIds: [...state.failures],
      action:
        state.comparedAt < state.failures.size
          ? ("compare" as const)
          : state.failures.size >= 5
            ? ("stop" as const)
            : ("replan" as const),
    };
  }
}
