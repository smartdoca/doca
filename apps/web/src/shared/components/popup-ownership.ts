/** Match a portalled popup to a trigger inside one of the supplied surfaces. */
export function ownsControlledPopup(
  target: Element,
  surfaces: readonly (Element | null)[],
) {
  const popup = target.closest("[role=listbox], .user-profile-card");
  if (!popup?.id) return false;
  return surfaces.some((surface) =>
    Array.from(surface?.querySelectorAll("[aria-controls]") ?? []).some(
      (trigger) =>
        trigger.getAttribute("aria-controls")?.split(/\s+/).includes(popup.id),
    ),
  );
}
