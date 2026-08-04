# Catalog deployment evidence

Capture is separate from classification: `node scripts/capture-catalog-deployment-evidence.js --repository-root <repo> --output-dir <new-directory>` writes the four versioned snapshots and a bounded capture manifest. The deployment auditor then receives each snapshot explicitly. Neither command has production defaults.

Capture is read-only: it uses bounded `systemctl` inventory, `nginx -T`, `crontab -l`, and `ps` output. It never changes a service, nginx, cron, SQLite, or processes. The operator must separately authorize capture and a single audit execution.

Each `webshare-*-snapshot/v1` has a UTC timestamp, redaction flag, normalized records, `capture_status`, `coverage_status`, command counters, examined/relevant counts, and bounded limitation codes. Snapshot limits are 2 MiB, 256 records for systemd/nginx/process, 128 for cron, and 4096 bytes per scalar. Assignment-style secrets are rejected.

`snapshot_set_complete` means that all four files validate. `material_evidence_complete` additionally requires successful complete-scope command capture, a command attempt and success, and examined records for every source. Placeholder files with zero attempts and zero examined records are rejected before an audit root is created. A successful inspection with no relevant records is valid complete-negative evidence. The auditor resolves the commit with `git -C <repository-root> rev-parse HEAD` and fails closed if it cannot do so.

Nginx capture now resolves the active include graph when `nginx -T` is unavailable to the current user. The resolver starts at the proven main config, follows bounded `include` directives, supports `conf.d/*.conf`, `sites-enabled/*`, relative and absolute includes, nested includes, and normal `sites-enabled` symlinks whose targets remain under approved nginx config roots. It enforces depth 16, 256 files, 256 matches per include, 2 MiB per file, 16 MiB total, cycle detection, symlink-loop detection, invalid UTF-8 rejection, and unreadable mandatory include failure.

The nginx parser records only normalized deployment evidence. It tracks `http`, `server`, `location`, `root`, `alias`, `try_files`, `proxy_pass`, `listen`, and `server_name`, preserving source file, canonical file, include chain, depth, symlink source/target, record index, and config digest. Proxy targets are separate from filesystem alias/root/try_files targets.

Complete negative static evidence is valid only when the full active nginx include graph resolves, parsing succeeds, mandatory includes are readable, bounds pass, and no catalog static/proxy target is found. In that case the audit can produce `NO_ACTIVE_STATIC_SERVING_PROVEN` when systemd, cron, and process evidence are also materially complete and no unresolved static consumer remains.

Deployment-aware readiness evaluation is available through `scripts/audit-catalog-consumers.js` with `--compatibility-dir` and `--deployment-audit-dir`. It consumes the deployment audit counters and static-serving conclusion rather than rescanning deployment evidence. It never publishes or mutates catalog artifacts.
