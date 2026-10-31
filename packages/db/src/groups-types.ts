export type GroupRole = "owner" | "admin" | "member";
export type GroupInvitationState =
  "pending" | "accepted" | "rejected" | "cancelled";
export interface GroupTables {
  group_directory_policies: {
    id: string;
    user_id: string | null;
    mode: "member" | "related" | "all" | null;
    revision: number;
  };
  user_groups: {
    id: string;
    owner_id: string;
    name: string;
    avatar: string | null;
    revision: number;
    dissolved_at: string | null;
    cleaned_at: string | null;
    created_at: string;
    updated_at: string;
  };
  user_group_members: {
    group_id: string;
    user_id: string;
    role: GroupRole;
    joined_at: string;
  };
  user_group_invitations: {
    id: string;
    group_id: string;
    user_id: string;
    invited_by: string;
    state: GroupInvitationState;
    expires_at: string;
    created_at: string;
    updated_at: string;
  };
  user_group_invite_links: {
    group_id: string;
    token_hash: string;
    invited_by: string;
    expires_at: string;
  };
  resource_group_grants: {
    resource_id: string;
    group_id: string;
    role: "reader" | "commenter" | "editor" | "manager";
    include_descendants: number;
    status: "active" | "disabled";
    created_by: string;
    created_at: string;
    updated_at: string;
  };
  file_folder_group_grants: {
    folder_id: string;
    group_id: string;
    role: "reader" | "admin";
    created_by: string;
    created_at: string;
    updated_at: string;
  };
  group_resource_invitations: {
    id: string;
    group_id: string;
    resource_id: string | null;
    folder_id: string | null;
    role: "reader" | "commenter" | "editor" | "manager" | "admin";
    include_descendants: number;
    invited_by: string;
    state: GroupInvitationState;
    expires_at: string;
    created_at: string;
    updated_at: string;
  };
}
