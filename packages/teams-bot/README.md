# @open-inspect/teams-bot

The Microsoft Teams bot for Open-Inspect: a Node service (Hono on `@hono/node-server`) that receives
Bot Framework activities, starts and continues sessions through the control plane as the `teams-bot`
service principal, and renders progress back into the Teams thread.

## What it does

- `POST /api/messages`: Bot Framework inbound. The bearer JWT is verified (issuer
  `https://api.botframework.com` or the bot's tenant, audience `TEAMS_BOT_APP_ID`, RS256 keys from
  OpenID discovery, `serviceurl` claim against the activity); activities from other tenants are
  dropped, and a `serviceUrl` outside `TEAMS_BOT_ALLOWED_SERVICE_URL_HOSTS` is rejected before any
  outbound call.
- Commands after the mention: `owner/repo <prompt>` or `repo:owner/repo <prompt>` starts a session
  in a new thread (a bare prompt works when the bound team has exactly one repository); a reply in a
  session's thread is a follow-up prompt; `status`, `stop` and `help`.
- Every control-plane request is sig1-signed as `teams-bot` with `SERVICE_AUTH_SECRET_TEAMS_BOT` and
  asserts the Teams user as `X-OpenInspect-Actor: microsoft:<aadObjectId>`. Users who have not
  signed in on the web once are asked to; quota and team denials show the control plane's message.
- State lives in SQLite (`node:sqlite`) under `TEAMS_BOT_STATE_DIR`: thread to session, conversation
  references, and the claims that make retried activities and callbacks idempotent.
- `GET /healthz` for probes. Callback routes (`/callbacks/*`) arrive with stage 2.

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
| `LOG_LEVEL`                           | `debug`, `info` (default), `warn` or `error`.                             |

## Development

```sh
npm run build -w @open-inspect/shared
npm test -w @open-inspect/teams-bot
npm run typecheck -w @open-inspect/teams-bot
npm run build -w @open-inspect/teams-bot && TEAMS_BOT_STATE_DIR=./.state node packages/teams-bot/dist/main.js
```

The image is built from the repository root:
`docker build -f packages/teams-bot/Dockerfile -t open-inspect-teams-bot .`

Parts of this package are ported from Centaur's Teams bot; see `PORTED.md`.
