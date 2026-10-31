import { sql, type Kysely } from "kysely";
export const groupTables = [
  "user_groups",
  "user_group_members",
  "user_group_invitations",
  "user_group_invite_links",
  "resource_group_grants",
  "file_folder_group_grants",
  "group_resource_invitations",
  "group_directory_policies",
] as const;
/** Approved additions; no historical ACLs, invitations or settings are converted. */
export async function createGroupsSchema(db: Kysely<any>) {
  for (const statement of [
    `create table group_directory_policies (id varchar(36) primary key, user_id varchar(36) unique references users(id) on delete cascade, mode varchar(16) check(mode in ('member','related','all') or mode is null), revision integer not null check(revision>0), check((id='system' and user_id is null and mode is not null) or (id=user_id and user_id is not null)))`,
    `create table user_groups (id varchar(36) primary key, owner_id varchar(36) not null references users(id), name varchar(80) not null, avatar text, revision integer not null check(revision>0), dissolved_at varchar(32), cleaned_at varchar(32), created_at varchar(32) not null, updated_at varchar(32) not null)`,
    `create table user_group_members (group_id varchar(36) not null references user_groups(id) on delete cascade, user_id varchar(36) not null references users(id), role varchar(16) not null check(role in ('owner','admin','member')), joined_at varchar(32) not null, primary key(group_id,user_id))`,
    `create index group_members_user on user_group_members(user_id,group_id)`,
    `create unique index group_one_owner on user_group_members(group_id) where role='owner'`,
    `create table user_group_invitations (id varchar(36) primary key, group_id varchar(36) not null references user_groups(id) on delete cascade, user_id varchar(36) not null references users(id), invited_by varchar(36) not null references users(id), state varchar(16) not null check(state in ('pending','accepted','rejected','cancelled')), expires_at varchar(32) not null, created_at varchar(32) not null, updated_at varchar(32) not null)`,
    `create unique index group_pending_invitation on user_group_invitations(group_id,user_id) where state='pending'`,
    `create index group_invitation_user on user_group_invitations(user_id,state)`,
    `create table user_group_invite_links (group_id varchar(36) primary key references user_groups(id) on delete cascade, token_hash varchar(64) not null unique, invited_by varchar(36) not null references users(id), expires_at varchar(32) not null)`,
    `create table resource_group_grants (resource_id varchar(36) not null references resources(id) on delete cascade, group_id varchar(36) not null references user_groups(id) on delete cascade, role varchar(16) not null check(role in ('reader','commenter','editor','manager')), include_descendants integer not null check(include_descendants in (0,1)), status varchar(16) not null check(status in ('active','disabled')), created_by varchar(36) not null references users(id), created_at varchar(32) not null, updated_at varchar(32) not null, primary key(resource_id,group_id))`,
    `create index resource_group_by_group on resource_group_grants(group_id,resource_id)`,
    `create table file_folder_group_grants (folder_id varchar(36) not null references file_folders(id) on delete cascade, group_id varchar(36) not null references user_groups(id) on delete cascade, role varchar(16) not null check(role in ('reader','admin')), created_by varchar(36) not null references users(id), created_at varchar(32) not null, updated_at varchar(32) not null, primary key(folder_id,group_id))`,
    `create index folder_group_by_group on file_folder_group_grants(group_id,folder_id)`,
    `create table group_resource_invitations (id varchar(36) primary key, group_id varchar(36) not null references user_groups(id) on delete cascade, resource_id varchar(36) references resources(id) on delete cascade, folder_id varchar(36) references file_folders(id) on delete cascade, role varchar(16) not null, include_descendants integer not null check(include_descendants in (0,1)), invited_by varchar(36) not null references users(id), state varchar(16) not null check(state in ('pending','accepted','rejected','cancelled')), expires_at varchar(32) not null, created_at varchar(32) not null, updated_at varchar(32) not null, check((resource_id is not null and folder_id is null and role in ('reader','commenter','editor','manager')) or (folder_id is not null and resource_id is null and role in ('reader','admin'))))`,
    `create unique index group_pending_resource on group_resource_invitations(group_id,resource_id) where state='pending' and resource_id is not null`,
    `create unique index group_pending_folder on group_resource_invitations(group_id,folder_id) where state='pending' and folder_id is not null`,
  ])
    await sql.raw(statement).execute(db);
}
