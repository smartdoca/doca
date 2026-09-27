import { randomUUID } from "node:crypto";
import { createClient, type RedisClientType } from "redis";

export type RealtimeConnection = {
  instanceId: string;
  connectionId: string;
  userId: string;
  name: string;
  color: string;
  room?: string;
  selection: unknown;
  expiresAt: number;
};

export type RealtimeClusterEvent =
  | {
      type: "cluster.resynced";
      originInstanceId: string;
    }
  | {
      type: "document.update";
      originInstanceId: string;
      excludeConnectionId: string;
      room: string;
      message: Record<string, unknown>;
    }
  | {
      type: "document.refresh";
      originInstanceId: string;
      room: string;
    }
  | {
      type: "presence.changed";
      originInstanceId: string;
      rooms: string[];
    }
  | {
      type: "connections.changed";
      originInstanceId: string;
    }
  | {
      type: "notifications.changed";
      originInstanceId: string;
      userIds?: string[];
    }
  | {
      type: "rooms.changed";
      originInstanceId: string;
      rooms: string[];
      userIds: string[];
    }
  | {
      type: "policy.changed";
      originInstanceId: string;
    };

export type LocalRealtimeClusterEvent = RealtimeClusterEvent extends infer Event
  ? Event extends RealtimeClusterEvent
    ? Omit<Event, "originInstanceId">
    : never
  : never;

type Listener = (event: RealtimeClusterEvent) => void | Promise<void>;

export interface RealtimeCluster {
  readonly mode: "local" | "redis";
  readonly instanceId: string;
  isReady(): boolean;
  publish(event: RealtimeClusterEvent): Promise<void>;
  subscribe(listener: Listener): () => void;
  upsert(
    connection: Omit<RealtimeConnection, "instanceId" | "expiresAt">,
  ): Promise<void>;
  remove(connectionId: string): Promise<void>;
  connections(): Promise<RealtimeConnection[]>;
  consumeRateLimit(
    key: string,
    max: number,
    windowMs: number,
  ): Promise<boolean>;
  close(): Promise<void>;
}

export interface RealtimeClusterOptions {
  redisUrl?: string;
  instanceId?: string;
  prefix?: string;
  presenceTtlMs?: number;
  connectTimeoutMs?: number;
}

class LocalRealtimeCluster implements RealtimeCluster {
  readonly mode = "local" as const;
  readonly instanceId: string;
  readonly #ttl: number;
  readonly #listeners = new Set<Listener>();
  readonly #connections = new Map<string, RealtimeConnection>();
  readonly #limits = new Map<string, { count: number; expiresAt: number }>();
  #closed = false;

  constructor(options: RealtimeClusterOptions) {
    this.instanceId = options.instanceId ?? randomUUID();
    this.#ttl = options.presenceTtlMs ?? 75_000;
  }

  isReady() {
    return !this.#closed;
  }

