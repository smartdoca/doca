# Repository discovery and README assets

GitHub's default repository search checks the repository name, description, and
topics. README contents are searched only when the query includes `in:readme`.
Changing README copy alone therefore does not fix ordinary keyword searches.
See [Searching for repositories](https://docs.github.com/en/search-github/searching-on-github/searching-for-repositories).

## Repository settings

These settings are applied on GitHub separately from the files in this repository:

- Repository: `smartdoca/doca`
- Website: `https://d.smartdoca.cc`
- Description:

  > Doca｜开源文档管理与知识库，支持多人协同编辑、在线文档、Markdown、表格、幻灯片、画布和 AI 助手。Self-hosted document management, knowledge base & real-time collaborative editing for individuals and small teams.

- Topics: `document-management`, `knowledge-base`, `collaborative-editing`,
  `real-time-collaboration`, `online-office`, `self-hosted`, `markdown`,
  `rich-text-editor`, `spreadsheet`, `presentation`, `canvas`, `ai-assistant`,
  `yjs`, `react`, `typescript`, `docker`.

Keep the description bilingual so both Chinese and English searches can match.
Use topics describing shipped capabilities and actual technologies. GitHub allows
at most 20 topics; topic names use lowercase letters, numbers, and hyphens.
See [Classifying your repository with topics](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/classifying-your-repository-with-topics).

## Verification

Inspect the actual settings, then verify indexed keyword matches with GitHub's
repository search API. The `repo:` qualifier isolates this repository; it does
not change which fields the keyword searches.

```sh
gh repo view smartdoca/doca --json description,homepageUrl,repositoryTopics
gh api -X GET search/repositories -f q='协同编辑 repo:smartdoca/doca' --jq '.items[].full_name'
gh api -X GET search/repositories -f q='文档管理 repo:smartdoca/doca' --jq '.items[].full_name'
gh api -X GET search/repositories -f q='knowledge-base repo:smartdoca/doca' --jq '.items[].full_name'
gh api -X GET search/repositories -f q='topic:collaborative-editing repo:smartdoca/doca' --jq '.items[].full_name'
```

Search indexing and result ranking are controlled by GitHub. A successful scoped
match verifies discoverability for that query, not a first-page position in an
unscoped search. README changes must reach the default branch to appear on the
repository homepage.

## Product screenshots

The six JPEGs in `docs/images/` are actual browser captures of Doca, taken on
2026-10-09 with authored sample data in an isolated local deployment: the
workspace, rich text, Markdown, spreadsheet, slides, and canvas editors.
The logo is copied from `apps/web/public/favicon.svg`.

Capture new screenshots only from an isolated deployment with sample content.
Use the current native document formats. Do not publish private user documents,
credentials, administration settings, or fabricated AI results. Preserve the
application UI in the captures and update both READMEs together.

For README changes, run `pnpm docs:check`, check local asset paths, and inspect the
rendered English and Chinese files on GitHub. Keep deployment and release
requirements accurate when changing marketing copy.
