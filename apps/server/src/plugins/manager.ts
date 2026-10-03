import type { CredentialCipher } from "../services/credential-cipher.js";
import {
  createHostFileStore,
  type HostFileStore,
} from "../services/host-file-store.js";
import { storageRuntime } from "../adapters/storage.js";
import { hostPluginReleaseKey } from "../services/plugin-storage-namespaces.js";
import {
  installPluginStorage,
  bindPluginStorage,
  removePluginStorage,
  cleanupPluginObjects,
} from "../services/plugin-storage.js";
import { isDeepStrictEqual } from "node:util";
import { mkdir, rename, readdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { runPluginUninstall, validatePluginGraph } from "@doca/plugin-host";
import {
  comparePluginVersions,
  validatePluginManifest,
  type PluginManifest,
} from "@smartdoca/plugin-sdk";
import type { DB } from "@db/index.js";
import type {
  PluginInventory,
  StoreRelease,
} from "@core/shared/plugin-store.js";
import { inspectPlugin, instantiateInstalledPlugin } from "./installation.js";
import { PluginStore } from "./store.js";
import {
  digest,
  materialize,
  pack,
  unpack,
  archiveFileIndex,
  cachedRelease,
} from "./archive.js";

const entrySchema = z
  .object({
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    enabled: z.boolean(),
    source: z.enum(["local", "store", "npm"]),
    npm: z
      .object({
        registry: z.string(),
        name: z.string(),
        version: z.string(),
        integrity: z.string(),
        size: z.number(),
      })
      .optional(),
    dataVersion: z.string(),
    manifest: z.unknown().transform(validatePluginManifest),
  })
  .strict();
type Entry = z.infer<typeof entrySchema>;
const stateSchema = z
  .object({
    version: z.literal(2),
    desired: z.record(z.string(), entrySchema),
    dataVersions: z.record(z.string(), z.string()),
  })
  .strict();
type State = z.infer<typeof stateSchema>;
const empty = (): State => ({ version: 2, desired: {}, dataVersions: {} });
const equal = isDeepStrictEqual;
export class PluginManager {
  private materializations = new Map<
    string,
    Promise<Awaited<ReturnType<typeof inspectPlugin>>>
  >();
  private running: Record<string, Entry> = {};
  private selected: Record<string, Entry> = {};
  private selectedGenerations: Record<string, number> = {};
  private runningGenerations: Record<string, number> = {};
  constructor(
    readonly directory: string,
    readonly core: readonly PluginManifest[],
    private readonly db: DB,
    readonly store = new PluginStore(),
    readonly archiveStore: HostFileStore = createHostFileStore(
      storageRuntime(),
    ),
    readonly credentialCipher?: CredentialCipher,
  ) {
    this.directory = path.resolve(directory);
  }
  private async read() {
    const row = await this.db
      .selectFrom("plugin_registry")
      .selectAll()
      .where("id", "=", "plugins")
      .executeTakeFirst();
    return {
      revision: row?.revision ?? 0,
      state: row ? stateSchema.parse(JSON.parse(row.state)) : empty(),
    };
  }
  private async generations(entries: Record<string, Entry>) {
    const namespaces = await this.db
      .selectFrom("plugin_storage_namespaces")
      .selectAll()
      .execute();
    const result: Record<string, number> = {};
    for (const [id, entry] of Object.entries(entries)) {
      const namespace = namespaces.find((row) => row.plugin_id === id);
      if (
        !namespace ||
        namespace.state !== "active" ||
        namespace.namespace !== `plugin:${id}` ||
        namespace.data_version !== entry.dataVersion
      )
        throw new Error(
          "Plugin storage differs from installation; refresh and retry",
        );
      result[id] = namespace.generation;
    }
    return result;
  }
  private async save(
    state: State,
    revision: number,
    archive?: {
      hash: string;
      storeId: string;
      key: string;
      size: number;
      id: string;
      version: string;
      dataVersion: string;
      fileIndex: string;
    },
    removeId?: string,
  ) {
    // CAS and archive commit together; concurrent administrators cannot lose updates.
    await this.db.transaction().execute(async (tx) => {
      if (archive) {
        await installPluginStorage(tx, archive.id, archive.dataVersion);
        await tx
          .insertInto("plugin_archives")
          .values({
            sha256: archive.hash,
            plugin_id: archive.id,
            version: archive.version,
            store_id: archive.storeId,
            object_key: archive.key,
            size: archive.size,
            file_index: archive.fileIndex,
            created_at: new Date().toISOString(),
          })
          .onConflict((c) => c.column("sha256").doNothing())
          .execute();
      }
      if (removeId) await removePluginStorage(tx, removeId);
      if (!revision) {
        const result = await tx
          .insertInto("plugin_registry")
          .values({ id: "plugins", revision: 1, state: JSON.stringify(state) })
          .onConflict((c) => c.column("id").doNothing())
          .executeTakeFirst();
        if (!Number(result.numInsertedOrUpdatedRows))
          throw new Error("Plugin registry changed; refresh and retry");
      } else {
        const result = await tx
          .updateTable("plugin_registry")
          .set({ state: JSON.stringify(state), revision: revision + 1 })
          .where("id", "=", "plugins")
          .where("revision", "=", revision)
          .executeTakeFirst();
        if (!Number(result.numUpdatedRows))
          throw new Error("Plugin registry changed; refresh and retry");
      }
    });
  }
  private validate(state: State) {
    const all = Object.values(state.desired);
    for (const [id, entry] of Object.entries(state.desired)) {
      if (entry.manifest.id !== id) throw new Error("Plugin identity mismatch");
      if (
        state.dataVersions[id] &&
        state.dataVersions[id] !== entry.dataVersion
      )
        throw new Error(
          `Incompatible data structure for ${id}: package ${entry.manifest.version} declares ${entry.dataVersion}, but the installed structure is ${state.dataVersions[id]}. An upgrade must keep the same structure; uninstall clears it.`,
        );
    }
    validatePluginGraph([...this.core, ...all.map((p) => p.manifest)]);
    validatePluginGraph([
      ...this.core,
      ...all.filter((p) => p.enabled).map((p) => p.manifest),
    ]);
  }
  private materialize(hash: string, bytes: Uint8Array) {
    const existing = this.materializations.get(hash);
    if (existing) return existing;
    const pending = materialize(this.directory, hash, bytes)
      .then(inspectPlugin)
      .catch((error) => {
        this.materializations.delete(hash);
        throw error;
      });
    this.materializations.set(hash, pending);
    return pending;
  }
  private async ensure(entry: Entry) {
    const archive = await this.db
      .selectFrom("plugin_archives")
      .selectAll()
      .where("sha256", "=", entry.sha256)
      .executeTakeFirstOrThrow();
    if (archive.object_key !== hostPluginReleaseKey(archive.sha256))
      throw new Error("Invalid plugin archive reference");
    const cached = await cachedRelease(
      this.directory,
      entry.sha256,
      archive.file_index,
    );
    const descriptor = cached
      ? await inspectPlugin(cached)
      : await this.materialize(
          entry.sha256,
          await this.archiveStore.read(
            archive.store_id,
            archive.object_key,
            archive.size,
            archive.sha256,
          ),
        );
    if (
      !equal(descriptor.manifest, entry.manifest) ||
      descriptor.dataVersion !== entry.dataVersion
    )
      throw new Error("Plugin registry metadata differs from archive");
    return descriptor;
  }
  /** Global registry is authoritative; folders dropped locally are published before discovery. */
  async prepare(disabled: Readonly<Record<string, boolean | undefined>> = {}) {
    const folders = await readdir(this.directory, {
      withFileTypes: true,
    }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const incoming = new Map<
      string,
      { root: string; plugin: Awaited<ReturnType<typeof inspectPlugin>> }
    >();
    for (const folder of folders) {
      if (folder.name.startsWith(".")) continue;
      if (folder.isSymbolicLink())
        throw new Error("Plugin directory must not be a symbolic link");
      if (!folder.isDirectory()) continue;
      const root = path.join(this.directory, folder.name);
      const plugin = await inspectPlugin(root);
      if (folder.name !== plugin.manifest.id)
        throw new Error("Plugin directory must equal manifest id");
      incoming.set(plugin.manifest.id, { root, plugin });
    }
    const initial = (await this.read()).state;
    const ordered = validatePluginGraph([
      ...this.core,
      ...Object.values(initial.desired)
        .filter((p) => !incoming.has(p.manifest.id))
        .map((p) => p.manifest),
      ...[...incoming.values()].map((p) => p.plugin.manifest),
    ]);
    for (const manifest of ordered) {
      const local = incoming.get(manifest.id);
      if (!local) continue;
      const { root, plugin } = local;
      const bytes = await pack(root);
      const current = (await this.read()).state.desired[plugin.manifest.id];
      if (!current || current.sha256 !== digest(bytes))
        await this.install(bytes, "local");
      const imported = path.join(this.directory, ".imports", randomUUID());
      await mkdir(path.dirname(imported), { recursive: true });
      await rename(root, imported);
    }
    const { state } = await this.read();
    this.validate(state);
    this.selected = structuredClone(state.desired);
    this.selectedGenerations = await this.generations(this.selected);
    const descriptors = [];
    for (const [id, entry] of Object.entries(state.desired)) {
      if (disabled[id] === false) {
        this.selected[id] = { ...entry, enabled: false };
      }
      // Disabled packages are synchronized too, so a future enable needs no registry fetch.
      const descriptor = await this.ensure(entry);
      if (this.selected[id]!.enabled) descriptors.push(descriptor);
    }
    validatePluginGraph([...this.core, ...descriptors.map((p) => p.manifest)]);
    return descriptors;
  }
  async confirm() {
    this.running = structuredClone(this.selected);
    this.runningGenerations = { ...this.selectedGenerations };
  }
  async inventory(): Promise<PluginInventory> {
    const { state } = await this.read();
    const generations = await this.generations(state.desired);
    const plugins = [];
    for (const id of new Set([
      ...Object.keys(this.running),
      ...Object.keys(state.desired),
    ])) {
      const target = state.desired[id];
      const entry = target ?? this.running[id]!;
      plugins.push({
        id,
        name: entry.manifest.displayName,
        description: entry.manifest.description ?? "",
        version: entry.manifest.version,
        dataVersion: entry.dataVersion,
        source: entry.source,
        npm: entry.npm,
        enabled: target?.enabled ?? false,
        runningVersion: this.running[id]?.enabled
          ? this.running[id]!.manifest.version
          : null,
        pending:
          !equal(target, this.running[id]) ||
          generations[id] !== this.runningGenerations[id],
        canCancel:
          !!target &&
          !!this.running[id] &&
          generations[id] === this.runningGenerations[id] &&
          !equal(target, this.running[id]),
        removing: !target,
      });
    }
    return {
      plugins,
      restartRequired: plugins.some((plugin) => plugin.pending),
      storeUrl: this.store.origin,
    };
  }
  async install(
    bytes: Uint8Array,
    source: "local" | "store" | "npm",
    expected?: { id: string; release: StoreRelease },
    npm?: import("@core/shared/plugin-store.js").NpmRelease,
  ) {
    unpack(bytes);
    const hash = digest(bytes);
    const { state, revision } = await this.read();
    // A matching hash is immutable. Never repair a currently running release during a request.
    if (Object.values(this.running).some((p) => p.sha256 === hash))
      throw new Error("Plugin release already running");
    const plugin = await this.materialize(hash, bytes);
    const id = plugin.manifest.id;
    if (
      expected &&
      (id !== expected.id ||
        plugin.manifest.version !== expected.release.version ||
        plugin.packageName !== expected.release.npm.name ||
        !!plugin.web !== expected.release.targets.includes("web") ||
        plugin.navigation.some((e) => e.mobile) !==
          expected.release.targets.includes("mobile") ||
        plugin.mobileHostRange !== expected.release.mobileHostRange ||
        plugin.dataVersion !== expected.release.dataVersion ||
        plugin.manifest.sdkRange !== expected.release.sdkRange ||
        !equal(
          plugin.manifest.dependencies ?? [],
          expected.release.dependencies ?? [],
        ))
    )
      throw new Error("Store metadata differs from package");
    const published = await this.db
      .selectFrom("plugin_archives")
      .select("sha256")
      .where("plugin_id", "=", id)
      .where("version", "=", plugin.manifest.version)
      .executeTakeFirst();
    if (published && published.sha256 !== hash)
      throw new Error("A published plugin version is immutable");
    const old = state.desired[id];
    if (
      old &&
      comparePluginVersions(plugin.manifest.version, old.manifest.version) <= 0
    )
      throw new Error("Plugin version must increase");
    if (!old) delete state.dataVersions[id];
    state.desired[id] = {
      sha256: hash,
      enabled: old?.enabled ?? true,
      source,
      npm: expected?.release.npm ?? npm,
      dataVersion: plugin.dataVersion,
      manifest: plugin.manifest,
    };
    this.validate(state);
    state.dataVersions[id] = plugin.dataVersion;
    const archived = await this.archiveStore.putImmutable(
      hostPluginReleaseKey(hash),
      bytes,
      "application/zip",
    );
    await this.save(state, revision, {
      hash,
      storeId: archived.storeId,
      key: archived.key,
      size: archived.size,
      dataVersion: plugin.dataVersion,
      fileIndex: archiveFileIndex(bytes),
      id,
      version: plugin.manifest.version,
    });
    return this.inventory();
  }
  async assetPlugin(id: string, version: string) {
    const { state } = await this.read();
    if (!Object.hasOwn(state.desired, id) && !Object.hasOwn(this.running, id))
      return undefined;
    const archive = await this.db
      .selectFrom("plugin_archives")
      .selectAll()
      .where("plugin_id", "=", id)
      .where("version", "=", version)
      .executeTakeFirst();
    if (!archive) return undefined;
    if (archive.object_key !== hostPluginReleaseKey(archive.sha256))
      throw new Error("Invalid plugin archive reference");
    const cached = await cachedRelease(
      this.directory,
      archive.sha256,
      archive.file_index,
    );
    return cached
      ? inspectPlugin(cached)
      : this.materialize(
          archive.sha256,
          await this.archiveStore.read(
            archive.store_id,
            archive.object_key,
            archive.size,
            archive.sha256,
          ),
        );
  }
  async change(id: string, action: "enable" | "disable" | "remove" | "cancel") {
    const { state, revision } = await this.read();
    if (!Object.hasOwn(state.desired, id) && !Object.hasOwn(this.running, id))
      throw new Error("Plugin not found");
    if (action === "cancel") {
      const running = this.running[id];
      if (!running || !state.desired[id])
        throw new Error(
          "Installation or uninstall cannot be cancelled; uninstall or restart instead",
        );
      const generations = await this.generations(state.desired);
      if (generations[id] !== this.runningGenerations[id])
        throw new Error(
          "Plugin installation changed; restart instead of cancelling",
        );
      state.desired[id] = structuredClone(running);
      state.dataVersions[id] = running.dataVersion;
    } else if (action === "remove") {
      const entry = state.desired[id] ?? this.running[id];
      if (!entry) throw new Error("Plugin not found");
      const installed = await instantiateInstalledPlugin(
        await this.ensure(entry),
        await bindPluginStorage(
          this.db,
          this.archiveStore,
          id,
          entry.dataVersion,
          this.credentialCipher,
        ),
      );
      await runPluginUninstall(installed);
      delete state.desired[id];
      delete state.dataVersions[id];
    } else {
      if (!state.desired[id]) throw new Error("Plugin pending removal");
      state.desired[id]!.enabled = action === "enable";
    }
    this.validate(state);
    await this.save(
      state,
      revision,
      undefined,
      action === "remove" ? id : undefined,
    );
    if (action === "remove")
      await cleanupPluginObjects(this.db, this.archiveStore);
    return this.inventory();
  }
}