  async publish(event: RealtimeClusterEvent) {
    if (this.#closed) throw new Error("Realtime cluster is closed");
    await Promise.all([...this.#listeners].map((listener) => listener(event)));
  }

  subscribe(listener: Listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async upsert(
    connection: Omit<RealtimeConnection, "instanceId" | "expiresAt">,
  ) {
    this.#connections.set(connection.connectionId, {
      ...connection,
      instanceId: this.instanceId,
      expiresAt: Date.now() + this.#ttl,
    });
  }

  async remove(connectionId: string) {
    this.#connections.delete(connectionId);
  }

  async connections() {
    const now = Date.now();
    for (const [id, connection] of this.#connections)
      if (connection.expiresAt <= now) this.#connections.delete(id);
    return [...this.#connections.values()];
  }

  async consumeRateLimit(key: string, max: number, windowMs: number) {
    const now = Date.now();
    let current = this.#limits.get(key);
    if (!current && this.#limits.size >= 10_000) {
      for (const [id, value] of this.#limits)
        if (value.expiresAt <= now) this.#limits.delete(id);
      if (this.#limits.size >= 10_000) return false;
      current = this.#limits.get(key);
    }
    const value =
      !current || current.expiresAt <= now
        ? { count: 0, expiresAt: now + windowMs }
        : current;
    value.count++;
    this.#limits.set(key, value);
    return value.count <= max;
  }

  async close() {
    this.#closed = true;
    this.#listeners.clear();
    this.#connections.clear();
    this.#limits.clear();
  }
}

class RedisRealtimeCluster implements RealtimeCluster {
  readonly mode = "redis" as const;
  readonly instanceId: string;
  readonly #ttl: number;
  readonly #channel: string;
  readonly #connectionsKey: string;
  readonly #expiryKey: string;
  readonly #ratePrefix: string;
  readonly #publisher: RedisClientType;
  readonly #subscriber: RedisClientType;
  readonly #listeners = new Set<Listener>();
  #closed = false;

  private constructor(
    options: RealtimeClusterOptions,
    publisher: RedisClientType,
    subscriber: RedisClientType,
  ) {
    const prefix = options.prefix?.trim() || "doca";
    this.instanceId = options.instanceId ?? randomUUID();
    this.#ttl = options.presenceTtlMs ?? 75_000;
    this.#channel = `${prefix}:realtime:events`;
    this.#connectionsKey = `${prefix}:realtime:connections`;
    this.#expiryKey = `${prefix}:realtime:connection-expiry`;
    this.#ratePrefix = `${prefix}:rate`;
    this.#publisher = publisher;
    this.#subscriber = subscriber;
  }

  static async create(options: RealtimeClusterOptions) {
    const connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    const publisher = createClient({
      url: options.redisUrl,
      socket: { connectTimeout: Math.min(connectTimeoutMs, 5_000) },
    });
    const subscriber = publisher.duplicate();
    const cluster = new RedisRealtimeCluster(
      options,
      publisher as RedisClientType,
      subscriber as RedisClientType,
    );
    publisher.on("error", () => {});
    subscriber.on("error", () => {});
    let connectedOnce = false;
    subscriber.on("ready", () => {
      if (connectedOnce) {
        const event: RealtimeClusterEvent = {
          type: "cluster.resynced",
          originInstanceId: cluster.instanceId,
        };
        for (const listener of cluster.#listeners)
          void Promise.resolve(listener(event)).catch(() => {});
      }
      connectedOnce = true;
    });
    try {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.all([publisher.connect(), subscriber.connect()]),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Redis startup connection timed out")),
            connectTimeoutMs,
          );
        }),
      ]).finally(() => clearTimeout(timeout));
      await subscriber.subscribe(cluster.#channel, (raw) => {
        try {
          const event = JSON.parse(raw) as RealtimeClusterEvent;
          if (!event || typeof event.type !== "string") return;
          for (const listener of cluster.#listeners)
            void Promise.resolve(listener(event)).catch(() => {});
        } catch {
          // The channel is private deployment infrastructure. Ignore malformed
          // messages rather than letting one publisher stop all subscribers.
        }
      });
      return cluster;
    } catch (error) {
      publisher.destroy();
      subscriber.destroy();
      throw error;
    }
  }

  isReady() {
    return !this.#closed && this.#publisher.isReady && this.#subscriber.isReady;
  }

  async publish(event: RealtimeClusterEvent) {
    if (!this.isReady()) throw new Error("Redis realtime bus is unavailable");
    await this.#publisher.publish(this.#channel, JSON.stringify(event));
  }

  subscribe(listener: Listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async upsert(
    connection: Omit<RealtimeConnection, "instanceId" | "expiresAt">,
  ) {
    if (!this.isReady()) throw new Error("Redis presence is unavailable");
    const value: RealtimeConnection = {
      ...connection,
      instanceId: this.instanceId,
      expiresAt: Date.now() + this.#ttl,
    };
    await this.#publisher
      .multi()
      .hSet(
        this.#connectionsKey,
        connection.connectionId,
        JSON.stringify(value),
      )
      .zAdd(this.#expiryKey, {
        score: value.expiresAt,
        value: connection.connectionId,
      })
      .exec();
  }

  async remove(connectionId: string) {
    if (!this.#publisher.isOpen) return;
    await this.#publisher
      .multi()
      .hDel(this.#connectionsKey, connectionId)
      .zRem(this.#expiryKey, connectionId)
      .exec();
  }

  async connections() {
    if (!this.isReady()) throw new Error("Redis presence is unavailable");
    const expired = await this.#publisher.zRangeByScore(
      this.#expiryKey,
      0,
      Date.now(),
    );
    if (expired.length)
      await this.#publisher
        .multi()
        .hDel(this.#connectionsKey, expired)
        .zRem(this.#expiryKey, expired)
        .exec();
    const values = await this.#publisher.hVals(this.#connectionsKey);
    const now = Date.now();
    return values.flatMap((raw) => {
      try {
        const connection = JSON.parse(raw) as RealtimeConnection;
        return connection.expiresAt > now ? [connection] : [];
      } catch {
        return [];
      }
    });
  }

  async consumeRateLimit(key: string, max: number, windowMs: number) {
    if (!this.isReady()) throw new Error("Redis rate limiter is unavailable");
    const count = await this.#publisher.eval(
      "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('PEXPIRE',KEYS[1],ARGV[1]) end; return n",
      {
        keys: [`${this.#ratePrefix}:${key}`],
        arguments: [String(windowMs)],
      },
    );
    return Number(count) <= max;
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#listeners.clear();
    await Promise.allSettled([
      this.#subscriber.isOpen ? this.#subscriber.quit() : Promise.resolve(),
      this.#publisher.isOpen ? this.#publisher.quit() : Promise.resolve(),
    ]);
  }
}

export async function createRealtimeCluster(
  options: RealtimeClusterOptions = {},
): Promise<RealtimeCluster> {
  return options.redisUrl
    ? RedisRealtimeCluster.create(options)
    : new LocalRealtimeCluster(options);
}
