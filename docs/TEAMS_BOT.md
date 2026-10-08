# Microsoft Teams Bot

The Teams bot (`packages/teams-bot`) lets a Microsoft Teams channel start and follow Open-Inspect
coding sessions, the way the [Slack bot](integrations/SLACK.md) does for Slack. It is a Node service
(Hono, `node:sqlite`) that runs next to the control plane, not a Cloudflare Worker: it needs a
public path for the Bot Framework and outbound internet, and it keeps a little state of its own.

This document covers what the bot does, how to register it with Azure and Teams, how to deploy it
with the Kubernetes manifests in [`deploy/kubernetes`](../deploy/kubernetes), and what to check when
something does not work. The control-plane side (the `msteams` binding provider, the `microsoft`
actor namespace and the `teams-bot` service principal) is described in
[AUTH.md](AUTH.md#microsoft-teams-bindings-and-actors).

## What it does

| In Teams                                                                                     | What happens                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@Software Factory acme/web add a README badge` or `@Software Factory repo:acme/web add ...` | Starts a session for the team the channel is bound to, on that repository, and replies in a new thread with "Working...".                                                                               |
| `@Software Factory add a README badge` (no repository)                                       | Same, when the bound team holds exactly one repository grant; otherwise the bot asks for the repository.                                                                                                |
| A reply inside a thread that has a session                                                   | Delivered to that session as a follow-up prompt. No new session.                                                                                                                                        |
| `status` inside a thread                                                                     | The session's state (working, idle or closed), repository, model, start time and web link.                                                                                                              |
| `stop` inside a thread                                                                       | Stops the running turn; the bot confirms in the thread.                                                                                                                                                 |
| `help`, or anything the bot cannot parse                                                     | Usage text. No control-plane call.                                                                                                                                                                      |
| Model and reasoning flags (`!model ...`, `!reasoning ...`) at the start of a request         | Same semantics as in Slack: on a request that starts a session they become the session's defaults, on a follow-up they apply to that request.                                                           |
| The agent works                                                                              | The "Working..." reply is edited in place with throttled progress and tool-call summaries.                                                                                                              |
| The turn completes                                                                           | The final assistant text, the pull request link when there is one, and a link to the web session are posted in the thread. Exactly one final message, even when the control plane retries the callback. |
| The session's thread is closed                                                               | A short note in the thread.                                                                                                                                                                             |

Teams has no server-side slash commands, so the `commandLists` in the app manifest are display hints
only; the bot parses the text after the @mention. Repository resolution is deterministic (the Slack
bot's LLM classifier is not used), and images attached to a Teams message are ignored in this
version.

### Who may use it

- **The channel must be bound to a team.** In the web app, open the team, **Channels**, provider
  **Microsoft Teams**, and paste the channel id from the channel's link (the `19:...@thread.tacv2`
  part). Threads inherit their channel's binding. A message in a channel no team has bound gets
  "This channel is not bound to a team..." and no control-plane call is made; the unbound-channel
  policy for Teams is fixed to `reject`.
- **The user must have signed in once on the web with their Microsoft account.** The bot asserts the
  sender as `microsoft:<aadObjectId>`; the control plane resolves that only against identities the
  [Microsoft Entra ID sign-in](AUTH.md#microsoft-entra-id) created and never enrolls a user from the
  bot. An unknown sender gets "Sign in once at `<WEB_APP_URL>` with your M365 account, then try
  again." and no user row is written; the denial is audited as `authorization.request_denied` with
  code `service_actor_not_enrolled`.
- **Team membership, grants and quotas apply as on the web.** A sender who is not a member of the
  bound team is refused, a repository the team holds no grant for is refused, and a usage quota that
  is exhausted (`429 USAGE_QUOTA_EXCEEDED`) is refused; in each case the bot renders the control
  plane's message in the thread. The bot's own permission ceiling is the Linear bot's (sessions,
  repositories, environments and skills; no sandbox access).
- **Only the configured tenant.** Activities whose tenant is not `TEAMS_BOT_TENANT_ID` are dropped
  before anything else is looked at.

## Environment variables

| Variable                              | Required | Meaning                                                                                                                                                                                                                                                |
| ------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TEAMS_BOT_APP_ID`                    | yes      | The bot's Microsoft Entra application (client) id; also the audience of inbound tokens and the `botId` in the Teams app manifest.                                                                                                                      |
| `TEAMS_BOT_APP_SECRET`                | yes      | A client secret of that app registration, used to obtain connector tokens for replies.                                                                                                                                                                 |
| `TEAMS_BOT_TENANT_ID`                 | yes      | The single tenant the bot serves. Activities from any other tenant are dropped; the token endpoint is this tenant's.                                                                                                                                   |
| `TEAMS_BOT_PORT`                      | no       | Listen port, default `3100`.                                                                                                                                                                                                                           |
| `CONTROL_PLANE_URL`                   | yes      | The control plane's base URL, in-cluster (`http://open-inspect-control-plane:8787`, or a pinned ClusterIP).                                                                                                                                            |
| `SERVICE_AUTH_SECRET_TEAMS_BOT`       | yes      | The `teams-bot` service secret. The bot signs its control-plane requests with it (`sig1`), and the control plane signs callbacks to the bot with the same key; it must equal the control plane's `SERVICE_AUTH_SECRET_TEAMS_BOT`.                      |
| `WEB_APP_URL`                         | yes      | The web app's public base URL, for session links and the sign-in hint.                                                                                                                                                                                 |
| `TEAMS_BOT_STATE_DIR`                 | no       | Directory for the SQLite file (thread-to-session map, conversation references, callback dedupe). Default `/state` in the container; mount a persistent volume there.                                                                                   |
| `TEAMS_BOT_ALLOWED_SERVICE_URL_HOSTS` | no       | Comma-separated host patterns an activity's `serviceUrl` must match before the bot makes any outbound call to it. Default `*.botframework.com,smba.trafficmanager.net`. A forged activity naming another host is rejected and logged, never contacted. |

The control plane needs two settings for the bot (see `.env.example`):
`SERVICE_AUTH_SECRET_TEAMS_BOT` with the same value, and `TEAMS_BOT_URL`
(`http://open-inspect-teams-bot:3100` in the Kubernetes manifests) so the Node host can deliver
callbacks. Without `TEAMS_BOT_URL` the control plane skips Teams callbacks rather than failing them,
and the thread never gets its final message.

## Azure and Teams registration

The bot needs one Microsoft Entra app registration (single tenant, a client secret, no Graph
permissions) and one Azure Bot resource bound to it with the Teams channel enabled. These steps
assume you **reuse an existing Azure Bot** and its app registration; creating a new one differs only
in the first step (`az bot create --app-type SingleTenant ...`, or the Azure portal's "Azure Bot"
resource). Replace the placeholders with your values; nothing below prints a secret.

1. **Confirm the bot and its app registration.** The bot must be `SingleTenant`, and the app
   registration's sign-in audience `AzureADMyOrg`:

   ```bash
   az bot show -g <RESOURCE_GROUP> -n <BOT_NAME> \
     --query '{endpoint:properties.endpoint,msaAppId:properties.msaAppId,tenant:properties.msaAppTenantId,type:properties.msaAppType,channels:properties.enabledChannels}' -o json
   az ad app show --id <APP_ID> --query '{name:displayName,audience:signInAudience}' -o json
   ```

2. **Set the messaging endpoint** to the public URL of the bot's `/api/messages` route. It must be
   `https://`:

   ```bash
   az bot update -g <RESOURCE_GROUP> -n <BOT_NAME> --endpoint https://<PUBLIC_HOST>/api/messages
   ```

   (`az resource update --ids $(az bot show -g <RESOURCE_GROUP> -n <BOT_NAME> --query id -o tsv) --set properties.endpoint=https://<PUBLIC_HOST>/api/messages`
   does the same through the generic resource API.)

3. **Keep the Teams channel enabled.** `enabledChannels` from step 1 must list `msteams`; if it does
   not, `az bot msteams create -g <RESOURCE_GROUP> -n <BOT_NAME>` enables it. The other channels
   (`webchat`, `directline`) are harmless; the bot answers only Teams activities.

4. **Mint a client secret on the app registration** and deliver it straight into the deployment's
   Secret, never through a terminal or a chat:

   ```bash
   az ad app credential reset --id <APP_ID> --display-name "open-inspect-teams-bot $(date +%F)" \
     --years 1 --append --query password -o tsv
   ```

   `--append` keeps the existing credentials, so a bot that still uses the old secret keeps working
   until you remove it (`az ad app credential list --id <APP_ID>` shows them with their expiry;
   `az ad app credential delete --id <APP_ID> --key-id <KEY_ID>` removes one). The script in the
   private deployment notes pipes the output of this command into `kubectl` without printing it.

5. **No admin consent.** The bot requests no Graph scopes: identity comes from the activity's
   `aadObjectId`, replies go through the Bot Framework connector. Adding attachments later would
   change this.

### Teams app manifest

[`packages/teams-bot/manifest/teams-app/manifest.json`](../packages/teams-bot/manifest/teams-app/manifest.json)
is a schema 1.17 manifest with the two placeholder icons next to it. Things to know when you adapt
it:

- `id` is the Teams app's own GUID, distinct from the bot id. To **update** an app that is already
  in your org catalog, keep its `id` and raise `version`; a different `id` is a new app.
- `bots[0].botId` is the Azure Bot's `msaAppId` (= `TEAMS_BOT_APP_ID`).
- `scopes` `team`, `groupChat` and `personal` let the bot be added to teams, group chats and 1:1
  chats; sessions need a bound channel, so the latter two are useful for `help` and `status` only
  until group and personal chats are supported.
- `commandLists` are display hints that appear when a user types `@` the bot. Keep them in step with
  what the bot parses (`start`, `status`, `stop`, `help`).
- `validDomains` must list the host of every link the bot posts (the web app's host). Teams refuses
  to render links to hosts outside it in some surfaces.
- `developer.websiteUrl`, `privacyUrl` and `termsOfUseUrl` must be `https://` URLs; the catalog
  upload validates the format, not the content.
- There is no `webApplicationInfo`: the bot does not use Teams SSO.

Zip the three files (`manifest.json`, `color.png`, `outline.png`, at the root of the archive, no
folder) and upload the zip in the Teams admin center (**Teams apps > Manage apps > Upload new
app**), or let a pilot group side-load it ("Upload a custom app" in a setup policy). Then assign the
app to users with an app permission policy, and add it to the pilot team.

## Deployment

The manifests in
[`deploy/kubernetes/control-plane/teams-bot.yaml`](../deploy/kubernetes/control-plane/teams-bot.yaml)
add to the control plane's namespace:

- a **Deployment** `open-inspect-teams-bot`, one replica, `Recreate` (the SQLite state is
  single-writer), running as uid 1000 with a read-only root filesystem, readiness and liveness
  probes on `GET /healthz`, configured by `envFrom` the Secret `open-inspect-teams-bot-env`;
- a **PersistentVolumeClaim** `open-inspect-teams-bot-state` (1 Gi, `ReadWriteOnce`) mounted at
  `/state`;
- a **Service** `open-inspect-teams-bot` (ClusterIP, port 3100), which the control plane reaches as
  `TEAMS_BOT_URL` and your ingress forwards `/api/messages` to;
- a **NetworkPolicy** `teams-bot`: ingress on 3100 from the control plane's pods; egress to DNS, to
  the control plane's pods on 8787, and to TCP 443 on public addresses (private ranges excluded) for
  `login.microsoftonline.com`, `*.botframework.com` and the Teams service URL. Traffic from the node
  itself (an ingress controller or Funnel proxy in host networking) is not filtered by most CNIs;
  where yours does, add an `ipBlock` for the node's addresses in an overlay.

The image is built from `packages/teams-bot/Dockerfile` (repository root as the context, like the
control plane's) and is named `open-inspect-teams-bot:local` in the manifest; rewrite it with a
kustomize `images:` entry.

Create the Secret out of band, then apply. The keys are the variables above; `TEAMS_BOT_PORT` and
`TEAMS_BOT_STATE_DIR` are set by the Deployment itself.

```bash
kubectl -n open-inspect create secret generic open-inspect-teams-bot-env \
  --from-env-file=<path to a chmod-600 file with KEY=value lines, outside any repository> \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -k deploy/kubernetes/control-plane
kubectl -n open-inspect rollout status deploy/open-inspect-teams-bot
```

Add `SERVICE_AUTH_SECRET_TEAMS_BOT` (same value) and
`TEAMS_BOT_URL=http://open-inspect-teams-bot:3100` to `open-inspect-control-plane-env` and restart
the control plane; `envFrom` is read at pod start.

### Exposing `/api/messages`

Only `POST /api/messages` may be public. `/callbacks/*` and `/healthz` must stay cluster-internal:
the callbacks are HMAC-verified, but there is no reason to let the internet try, and the health
route says nothing the Bot Framework needs. With Tailscale Funnel on the node, mapping one path on a
dedicated HTTPS port does exactly that (every path mapped on a funneled port is public; unmapped
paths get a 404 from tailscaled):

```bash
tailscale funnel --bg --https=8443 --set-path=/api/messages http://<SERVICE_CLUSTER_IP>:3100/api/messages
```

`tailscale funnel status` must then show `:8443` with only that path. The messaging endpoint in
Azure is `https://<tailnet-host>:8443/api/messages`. An ingress controller does the same with a
single-path rule; terminate TLS there, the bot speaks plain HTTP.

### Binding a channel

1. In Teams, open the channel, **Get link to channel**, and copy the `19:...@thread.tacv2` segment
   (URL-decode `%3a` to `:` and `%40` to `@` if the link is encoded).
2. In the web app, open the team, **Channels**, choose **Microsoft Teams**, paste the id, bind. Mark
   it **Primary** if the team has no primary Teams channel yet; `source` bindings are fine for
   additional channels.
3. Add the Teams app to the team (**Apps** in the team's menu), so that `@Software Factory`
   resolves.

The binding is read on every message (`GET /channel-bindings/msteams/:channelId`), so changes apply
immediately.

### The sign-in-once rule

The bot never creates users. Each pilot user signs in to the web app once with their Microsoft
account; that stores the Entra object id as their identity subject, and the bot's
`microsoft:<aadObjectId>` assertion resolves to that user from then on. A user who has a GitHub
sign-in but has never used the Microsoft one gets the sign-in hint until they do (the Microsoft
sign-in links to the existing user when the verified email matches, see
[AUTH.md](AUTH.md#microsoft-entra-id)).

## How the pieces authenticate

- **Bot Framework to bot.** Every activity carries `Authorization: Bearer <JWT>`. The bot validates
  the signature against the JWKS from the Bot Framework OpenID metadata, the issuer
  (`https://api.botframework.com`, or the tenant's `https://login.microsoftonline.com/<tenant>/v2.0`
  for emulator-style tokens), the audience (`TEAMS_BOT_APP_ID`) and the lifetime, and answers 401
  otherwise, without calling the control plane. The activity's `serviceUrl` must also match
  `TEAMS_BOT_ALLOWED_SERVICE_URL_HOSTS` before the bot posts anything to it.
- **Bot to control plane.** `sig1` request signatures with `SERVICE_AUTH_SECRET_TEAMS_BOT` as
  service `teams-bot`, plus `X-OpenInspect-Actor: microsoft:<aadObjectId>` naming the sender.
  Prompts carry `source: "msteams"` and an `msteams` callback context (conversation id, service URL,
  reply id, channel id, repository, model).
- **Control plane to bot.** `POST /callbacks/complete`, `/callbacks/activity`,
  `/callbacks/tool_call` and `/callbacks/thread_closed`, JSON bodies that carry a `signature` field:
  the hex HMAC-SHA256, under `SERVICE_AUTH_SECRET_TEAMS_BOT`, of the JSON of the body without that
  field (the same scheme the Slack and Linear bots verify with `verifyCallbackFromControlPlane`).
  The bot rejects a body whose signature does not match, and dedupes accepted callbacks by
  `(messageId, kind)` in SQLite because the control plane retries deliveries.
- **Bot to Teams.** Replies and edits go through the Bot Framework REST connector on the activity's
  `serviceUrl`, with a client-credentials token for the bot app (scope
  `https://api.botframework.com/.default`, the single tenant's token endpoint).

## Troubleshooting

| Symptom                                                                    | Where to look                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The bot never answers in Teams                                             | `az bot show ... --query properties.endpoint`: is it the public `/api/messages` URL? `curl -i -X POST https://<host>/api/messages -d '{}'` from outside must return **401** from the bot (not a TLS error, not a 404 from the proxy). Then the bot's log: an activity that arrived but was dropped says why (token, tenant, service URL, or an unbound channel). |
| 401 on every activity although the endpoint is right                       | `TEAMS_BOT_APP_ID` differs from the Azure Bot's `msaAppId` (the token's audience), or the bot's clock is off by more than the allowed skew.                                                                                                                                                                                                                      |
| "Sign in once at ..." for a user who did sign in                           | They signed in with GitHub, not Microsoft. Or their Microsoft sign-in was refused (`microsoft_email_unverified`, domain not allowed); see the control plane's `auth.*` log lines.                                                                                                                                                                                |
| "This channel is not bound to a team..."                                   | The id in the binding is not the channel's `19:...@thread.tacv2` id (decode the link), or the binding is on another team. `GET /channel-bindings/msteams/<id>` as the service answers 404 for an unbound channel.                                                                                                                                                |
| The session starts but the thread never gets progress or the final message | The control plane cannot reach the bot: `TEAMS_BOT_URL` unset (callbacks are skipped, the log says `skip_reason: no_binding`), the NetworkPolicy blocks it, or `SERVICE_AUTH_SECRET_TEAMS_BOT` differs between the two (the bot logs a signature mismatch and answers 401, the control plane logs `callback.*_delivery_attempt_failed` with `http_status: 401`). |
| Two final messages                                                         | The dedupe store is not persistent: check the PVC is mounted at `TEAMS_BOT_STATE_DIR` and writable by uid 1000.                                                                                                                                                                                                                                                  |
| Replies fail with 401/403 from the connector                               | The client secret is wrong or expired (`az ad app credential list --id <APP_ID>`), or the app is multi-tenant while the bot requests a single-tenant token. Rotate with step 4 and restart the bot.                                                                                                                                                              |
| The bot pod is `CrashLoopBackOff`                                          | `kubectl -n open-inspect logs deploy/open-inspect-teams-bot --previous`: a missing required variable fails the boot with its name; a read-only `/state` means the volume did not mount.                                                                                                                                                                          |
| Audit                                                                      | `authorization.request_allowed` and `request_denied` rows carry `service = teams-bot` and the resolved user; a refused unenrolled sender is a `request_denied` with `service_actor_not_enrolled` and the asserted actor in the metadata. `team.binding_added` covers `msteams` bindings.                                                                         |
