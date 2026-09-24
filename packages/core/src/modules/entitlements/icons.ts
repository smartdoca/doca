/** Built-in identifiers only: no remote images or HTML in membership badges. */
const classicIcons = [
  {
    id: "standard",
    name: "普通用户",
    color: "#697586",
    background: "#edf1f5",
    symbol: "user",
  },
  {
    id: "bronze",
    name: "青铜会员",
    color: "#a75c35",
    background: "#ffead8",
    symbol: "medal",
  },
  {
    id: "silver",
    name: "白银会员",
    color: "#60758e",
    background: "#e9eff6",
    symbol: "medal",
  },
  {
    id: "gold",
    name: "黄金会员",
    color: "#b77900",
    background: "#fff0b3",
    symbol: "crown",
  },
  {
    id: "platinum",
    name: "铂金会员",
    color: "#078c8b",
    background: "#ccf6ef",
    symbol: "diamond",
  },
  {
    id: "diamond",
    name: "钻石会员",
    color: "#3567e8",
    background: "#e0eaff",
    symbol: "diamond",
  },
  {
    id: "vip",
    name: "VIP 会员",
    color: "#e77712",
    background: "#ffebd0",
    symbol: "crown",
  },
  {
    id: "svip",
    name: "超级会员",
    color: "#8645d3",
    background: "#f0e3ff",
    symbol: "crown",
  },
  {
    id: "star",
    name: "星耀会员",
    color: "#d34381",
    background: "#ffe0ed",
    symbol: "star",
  },
] as const;

export const membershipIconSets = [
  { id: "classic", name: "经典圆章" },
  { id: "shield", name: "守护盾牌" },
  { id: "crystal", name: "晶彩徽章" },
] as const;

export const membershipIcons = membershipIconSets.flatMap((set) =>
  classicIcons.map((icon) => ({
    ...icon,
    id: set.id === "classic" ? icon.id : `${set.id}-${icon.id}`,
    set: set.id,
  })),
);
