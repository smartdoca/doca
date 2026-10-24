// Shared accessible dropdown for extension pages and the isolated page toolbar.
(() => {
  const instances = new WeakMap();
  function enhance(select) {
    if (instances.has(select)) return instances.get(select);
    const root = select.getRootNode();
    const wrapper = document.createElement("span");
    wrapper.className = "doca-select";
    select.before(wrapper);
    wrapper.append(select);
    select.hidden = true;
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "doca-select-trigger";
    trigger.setAttribute("role", "combobox");
    trigger.setAttribute("aria-haspopup", "listbox");
    const label = document.createElement("span"),
      arrow = document.createElement("span");
    arrow.className = "doca-select-arrow";

    arrow.setAttribute("aria-hidden", "true");
    trigger.append(label, arrow);
    const menu = document.createElement("div");
    menu.className = "doca-select-menu";
    menu.id = "doca-options-" + crypto.randomUUID();
    menu.setAttribute("role", "listbox");
    menu.hidden = true;
    trigger.setAttribute("aria-controls", menu.id);
    wrapper.append(trigger);
    // A transformed or scrolling confirmation panel must not clip its menu.
    if (root instanceof ShadowRoot) root.append(menu);
    else wrapper.append(menu);
    let active = 0,
      options = [],
      open = false;
    function close(focus = false) {
      open = false;
      menu.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
      trigger.removeAttribute("aria-activedescendant");
      if (focus) trigger.focus({ preventScroll: true });
    }
    function highlight() {
      [...menu.children].forEach((item, index) => {
        item.classList.toggle("is-active", index === active);
        if (index === active) {
          trigger.setAttribute("aria-activedescendant", item.id);
          item.scrollIntoView?.({ block: "nearest" });
        }
      });
    }
    function choose(index) {
      if (!options[index] || options[index].disabled) return;
      select.value = options[index].value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      sync();
      close(true);
    }
    function show() {
      if (select.disabled || !options.length) return;
      open = true;
      menu.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      active = Math.max(
        0,
        options.findIndex((option) => option.value === select.value),
      );
      const rect = trigger.getBoundingClientRect();
      menu.style.width =
        Math.min(Math.max(rect.width, 150), innerWidth - 16) + "px";
      const height = Math.min(menu.scrollHeight || 220, 220, innerHeight - 24);
      menu.style.maxHeight = height + "px";
      menu.style.left =
        Math.max(
          8,
          Math.min(
            rect.left,
            innerWidth - menu.getBoundingClientRect().width - 8,
          ),
        ) + "px";
      menu.style.top =
        (rect.bottom + height + 8 <= innerHeight
          ? rect.bottom + 5
          : Math.max(8, rect.top - height - 5)) + "px";
      highlight();
    }
    function sync() {
      options = [...select.options];
      trigger.disabled = select.disabled;
      trigger.setAttribute(
        "aria-label",
        select.getAttribute("aria-label") ||
          select.closest("label")?.querySelector("span")?.textContent ||
          "",
      );
      label.textContent =
        options.find((option) => option.value === select.value)?.textContent ||
        "";
      menu.replaceChildren(
        ...options.map((option, index) => {
          const item = document.createElement("button");
          item.type = "button";
          item.className = "doca-select-option";
          item.id = menu.id + "-" + index;
          item.setAttribute("role", "option");
          item.setAttribute(
            "aria-selected",
            String(option.value === select.value),
          );
          item.tabIndex = -1;
          item.disabled = option.disabled;
          item.textContent = option.textContent;
          item.onclick = () => choose(index);
          item.onpointermove = () => {
            active = index;
            highlight();
          };
          return item;
        }),
      );
      if (open && !select.disabled && options.length) highlight();
      else close();
    }
    trigger.onclick = () => (open ? close() : show());
    trigger.onkeydown = (event) => {
      if (
        [
          "ArrowDown",
          "ArrowUp",
          "Home",
          "End",
          "Enter",
          " ",
          "Escape",
        ].includes(event.key)
      )
        event.preventDefault();
      if (event.key === "Escape") return close(true);
      if (event.key === "Tab") return close();
      if (event.key === "Enter" || event.key === " ")
        return open ? choose(active) : show();
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      if (!options.some((option) => !option.disabled)) return;
      if (!open) show();
      else if (event.key === "Home") active = 0;
      else if (event.key === "End") active = options.length - 1;
      else
        active =
          (active + (event.key === "ArrowDown" ? 1 : -1) + options.length) %
          options.length;
      const direction = event.key === "ArrowUp" || event.key === "End" ? -1 : 1;
      while (options[active]?.disabled)
        active = (active + direction + options.length) % options.length;
      highlight();
    };
    const outside = (event) => {
      if (
        root instanceof ShadowRoot &&
        event.composedPath().includes(root.host)
      )
        return;
      if (!wrapper.contains(event.target) && !menu.contains(event.target))
        close();
    };
    const inside = (event) => {
      if (!wrapper.contains(event.target) && !menu.contains(event.target))
        close();
    };
    document.addEventListener("pointerdown", outside, true);
    if (root instanceof ShadowRoot)
      root.addEventListener("pointerdown", inside, true);
    const changed = () => sync();
    select.addEventListener("change", changed);
    const observer = new MutationObserver(sync);
    observer.observe(select, {
      childList: true,
      subtree: true,
      attributes: true,
    });
    const controller = {
      sync,
      close,
      destroy() {
        observer.disconnect();
        document.removeEventListener("pointerdown", outside, true);
        if (root instanceof ShadowRoot)
          root.removeEventListener("pointerdown", inside, true);
        select.removeEventListener("change", changed);
      },
    };
    instances.set(select, controller);
    sync();
    return controller;
  }
  globalThis.DocaSelect = { enhance };
})();
