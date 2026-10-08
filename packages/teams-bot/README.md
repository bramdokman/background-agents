# @open-inspect/teams-bot

The Microsoft Teams bot for Open-Inspect: a Node service (Hono on `@hono/node-server`) that receives
Bot Framework activities, starts and continues sessions through the control plane as the `teams-bot`
service principal, and renders progress back into the Teams thread.

## What it does

- `POST /api/messages`: Bot Framework inbound. The bearer JWT is verified (issuer
  `https://api.botframework.com` or the bot's tenant, audience `TEAMS_BOT_APP_ID`, RS256 keys from
  OpenID discovery, `azp`/`appid` = the bot's app id for tenant-issued tokens, `serviceurl` claim
  against the activity); activities from other tenants are dropped, and a `serviceUrl` outside
  `TEAMS_BOT_ALLOWED_SERVICE_URL_HOSTS` is rejected before any outbound call.
- Commands after the mention: `owner/repo <prompt>` or `repo:owner/repo <prompt>` starts a session
  in a new thread (a bare prompt works when the bound team has exactly one repository); a reply in a
  session's thread is a follow-up prompt; `status`, `stop` and `help`.
- Every control-plane request is sig1-signed as `teams-bot` with `SERVICE_AUTH_SECRET_TEAMS_BOT` and
  asserts the Teams user as `X-OpenInspect-Actor: microsoft:<aadObjectId>`. Users who have not
  signed in on the web once are asked to; quota and team denials show the control plane's message.
- State lives in SQLite (`node:sqlite`) under `TEAMS_BOT_STATE_DIR`: thread to session, conversation
  references, and the claims that make retried activities and callbacks idempotent.
- `POST /callbacks/complete`, `/callbacks/tool_call`, `/callbacks/activity`,
  `/callbacks/thread_closed`: the control plane's reports on a session this bot started. Each body
  carries `signature`, the hex HMAC-SHA256 of the rest of the body keyed with
  `SERVICE_AUTH_SECRET_TEAMS_BOT` (the control plane signs with the destination bot's own key; there
  is no signature header and no nonce). A bad signature is 401 before anything is read or posted; a
  `timestamp` further than 5 minutes from now (2 for `activity`) is rejected as well.
  - `tool_call` adds a line under the thread's "Working..." reply; bursts are conflated into one
    edit (ported Centaur reply sink and conflater).
  - `complete` reads the turn's events and artifacts back as the user who started the session, then
    edits "Working..." into the final answer, the pull request link and the web session link. The
    delivery is claimed in SQLite by `(messageId, kind)` first, so a retried callback posts nothing
    and a bot restart in between still yields exactly one final message (the stored conversation
    reference addresses the thread). The reads need the actor the bot stored with the thread:
    without it (an unknown thread) the final message carries the link only.
  - `thread_closed` marks the thread closed and posts a short note once. The control plane sends it
    (`kind: "msteams.thread_closed"`) instead of a completion or tool call when its publication gate
    denies the thread: the session became private, or the channel is no longer bound to the
    session's team.
  - `activity` is acknowledged; Teams has no indicator to refresh, and the control plane emits
    activity refreshes only for Slack.
- `GET /healthz` for probes.

## Configuration

| Variable                              | Meaning                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------- |
| `TEAMS_BOT_APP_ID`                    | Entra app (client) id of the bot registration; the inbound JWT audience.  |
| `TEAMS_BOT_APP_SECRET`                | Client secret of that registration (connector token).                     |
| `TEAMS_BOT_TENANT_ID`                 | The single tenant served; other tenants' activities are dropped.          |
| `TEAMS_BOT_PORT`                      | Listen port, default `3100`.                                              |
| `CONTROL_PLANE_URL`                   | Control plane base URL, e.g. `http://10.43.250.21:8787` in-cluster.       |
| `SERVICE_AUTH_SECRET_TEAMS_BOT`       | sig1 signing secret; the control plane signs callbacks with the same key. |
| `WEB_APP_URL`                         | Web app origin for session links.                                         |
| `TEAMS_BOT_STATE_DIR`                 | SQLite directory, default `/state`.                                       |
| `TEAMS_BOT_ALLOWED_SERVICE_URL_HOSTS` | Default `*.botframework.com,smba.trafficmanager.net`.                     |
| `HOST`                                | Listen address, default `0.0.0.0`.                                        |
| `LOG_LEVEL`                           | `debug`, `info` (default), `warn` or `error`.                             |

Required: `TEAMS_BOT_APP_ID`, `TEAMS_BOT_APP_SECRET`, `TEAMS_BOT_TENANT_ID`, `CONTROL_PLANE_URL`,
`SERVICE_AUTH_SECRET_TEAMS_BOT`, `WEB_APP_URL`. The rest have the defaults shown.

## Development

```sh
npm run build -w @open-inspect/shared
npm test -w @open-inspect/teams-bot
npm run typecheck -w @open-inspect/teams-bot
npm run build -w @open-inspect/teams-bot && TEAMS_BOT_STATE_DIR=./.state node packages/teams-bot/dist/main.js
```

The image is built from the repository root (`.dockerignore` admits `packages/teams-bot/`):
`docker build -f packages/teams-bot/Dockerfile -t open-inspect-teams-bot .`. It runs as the `node`
user (uid 1000) with its SQLite state on the `/state` volume.

Parts of this package are ported from Centaur's Teams bot; see `PORTED.md`.
