# Licensing

[简体中文](LICENSING.zh-CN.md)

Doca uses a dual-licensing model for code owned by the Doca copyright holders.

## Open-source license

Unless a file or package says otherwise, Doca-owned code in this repository is
available under the GNU Affero General Public License version 3 only
(`AGPL-3.0-only`). The full license text is in [LICENSE](LICENSE).

The AGPL permits commercial use. When its conditions apply, it requires the
corresponding source to remain available under the AGPL, including for modified
versions offered to users over a network. “Open source” and “free of charge” are
not the same thing, and the AGPL obligations do not depend on whether an operator
charges money.

## Commercial license

Organizations that want to use Doca-owned code in a proprietary product without
the AGPL obligations may obtain a separate commercial license from the Doca
copyright holders. A commercial license exists only when both parties have
entered into a written agreement. This repository does not itself grant that
alternative license.

## Packages and editors

The same licensing direction applies to Doca-owned packages and editors,
including the Doca plugin SDK and the Slate, presentation, spreadsheet,
Markdown, and canvas editor packages. Each released npm artifact must:

- carry an accurate license field and license notice;
- link to the public source repository and the exact source tag for that version;
- include the build scripts and dependency lock needed to produce the artifact;
- preserve all notices and license obligations of third-party components.

The historical archives under `vendor/` are development and recovery inputs.
They are not the long-term public distribution channel. Before the public
release, active editor dependencies must be rebuilt from their public tagged
sources, published to npm, and consumed by Doca through registry versions.

## Third-party software and assets

The dual license covers only material for which the Doca copyright holders can
grant these rights. Third-party libraries, fonts, media, generated artifacts,
and other bundled material retain their own licenses. Their notices and source
or attribution requirements must be followed independently.

No trademark rights are granted by either the AGPL or this licensing summary.

## Contributions

Dual licensing requires the project to retain the rights needed to offer future
commercial licenses. See [CONTRIBUTING.md](CONTRIBUTING.md) before submitting
code. This document is a project policy summary, not a substitute for the
license text or legal advice.
