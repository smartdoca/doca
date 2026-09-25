import type { FastifyInstance } from "fastify";

type Cleanup = () => void | Promise<void>;

/**
 * Route plugins are mounted against the real Fastify instance, but their
 * preClose hooks are captured as plugin effects. This makes worker/timer
 * cleanup reversible without pretending Fastify routes can be hot-unmounted.
 */
export async function mountFastifyAdapter<Result>(
  api: FastifyInstance,
  mount: (scopedApi: FastifyInstance) => Result | Promise<Result>,
): Promise<{ readonly value: Result; readonly dispose: Cleanup }> {
  const cleanups: Cleanup[] = [];
  let disposed = false;
  let facade: FastifyInstance;

  facade = new Proxy(api, {
    get(target, property) {
      if (property === "addHook") {
        return (name: string, ...arguments_: unknown[]) => {
          if (name !== "preClose") {
            return Reflect.apply(
              target.addHook as (...input: unknown[]) => unknown,
              target,
              [name, ...arguments_],
            );
          }
          const hook = arguments_.at(-1);
          if (typeof hook !== "function")
            throw new TypeError("Fastify preClose hook must be a function");
          cleanups.push(
            hook.length
              ? () =>
                  new Promise<void>((resolve, reject) => {
                    Reflect.apply(hook, target, [
                      (error?: Error) => (error ? reject(error) : resolve()),
                    ]);
                  })
              : async () => {
                  await Reflect.apply(hook, target, []);
                },
          );
          return facade;
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    const errors: unknown[] = [];
    for (let index = cleanups.length - 1; index >= 0; index--) {
      try {
        await cleanups[index]!();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length)
      throw new AggregateError(errors, "Fastify plugin cleanup failed");
  };

  try {
    return { value: await mount(facade), dispose };
  } catch (mountError) {
    try {
      await dispose();
    } catch (cleanupError) {
      throw new AggregateError(
        [mountError, cleanupError],
        "Fastify plugin mount and rollback failed",
      );
    }
    throw mountError;
  }
}
