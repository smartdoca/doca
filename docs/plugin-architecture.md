# Plugin runtime architecture

Status: active first baseline. Server composition, AI/Search registries,
files/documents/mail capability packages, and Web/Mobile registries are mounted
through the plugin runtime. Existing domain implementations remain behind thin
adapters where that is required to preserve behavior.

## Goals and boundaries

The runtime gives Doca a stable plugin contract for trusted, in-process
TypeScript modules. Its context, service injection, and reversible effects are
implemented on `@deepseek-ai/cordis` 4.0.4, while the public API is owned by
Doca. Plugins import
`@doca/plugin-contracts` or `@doca/plugin-sdk`; Doca contracts do not expose
Cordis classes or types.

The runtime does not sandbox untrusted code, grant permissions merely by
registration, or execute remote plugin code. Administrators install trusted npm
packages in `doca.config.ts`; Server and clients load their declared build-time
entrypoints.

## Packages

- `@doca/plugin-contracts` contains data-only manifest/config contracts,
  lifecycle interfaces, token types, and dependency version checks. It has no
  third-party dependencies.
- `@doca/plugin-sdk` contains `Context`, service/event/contribution token
  factories, contribution storage, scoped plugin contexts, and `definePlugin`.
  It depends exactly on `@deepseek-ai/cordis` 4.0.4.
- `@doca/plugin-host` validates and orders plugins, validates configuration,
  executes lifecycle phases, records migration versions through an adapter, and
  performs rollback/disposal.

The packages are TypeScript ESM workspace packages. Their source currently uses
workspace-relative imports so the repository typecheck and focused tests do not
depend on a lockfile update.

## Manifest and configuration contract

Manifest schema version 1 requires:

- a stable lowercase dotted or dashed `id`;
- a semantic `version` and optional Doca `sdkRange`;
- a non-empty `displayName`;
- optional dependencies with `id`, `range`, and `optional`;
- optional namespaced contribution declarations and target;
- an optional Doca configuration schema whose root is an object.

Dependency ranges deliberately support only `*`, exact semver, caret, and tilde.
Unsupported range syntax is rejected instead of being interpreted loosely.

The configuration schema is a strict Doca subset, not JSON Schema. It supports
string, finite number, integer, boolean, null, array, and object values;
defaults; bounds; string enums/patterns; required object fields; and an explicit
`additionalProperties` switch. Unknown schema keywords and unknown config keys
are rejected. Validation returns a fresh normalized value with defaults
applied, so lifecycle hooks never receive unchecked caller input.

## Dependency graph and lifecycle

Before any plugin code runs, the host:

1. validates every manifest and configuration;
2. rejects duplicate plugin IDs;
3. rejects missing required dependencies;
4. rejects incompatible installed dependency versions;
5. rejects cycles and produces a deterministic dependency-first order.

Startup then runs global phases in this order:

```text
discover(all) -> required injection check -> migrate(all)
              -> mount(all) -> ready(all)
```

Within each phase dependencies run before dependents. `discover` is the place to
publish services and structural contributions, allowing all providers to exist
before required injection checks. `migrate` receives the last successfully
recorded plugin version. The default migration store is in memory; a production
host must supply a durable adapter before relying on migration history.

Before `discover`, `PluginHost` creates and awaits a real Cordis plugin
`Fiber` for that plugin. All Doca providers, listeners, and effects registered
by its hooks therefore belong to the Fiber. Host disposal invokes the Doca
`dispose` hook and then unloads the Fiber.

If a hook fails, startup stops. Every plugin whose discovery began is disposed
in reverse dependency order. Explicit shutdown uses the same order. A plugin's
`dispose` hook runs while its services are still available, followed by disposal
of its context and registered effects. Cleanup continues after individual
failures and reports all failures as an aggregate.

## Context, services, and effects

`defineService<T>(id)` creates a typed service token. Contexts in one host share
one provider registry:

- `provide(token, value)` delegates to Cordis `ctx.provide()` and relies on its
  service registry to reject a second provider;
- `inject(token)` and `injectOptional(token)` read through Cordis `ctx.get()`;
- static plugin `injections.required` are checked after discovery;
- `injections.optional` document optional service use without blocking startup.

`child()` extends the underlying Cordis context while keeping a Doca cleanup
boundary. Child scopes share services and events but own their effects.
Disposing a child does not dispose its parent. Disposing a parent disposes child
scopes as reversible effects.

`effect(setup)` and `effectAsync(setup)` delegate setup and idempotent teardown
to `ctx.fiber.effect()`. Doca sequences their Cordis disposers in strict reverse
registration order when a Doca scope closes. Service providers, event handlers,
contributions, and child contexts use the same Cordis-owned mechanism, so
partial startup cannot leave registrations behind.

## Contributions and dispatch

`defineContributionPoint<T>(id)` declares a typed extension point. A
plugin-scoped contribution registry stores `(point, contribution id)` exactly
once. A collision is rejected with both the key and current owner. The
registration is removed automatically with the owning context.

Typed events map directly to the five Cordis dispatch modes:

- `emit`: run listeners synchronously without awaiting their results;
- `parallel`: run listeners concurrently and await all of them;
- `serial`: await listeners in order until one returns a bail value;
- `bail`: synchronously stop on the first bail value;
- `waterfall`: compose listeners around the required final `next`
  continuation.

An event ID cannot be reused with another mode in the same context tree.

## Example

```ts
import { definePlugin, defineService } from "@doca/plugin-sdk";

const search = defineService<{ query(text: string): Promise<string[]> }>(
  "doca.search",
);

export default definePlugin({
  manifest: {
    schemaVersion: 1,
    id: "doca.example",
    version: "1.0.0",
    displayName: "Example",
  },
  discover(context) {
    context.provide(search, {
      async query(text) {
        return [text];
      },
    });
  },
});
```

## Integration rules

Server composition is owned by `apps/server/src/plugins/composition.ts`.
`create-app.ts` retains HTTP/session/origin security policy and delegates domain
route mounting to plugin adapters. Web and Mobile use typed build-time
registries; app shells retain route precedence, authentication, locale,
accessibility, and layout policy.

AI and Search are host services, not owners of domain behavior. Files,
documents, and mail register their own AI definitions and Search sources into
`doca.ai.contributions` and `search.sources.v1`; the documents plugin also owns
the shared KnowledgeSource registry. Mail attachments use only `files.v1` plus
generic owner bindings, and mail KnowledgeSource records reference stable file
IDs rather than storage addresses.

The Web build contains the configured plugin bundles, while
`/api/v1/bootstrap.plugins` reports the Server instances that actually started.
Navigation, routes, and admin panels are shown only for the intersection.
Deep-links to a built but inactive plugin render an unavailable-module state.

New contribution points should be narrow, typed, and owned by the layer that
consumes them. A route contribution must still pass the existing Fastify
authentication, origin, validation, and error boundaries. UI contributions
must not bypass entitlement, locale, route, or resource-access checks.

See `refactor-capability-parity.md` for behavior gates,
`plugin-development.md` for authoring, and `plugin-deployment.md` for install,
disable, migration, and release operations.
