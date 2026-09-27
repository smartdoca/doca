# Contributing to Doca

[简体中文](CONTRIBUTING.zh-CN.md)

Thank you for your interest in Doca. The project is preparing its public
contribution process together with its AGPL and commercial dual-licensing model.

## Current contribution status

Issues, reproducible bug reports, design discussion, and documentation feedback
are welcome. Before accepting substantive third-party code, the maintainers will
publish a contributor agreement reviewed for the dual-licensing model. Until
that agreement is available, do not submit code copied from another project and
do not assume that a pull request can be merged.

This temporary gate prevents the project from accepting code under terms that
would later conflict with either the AGPL release or a separately negotiated
commercial license. The contributor agreement must not remove the contributor’s
right to use their own work.

## Development checks

Use Node.js 22 or later and the pnpm version declared in `package.json`.

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

Security vulnerabilities must not be reported in a public issue. The private
reporting process will be documented in `SECURITY.md` before the public launch.
