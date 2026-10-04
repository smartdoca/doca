# Documentation maintenance

[中文](documentation.zh-CN.md)

The documentation uses Docsify 5.0.0. Markdown source stays in `docs/`; `docs/site/navigation.json` defines the public pages and their reading order. Technical contract source paths remain stable for repository and editor-skill references.

## Layout

| Group | Content |
| --- | --- |
| Getting started | Quick start, configuration, user guide, troubleshooting |
| User guides | Documents, sharing, permissions, notes, knowledge |
| Deployment and operations | Docker, storage, scaling, authentication, service credentials, webhooks |
| Development | Source setup, architecture, editors, collaboration, interface languages |
| Plugins | Development, installation, public services, contributions |
| Reference | API, database, SDK and editor contracts |
| Releases | Version-specific changes, requirements, and validation |
| Project | Documentation maintenance and original research/acceptance records |

Every public page has an English `name.md` and Chinese `name.zh-CN.md` with the same scope. Research and acceptance records retain their original text and language and are linked separately. An implementation inventory distinguishes exported APIs, proposals, and unverified external-service/device behavior.

## Check and preview

```sh
pnpm install --frozen-lockfile
pnpm docs:check
pnpm docs:dev
```

Open `http://127.0.0.1:39140/#/en/` or `http://127.0.0.1:39140/#/zh-cn/`. The preview reads documentation only and does not start Doca or connect to its databases. Re-run the command after source changes to regenerate the publication directory.

`pnpm docs:build` prepares `.cache/docs-site/` with folders such as `en/getting-started/` and `zh-cn/operations/`. It copies and rewrites Markdown links; Docsify renders content in the browser. It does not compile application code or pre-render the Markdown as HTML. The generated directory is ignored by Git.

Public-page links remain in the current language. Explicit English/Chinese links switch languages. Source-code, example, and research links open the corresponding GitHub files. Pages receive an edit-source link and a link to the translated counterpart. A missing translation fails the check rather than substituting another language. Checks also cover local targets, public heading anchors, and the corresponding language links in both root READMEs.

## GitHub Pages

The `.github/workflows/docs.yml` workflow checks documentation on pull requests and publishes changes from `main`. Configure the repository under **Settings → Pages → Build and deployment → Source → GitHub Actions**. The workflow uses the `github-pages` deployment environment and its approval rules. It can also be run manually from Actions.

The intended entrances are:

- English: <https://smartdoca.github.io/doca/#/en/>
- Chinese: <https://smartdoca.github.io/doca/#/zh-cn/>

These addresses become available after the workflow successfully deploys. README links point to their corresponding language entrances. The site uses the default GitHub Pages domain and requires no custom-domain DNS or repository CNAME file.

Serve the contents of `.cache/docs-site/` to publish elsewhere. Hash routing supports a repository subpath and direct refreshes without server route rewrites. The generated `.nojekyll` preserves underscored navigation files when hosted through Pages.

## Assets and updates

The Docsify runtime, search plugin, light/dark styles, and MIT license are vendored under `docs/site/assets/vendor/docsify/`. `README.txt` records the version and verified upstream npm tarball integrity. These resources load from the documentation site itself. Mermaid diagrams lazily load the pinned Mermaid ESM version in `site.js`; they require access to that CDN.

When adding a public page, create both languages, add the page to `navigation.json`, and run `pnpm docs:check`. Keep code examples and version requirements aligned. When updating a contract, follow the relevant repository skill and update its packaged references as required. Runtime assets and additional plugins require explicit version selection and browser verification.
