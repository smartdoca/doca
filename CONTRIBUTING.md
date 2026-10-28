# Contributing to Doca

[简体中文](CONTRIBUTING.zh-CN.md)

Thank you for your interest in Doca. The project is licensed under the
[MIT License](LICENSE).

## Current contribution status

Issues, reproducible bug reports, design discussion, documentation feedback,
and pull requests are welcome. A contribution is licensed under the MIT License.

Do not submit code copied from another project unless you have the right to
license that code under the MIT License.

## Development checks

Use Node.js 22.12 or later and the pnpm version declared in `package.json`. Follow [development setup](docs/development.md) before starting the application.

```sh
pnpm install --frozen-lockfile
pnpm check
```

Tests must use isolated databases, documents, plugin directories, and accounts.
Never run collaboration tests against user data.

## Change expectations

- Keep public APIs documented and covered by tests.
- Do not import host-private source paths from public SDK or capability packages.
- Put user-facing text in the i18n catalogs; keep public identifiers and code
  comments in English.
- Preserve third-party copyright, license, and attribution notices.
- Never commit credentials, user data, local databases, or generated acceptance
  output.
- Update the relevant English documentation first and keep the Chinese
  translation linked and synchronized.
- Follow [AGENTS.md](AGENTS.md), including prior agreement for compatibility changes and the [database upgrade contract](docs/database-schema-evolution.md). Store generated verification output in `artifacts/`; commit reviewed summaries in `docs/verification/`.
- Run `pnpm docs:check` and `pnpm docs:build` for documentation changes.

Report security vulnerabilities privately to [smartdoca@163.com](mailto:smartdoca@163.com), the author contact listed in the README. Do not include exploit details or credentials in public issues.
