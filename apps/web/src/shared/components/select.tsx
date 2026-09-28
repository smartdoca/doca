import React, {
  Children,
  Fragment,
  isValidElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type SelectHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

type Item = { value: string; label: string; disabled: boolean };
function text(nodes: React.ReactNode): string {
  return Children.toArray(nodes)
    .map((n) =>
      typeof n === "string" || typeof n === "number"
        ? String(n)
        : isValidElement<{ children?: React.ReactNode }>(n)
          ? text(n.props.children)
          : "",
    )
    .join("");
}
export function selectItems(children: React.ReactNode): Item[] {
  return Children.toArray(children).flatMap((n) => {
    if (
      !isValidElement<{
        value?: string;
        children?: React.ReactNode;
        disabled?: boolean;
      }>(n)
    )
      return [];
    if (n.type === Fragment || n.type === "optgroup")
      return selectItems(n.props.children).map((x) => ({
        ...x,
        disabled: x.disabled || !!n.props.disabled,
      }));
    return n.type === "option"
      ? [
          {
            value: String(n.props.value ?? text(n.props.children)),
            label: text(n.props.children),
            disabled: !!n.props.disabled,
          },
        ]
      : [];
  });
}

/** Custom, keyboard-operable listbox; the hidden native control preserves FormData. */
export function Select({
  children,
  value,
  defaultValue,
  onChange,
  disabled,
  className = "",
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  const items = selectItems(children),
    [internal, setInternal] = useState(
      String(defaultValue ?? items[0]?.value ?? ""),
    );
  const selected = String(value ?? internal),
    [open, setOpen] = useState(false),
    [active, setActive] = useState(0),
    [position, setPosition] = useState({
      left: 0,
      top: 0,
      width: 180,
      maxHeight: 280,
      transform: "none",
    });
  const trigger = useRef<HTMLButtonElement>(null),
    native = useRef<HTMLSelectElement>(null),
    menu = useRef<HTMLDivElement>(null),
    search = useRef({ text: "", time: 0 }),
    id = useId();
  const enabled = items
    .map((item, index) => ({ item, index }))
    .filter((x) => !x.item.disabled);
  const current = items.find((x) => x.value === selected);
  function show() {
    if (disabled || !enabled.length) return;
    setActive(
      items.findIndex((x) => x.value === selected && !x.disabled) >= 0
        ? items.findIndex((x) => x.value === selected)
        : enabled[0]!.index,
    );
    setOpen(true);
  }
  function choose(index: number) {
    const item = items[index];
    if (!item || item.disabled) return;
    setInternal(item.value);
    setOpen(false);
    if (native.current) {
      native.current.value = item.value;
      onChange?.({
        target: native.current,
        currentTarget: native.current,
      } as React.ChangeEvent<HTMLSelectElement>);
    }
    trigger.current?.focus();
  }
  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const rect = trigger.current.getBoundingClientRect(),
      width = Math.min(Math.max(rect.width, 190), window.innerWidth - 24);
    const below = window.innerHeight - rect.bottom - 16,
      above = rect.top - 16;
    const flip = below < Math.min(items.length * 36 + 12, 220) && above > below;
    const maxHeight = Math.max(70, Math.min(280, flip ? above : below));
    setPosition({
      left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
      top: flip ? rect.top - 5 : rect.bottom + 5,
      transform: flip ? "translateY(-100%)" : "none",
      width,
      maxHeight,
    });
  }, [open, items.length]);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (
        !trigger.current?.contains(e.target as Node) &&
        !menu.current?.contains(e.target as Node)
      )
        setOpen(false);
    };
    const scroll = (e: Event) => {
      if (!menu.current?.contains(e.target as Node)) setOpen(false);
    };
    const close = () => setOpen(false);
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", scroll, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [open]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useEffect(() => {
    if (open)
      menu.current
        ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
        ?.scrollIntoView({ block: "nearest" });
  }, [active, open]);
  return (
    <span className={"select-control " + className + (open ? " is-open" : "")}>
      <button
        ref={trigger}
        id={props.id}
        type="button"
        className="select-trigger"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-activedescendant={open ? id + "-" + active : undefined}
        aria-label={props["aria-label"]}
        aria-labelledby={props["aria-labelledby"]}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(e) => {
          if (e.key === "Escape" && open) {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
            return;
          }
          if (e.key === "Tab") {
            setOpen(false);
            return;
          }
          if (["Enter", " "].includes(e.key)) {
            e.preventDefault();
            open ? choose(active) : show();
            return;
          }
          if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
            e.preventDefault();
            if (!open) {
              show();
              return;
            }
            const index = enabled.findIndex((x) => x.index === active);
            const next =
              e.key === "Home"
                ? 0
                : e.key === "End"
                  ? enabled.length - 1
                  : (index +
                      (e.key === "ArrowDown" ? 1 : -1) +
                      enabled.length) %
                    enabled.length;
            if (enabled[next]) setActive(enabled[next].index);
            return;
          }
          if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
            const now = Date.now();
            search.current = {
              text:
                (now - search.current.time < 600 ? search.current.text : "") +
                e.key.toLowerCase(),
              time: now,
            };
            const match = enabled.find((x) =>
              x.item.label.toLowerCase().startsWith(search.current.text),
            );
            if (match) {
              e.preventDefault();
              if (!open) show();
              setActive(match.index);
            }
          }
        }}
      >
        <span className="select-value">{current?.label ?? "请选择"}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      <select
        {...props}
        id={undefined}
        className="select-native"
        ref={native}
        value={selected}
        disabled={disabled}
        aria-hidden="true"
        tabIndex={-1}
        onChange={onChange}
      >
        {children}
      </select>
      {open &&
        createPortal(
          <div
            ref={menu}
            id={id}
            role="listbox"
            aria-label={props["aria-label"] ?? "可选项"}
            className="select-popover"
            style={{ position: "fixed", ...position }}
            onMouseDown={(e) => e.preventDefault()}
          >
            {items.map((item, index) => (
              <div
                key={item.value}
                role="option"
                id={id + "-" + index}
                aria-selected={item.value === selected}
                aria-disabled={item.disabled || undefined}
                data-index={index}
                className={
                  "select-option" +
                  (active === index ? " highlighted" : "") +
                  (item.value === selected ? " selected" : "") +
                  (item.disabled ? " disabled" : "")
                }
                onPointerMove={() => !item.disabled && setActive(index)}
                onClick={() => choose(index)}
              >
                <span>{item.label}</span>
                {item.value === selected && (
                  <Check size={15} aria-hidden="true" />
                )}
              </div>
            ))}
          </div>,
          trigger.current?.closest('[role="dialog"]') ?? document.body,
        )}
    </span>
  );
}
