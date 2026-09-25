import type { DB } from "@db/index.js";

export interface ProvisionedUser {
  readonly id: string;
  readonly displayName?: string;
}

type UserProvisioner = (
  db: DB,
  user: ProvisionedUser,
  client?: unknown,
) => Promise<void>;

const provisionKey = Symbol.for("doca.user-provisioners");

function provisionerList(): UserProvisioner[] {
  const host = globalThis as typeof globalThis & {
    [provisionKey]?: UserProvisioner[];
  };
  return (host[provisionKey] ??= []);
}

export function onUserProvisioned(provisioner: UserProvisioner) {
  const userProvisioners = provisionerList();
  userProvisioners.push(provisioner);
  return () => {
    const index = userProvisioners.indexOf(provisioner);
    if (index >= 0) userProvisioners.splice(index, 1);
  };
}

export async function runUserProvisioners(
  db: DB,
  user: ProvisionedUser,
  client?: unknown,
) {
  for (const provisioner of [...provisionerList()])
    await provisioner(db, user, client);
}
