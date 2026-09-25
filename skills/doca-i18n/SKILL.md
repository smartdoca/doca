---
name: doca-i18n
description: Add interface languages to a Doca editor subpackage (rich text, spreadsheet, Markdown, canvas, slides, and future formats) or the Doca host. Use when adding Chinese/English UI copy, a locale prop, message catalogs, or another language. Dictionary keys are stable English identifiers, not Chinese or full-sentence English.
---

# Doca 界面语言

改编辑器子包或 Doca 宿主的界面文案前，先读 [界面语言约定](references/contract.md)。Doca 仓库里的 `docs/i18n.md` 是源文件；本 skill 的 `references/contract.md` 是给子包安装的副本。两边要一起改，不能各写各的。

子包自己保存界面文案。不要引用 Doca 的字典，也不要读取 `ui.locale` 或 `localStorage`。

## 子包要做的事

1. 给编辑器组件增加可选的 `locale?: string`。宿主会这样传入：

```tsx
<RichTextEditor locale={locale} />
```

当前只有 `zh` 和 `en`。不认识的代码按 `en` 显示。缺省时按 `zh` 显示。

2. 字典 key 用稳定的英文标识，例如 `toolbar.bold`、`find.replaceAll`。不要用中文，也不要用会随文案修改的整句英文。
3. 至少提供 `en` 和 `zh` 两份目录，key 集合相同。新增语言时只加一份目录。
4. 占位符写成 `{name}`。需要区分数量时提供 `key.one` 和 `key.other`，调用方传 `count`。
5. `locale` 变化只更新按钮、菜单、占位符和提示。不要因此重建文档、Y.Doc、协同适配器或插件列表。
6. 可以额外接受 `messages?: Record<string, string>` 覆盖个别 key。没有这份 prop 也可以。
7. 用户写进文档的文字、公式、单元格内容不翻译。

宿主只在安装包的类型声明里已经有 `locale` 时才传入。类型里还没有这个 prop 时不要先传。

## 增加一种语言

在宿主 `locales` 和每个编辑器子包里同时加上同一种语言代码和一份与英文 key 相同的目录。不要改已有 key，也不要改调用方式。
