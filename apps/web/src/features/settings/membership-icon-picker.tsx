import { useState } from "react";
import { membershipIconSets } from "@core/modules/entitlements/icons.js";
import { MembershipIcon, membershipIcons } from "@web/features/settings/membership-icon.js";

export function MembershipIconPicker({
  label,
  value,
  onChange,
}: {
  label: string;
  value?: string;
  onChange: (icon: string) => void;
}) {
  const [set, setSet] = useState(
    membershipIcons.find((icon) => icon.id === value)?.set ?? "classic",
  );
  return (
    <fieldset className="membership-icon-picker">
      <legend>{label}</legend>
      <div className="membership-icon-sets" role="group" aria-label="图标风格">
        {membershipIconSets.map((item) => (
          <button
            type="button"
            key={item.id}
            aria-pressed={set === item.id}
            onClick={() => setSet(item.id)}
          >
            {item.name}
          </button>
        ))}
      </div>
      <div className="membership-icon-options" role="group" aria-label={label}>
        <button
          type="button"
          aria-pressed={!value}
          onClick={() => onChange("")}
        >
          <span className="membership-icon-empty">—</span>不显示图标
        </button>
        {membershipIcons
          .filter((icon) => icon.set === set)
          .map((icon) => (
            <button
              type="button"
              key={icon.id}
              aria-pressed={value === icon.id}
              onClick={() => onChange(icon.id)}
            >
              <MembershipIcon icon={icon.id} />
              {icon.name}
            </button>
          ))}
      </div>
    </fieldset>
  );
}
