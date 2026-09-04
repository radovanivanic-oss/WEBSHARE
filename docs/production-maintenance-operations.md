# Webshare Atlas production maintenance

The production workflow runs once per day in `Europe/Bratislava`. Discovery
starts at 03:17 and the additive maintenance stage starts at 03:47, after the
observation is available. The checked-in systemd unit can run the combined
workflow at 03:17 when installed by a privileged deploy; `tb` currently uses
the existing system discovery timer plus the installed user cron stage because
the account has no noninteractive root deployment grant:

1. continue the anonymous discovery series and reuse the same-day observation when a run is restarted;
2. refresh persistence and eligibility using the established B39/B47 safety gates;
3. apply safe additive candidates in bounded batches (up to 1,000 files per cycle);
4. publish only when SQLite changed, using the existing immutable Release publication and pointer-last switch.

The discovery timer is `webshare-daily-observation.timer`; the additive stage
is `webshare-production-maintenance.cron`. Additive authorization is generated
by the service with a fixed machine identity; duplicate, tombstone,
classification, ownership, and integrity checks remain mandatory.

Normal operator status:

```sh
npm run maintenance:status
```

This reports discovery, apply, publication, production counts, public
generation, timer state, health checks, and the last safe error code. Logs are
kept under `runtime/production-maintenance/` and rotated by
`webshare-daily-maintenance-logrotate`.

A discovery or import failure leaves the previous database/public generation
active. A publication failure before pointer activation also leaves the old
pointer active; the next daily run resumes an uncommitted publication before
processing another additive batch. A no-change run does not create a
generation.

Weekly stale verification remains conservative and queued: the existing B56
167 suspects are retained, and unresolved/provider-error results never
deactivate files. It is independent of the daily additive path.
