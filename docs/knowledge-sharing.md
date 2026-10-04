# Q&A assistant sharing and permissions

[中文](knowledge-sharing.zh-CN.md)

Documents and Q&A use the same `PermissionDialog`, `ShareLinkSettings`, member selector, and permission popover behavior. The Q&A component supplies its resource identity, API prefix, and supported permission capabilities. Do not duplicate a similar panel. Documents use `/resources/:id`; Q&A uses `/knowledge/assistants/:id`.

Q&A has independent storage. Existing assistants keep direct members, administrators, and public scope. `knowledge_bot_sharing` stores the master link switch, `knowledge_bot_share_links` stores links, and `knowledge_bot_link_members` stores acceptances. A link grants Q&A reading only; it grants neither management nor access to the original knowledge libraries. Q&A does not provide document editing, comments, or descendant inheritance.

The link switch, member cap, expiry, copying, records, disabling, and revocation use the shared interaction. Disabling or expiry stops new acceptances. Revocation invalidates that link's grants while preserving other direct and link grants. Removing a member clears that member's direct and link grants for this assistant. Public scope is managed separately from the link switch.

Invitation links use `#/s/:token` and the shared sign-in and acceptance flow. The backend looks up an assistant link, then uses the document link handler if it does not match. A response with `kind: assistant` navigates to Q&A. Preview grants nothing; acceptance records the grant. Transactions and link-version checks prevent concurrent acceptances exceeding the member cap.

Permission and member changes use the assistant revision to prevent overwriting another administrator's changes. Link changes use their own version. Retrieval continues checking source-library validity; sharing does not relax that check.
