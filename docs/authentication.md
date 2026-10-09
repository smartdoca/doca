# Authentication, registration approval, and account linking

[中文](authentication.zh-CN.md)

This applies to the current Doca, which has no spaces and no organization tree. It covers local accounts, external identity providers, registration approval, and switching sign-in methods.

## Boundary

One Doca user can link several sign-in identities. Documents, permissions, avatars, and preferences always belong to a stable `users.id`. Accounts are not merged by email, display name, or phone. The person signs in to the original account and links the new identity on purpose.

The design separates profile data from login identities and uses explicit linking, not implicit email matching. Creating an account and activating it are separate, so a pending review state is possible. Existing accounts are not migrated to another auth product, and Doca does not depend on an external authentik service.

Admin uses its own full-page shell: its navigation, its scroll area, and a way back to the workspace. Account settings use their own navigation. The visual language stays Doca's.

## Three registration policies

Under Admin, Sign-in and registration, each entry is configured separately:

| Entry | No new users | Automatic registration | Approval required |
| --- | --- | --- | --- |
| Site password | The registration entry is closed | Sign-in follows registration | A pending user is created |
| Enterprise OIDC | Only an already linked identity can sign in | The first sign-in creates a user | The first sign-in creates a pending user |
| Google, GitHub, WeChat, QQ | Only an already linked identity can sign in | The first sign-in creates a user | The first sign-in creates a pending user |

An active user who is already linked is not blocked by "closed registration" and can still link another identity. A user an administrator creates is active immediately. A pending user has no site session and cannot open documents or the WebSocket. An administrator uses the dedicated registration-review page to approve or reject. Ordinary user enable/disable cannot approve a pending account. After approval the person signs in again. An old authorization flow is not activated.

External registration and every identity provider start disabled. The password entry stays available so an identity-provider outage cannot lock the administrator out. Contact verification, phone-code sign-in, and password recovery exist. Code sending and attempt limits use the shared database. Password-login and public-bot IP limits use process-local counters without Redis and shared counters when Redis is configured. SMS has its own admission rule. A third-party source can override the category policy.

When sign-in methods change, the server checks every active user and administrator against enabled methods, verified contacts, password identifiers, and provider credentials. If anyone would have no usable method after the change, the save is rejected. An administrator can first choose a new method under "require users to add a sign-in method". The next time those users open the site they must verify or link it. The old method is closed only after everyone has finished. Adding a method does not force its use by default.

## Identity providers

- **OIDC SSO.** Standard discovery, for example Keycloak or authentik. `openid-client` 6.8.8, authorization code plus PKCE S256, state, nonce, ID token signature checks, and issuer, audience, and lifetime checks. Client authentication is `client_secret_post`. Private-key JWT, mTLS, and SAML are not supported. Plain OAuth 2 is not an OIDC configuration.
- **Google.** Fixed discovery at `https://accounts.google.com`, scope `openid profile`, plus email when the source declares email.
- **GitHub.** Authorization code plus PKCE S256 and `read:user`. The stable numeric id comes from `/user`. When email is declared, `user:email` reads the verified primary email.
- **WeChat.** Website QR `snsapi_login`. Binding uses the OpenID under the app id. UnionID does not merge accounts. This is not an official-account page, a mini program, or a mobile app login.
- **QQ.** Website OAuth. Token and `me` use JSON, then the profile is read. `me.client_id` must match the configuration.

WeChat and QQ adapters are implemented and tested with simulated responses. They are not accepted against the live platforms. Every external provider needs an application and credentials from that platform. WeChat and QQ in this flow do not send PKCE and are not equivalent to OIDC PKCE.

Doca is an SSO client only. Acting as an OIDC provider, SAML, and global SSO logout or revocation sync are not implemented. Disabling an account at the identity provider does not revoke a Doca session that was already issued for 8 hours. A site administrator disables the user, or a later IdP lifecycle event is required.

## Deployment

1. Register the application on each platform. Use the configured HTTP(S) `DOCA_ORIGIN`. The proxy keeps the configured Host.
2. Under Platform settings, Service credentials, SSO, add a credential name and client secret, and set allowed custom SSO origins. The secret is stored in the database, takes effect when saved, and is not echoed.
3. Add an identity provider: display name, issuer for OIDC only, client or app id, and the credential id. Leave it disabled, save, and copy the callback URL.
4. Put that URL on the platform allowlist exactly: `https://doca.example.com/api/v1/auth/providers/<UUID>/callback`. Each provider has its own URL. An arbitrary return URL is not accepted.
5. Configure the registration policy and enable the provider. Link or sign out from the profile page and test sign-in. Keep the original administrator method until that works.

Google, GitHub, WeChat, and QQ fixed HTTPS hosts are allowed by default. Every host in an OIDC issuer and in the authorization, token, and JWKS URLs returned by discovery must be listed under custom SSO allowed origins, one full origin per line. Redirects are forbidden. An explicitly allowlisted self-hosted provider can use HTTP; OIDC also permits HTTP discovery and endpoints in this case. The operator maintains the allowlist together with egress policy. Do not trust mutable untrusted DNS or open arbitrary private addresses.

Type, issuer, and client id are an immutable namespace. A new issuer or application is a new provider. Users link it themselves. Do not point an old id at another provider. Name, credential id, and enabled state use a version optimistic lock and invalidate old authorization flows. Disabling a provider can lock out users who only had that source. Arrange another link first. A new sign-in method is not forced unless an administrator is replacing an old one and sets "require users to add a sign-in method".

