---
title: Deployment Modes
summary: local_trusted vs authenticated (private/public)
---

Paperclip supports two runtime modes with different security profiles. Reachability is configured separately with `bind`.

## `local_trusted`

The default mode. Optimized for single-operator local use.

- **Host binding**: loopback only (localhost)
- **Bind**: `loopback`
- **Authentication**: no login required
- **Use case**: local development, solo experimentation
- **Board identity**: auto-created local board user

```sh
# Set during onboard
pnpm paperclipai onboard
# Choose "local_trusted"
```

## `authenticated`

Login required. Supports two exposure policies.

### `authenticated` + `private`

For private network access (Tailscale, VPN, LAN).

- **Authentication**: login required via Better Auth
- **URL handling**: auto base URL mode (lower friction)
- **Host trust**: private-host trust policy required
- **Bind**: choose `loopback`, `lan`, `tailnet`, or `custom`

```sh
pnpm paperclipai onboard
# Choose "authenticated" -> "private"
```

Allow custom Tailscale hostnames:

```sh
pnpm paperclipai allowed-hostname my-machine
```

### `authenticated` + `public`

For internet-facing deployment.

- **Authentication**: login required
- **URL**: explicit public URL required
- **Security**: stricter deployment checks in doctor
- **Bind**: usually `loopback` behind a reverse proxy; `lan/custom` is advanced

```sh
pnpm paperclipai onboard
# Choose "authenticated" -> "public"
```

## Board Claim Flow

When migrating from `local_trusted` to `authenticated`, Paperclip emits a one-time claim URL at startup:

```
/board-claim/<token>?code=<code>
```

A signed-in user visits this URL to claim board ownership. This:

- Promotes the current user to instance admin
- Demotes the auto-created local board admin
- Ensures active company membership for the claiming user

## Changing Modes

Update the deployment mode:

```sh
pnpm paperclipai configure --section server
```

Runtime override via environment variable:

```sh
PAPERCLIP_DEPLOYMENT_MODE=authenticated PAPERCLIP_BIND=lan pnpm paperclipai run
```

## Deterministic Native Control-Plane Deploys

For a long-running native `paperclip.service`, do not point systemd directly at a mutable agent checkout. Deploy an exact commit into a detached release worktree and start through the guard script:

```sh
cd /home/thatch/Documents/oasthaus/paperclip
scripts/deploy-control-plane.sh origin/master
systemctl --user daemon-reload
systemctl --user restart paperclip.service
```

The deploy command resolves the requested ref to a SHA, creates `~/.paperclip/control-plane/releases/<sha>`, updates `~/.paperclip/control-plane/current`, and writes `~/.paperclip/control-plane/deploy.env` with the intended `PAPERCLIP_CONTROL_PLANE_REF`. The start script fails closed if `current` is not a git checkout at that exact SHA or if the release marker disagrees.

Use this shape for the user service:

```ini
[Service]
WorkingDirectory=/home/thatch/.paperclip/control-plane/current
EnvironmentFile=/home/thatch/.paperclip/instances/default/.env
EnvironmentFile=/home/thatch/.paperclip/control-plane/deploy.env
ExecStart=/home/thatch/.paperclip/control-plane/current/scripts/start-control-plane.sh run --bind lan
```

Operators can inspect the running and pending refs without a behavioral canary:

```sh
cat ~/.paperclip/control-plane/deploy.env
readlink -f ~/.paperclip/control-plane/current
curl -sS http://127.0.0.1:3100/api/health | jq '.deployment'
```

Lag is explicit: a merged backend fix is pending when `git -C /home/thatch/Documents/oasthaus/paperclip rev-parse origin/master` differs from `PAPERCLIP_CONTROL_PLANE_REF` in `deploy.env` or from `.deployment.controlPlaneRef` on `/api/health`.
