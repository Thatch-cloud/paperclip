# GitOps mirror sync systemd units

These files codify the host-local GitOps mirror sync configuration used by
`thatch-control-plane-prod`.

The timer keeps the local bare mirror at `/srv/git/Thatch.Server.git` aligned
with GitHub `main` once per minute. The sync script reads the deploy key from
the Kubernetes secret `thatch-monitoring/thatch-gitops-mirror-github-ssh` and
does not persist the key outside `/run`.

Install or refresh the units on the host that serves the GitOps mirror:

```sh
sudo install -m 0755 deploy/bin/thatch-gitops-mirror-sync /usr/local/sbin/thatch-gitops-mirror-sync
sudo install -m 0644 deploy/systemd/system/thatch-gitops-mirror-sync.service /etc/systemd/system/thatch-gitops-mirror-sync.service
sudo install -d /etc/systemd/system/thatch-gitops-mirror-sync.service.d
sudo install -m 0644 deploy/systemd/system/thatch-gitops-mirror-sync.service.d/ownership-preflight.conf /etc/systemd/system/thatch-gitops-mirror-sync.service.d/ownership-preflight.conf
sudo install -m 0644 deploy/systemd/system/thatch-gitops-mirror-sync.timer /etc/systemd/system/thatch-gitops-mirror-sync.timer
sudo install -d /etc/systemd/system/thatch-gitops-mirror-sync.timer.d
sudo install -m 0644 deploy/systemd/system/thatch-gitops-mirror-sync.timer.d/calendar.conf /etc/systemd/system/thatch-gitops-mirror-sync.timer.d/calendar.conf
sudo systemctl daemon-reload
sudo systemctl enable --now thatch-gitops-mirror-sync.timer
```

Verify recurrence and sync state:

```sh
systemctl list-timers thatch-gitops-mirror-sync.timer --all
systemctl status thatch-gitops-mirror-sync.timer --no-pager
systemctl start thatch-gitops-mirror-sync.service
```

The `calendar.conf` drop-in intentionally clears the older monotonic timer
settings and schedules the service with `OnCalendar=*-*-* *:*:00`; without it,
the timer can become `active (elapsed)` with no next trigger.