## Security flow

1. A same-origin POST starts the flow with a random state, a browser credential, nonce, and PKCE verifier. Linking first completes the separate security check configured by the administrator. That credential is single-use within five minutes.
2. The server stores hashes of state and the browser credential and a ten-minute flow. The flow cookie is HttpOnly and SameSite=Lax. The main cookie stays HttpOnly and SameSite=Strict, and Secure on HTTPS.
3. The callback checks the provider, state, and browser credential, claims the flow once, and validates the identity. Logs do not record callback query parameters, codes, tokens, or provider error bodies.
4. The browser is redirected to `/#/auth/complete`. A same-origin POST finishes and restores the Strict session. Linking must still be the user and session that started it, and the security-check credential must still be valid.
5. A transaction consumes the flow and checks the provider version, unique identity ownership, registration policy, and user status. Pending does not issue a session. Active issues only a Doca session.

Third-party access and refresh tokens are not stored. The subject, the display name at the time, and the link metadata are stored. An HTTP(S) avatar URL declared by the source may be shown. The server does not fetch it blindly. An uploaded avatar still uses site storage.

Unlinking requires a recent verification and cannot remove the last usable method. A disabled provider or one missing credentials does not count as that last method. An account without a password can set a site password after a recent verification. An account that already has a password uses the normal password change. The public user id and the local login are one meaningful unique string. If the source does not provide a suitable id, the user must supply one. A UUID is not generated as the name. The internal user UUID stays stable.

## Database

The current baseline includes these identity structures. It does not create a user or reset a password by itself:

- `settings.registration_review` with the existing registration switch. `sso_registration` and `social_registration` are closed, auto, or approval. They share a revision lock.
- `account_flows` stores a one-time security-check credential. The session is not that proof.
- `auth_providers` stores configuration, the immutable namespace, and version. It does not store secrets. `type` plus issuer plus client id is unique.
- `auth_identities` maps `user_id` to `provider_id` plus `subject`. That pair is unique. `user_id` plus `provider_id` allows one identity per user per provider.
- `auth_flows` is a ten-minute single-use flow. `stage` is started, exchanging, or verified. Completion deletes it. Expiry is cleaned when a new flow starts.

## HTTP

The prefix is `/api/v1`. Writes must match Origin.

| Route | Who | Behavior |
| --- | --- | --- |
| GET /auth/providers | Public | Enabled providers that have credentials: id, name, type |
| GET /admin/auth | Administrator | The three policies, revision, providers, readiness, callback URLs. No secrets |
| GET/PUT /admin/accounts/policy | Administrator | Password, phone and email sign-in, password account type, and `forcedLoginMethod`. Saving checks that every active user keeps one usable method |
| PUT /admin/auth/policy | Administrator | `{revision,local,sso,social}` with closed, auto, or approval |
| POST /admin/auth/providers | Administrator | `{type,name,issuer,client_id,credential_ref,enabled,version:0}` |
| PUT /admin/auth/providers/:id | Administrator | Same fields, current version. Immutable fields cannot change |
| POST /auth/providers/:id/start | `{intent:"login"\|"link"\|"security"\|"replace"}` | Returns `{url}` and the flow cookie. link needs a recent verification |
| GET /auth/providers/:id/callback | The provider | Exchanges and checks the identity, then redirects on this origin |
| POST /auth/complete | Consumes the verified flow | status active, linked, or pending. active issues a session |
| GET /me/identities | Signed in | Local login, whether a password exists, links and whether they are usable. No subject or token |
| POST /auth/reauth | Signed in | `{password}` updates the recent-verification time of this session |
| POST /auth/password/setup | Recent verification | `{password}` of 12–128 characters, first setup only, revokes other sessions |
| DELETE /me/identities/:id | Recent verification | Unlink. The last usable method is protected |
| GET /admin/users?status=pending | Administrator | Filter and page active, pending, or disabled |
| GET /admin/registration-reviews | Administrator | Paginated pending/approved/rejected reviews |
| POST /admin/registration-reviews/:id | Administrator | `{decision:"approved"\|"rejected",message?}` |
| PATCH /admin/users/:id | Administrator | Ordinary active/disabled users only; pending returns 409 |

`POST /auth/register` adds `status`. Pending tells the person to wait and does not sign them in.

## Tests

`tests/identity.test.ts` uses RSA-signed simulated OIDC responses through the real `openid-client` path. It covers PKCE, signatures, nonce, issuer, cookies, repeated and expired callbacks, session binding, policy, approval, and unlinking. Social adapters use simulated HTTP. That is not vendor review or a public-network test.

SQLite and an isolated PostgreSQL database both run the full regression against the current schema. A real identity provider, an HTTPS proxy, and account recovery need their own acceptance.

## September 2026 module split

Identity lives in `packages/core/src/modules/identity`. Protocol adapters live in `apps/server/src/adapters/identity-providers.ts`. A custom OAuth 2 authorization-code and PKCE adapter can configure endpoints and a stable identity field, still under the HTTP(S) origin allowlist. It is separate from OIDC. An ordinary OAuth token is not treated as an ID token.

Each source's `profile_config` declares registration fields, their source, and whether they can be edited or synced. If the profile is incomplete, `/auth/complete` returns `needs_profile` and does not create a full session. Registration or approval continues after the required profile and contact-verification credential are submitted. Username uniqueness and the provider-plus-subject binding are independent. A duplicate name does not merge accounts. A custom protocol configuration cannot be pointed at another identity namespace after it is created.
