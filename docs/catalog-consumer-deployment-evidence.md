# Catalog deployment evidence

Capture is separate from classification: `node scripts/capture-catalog-deployment-evidence.js --repository-root <repo> --output-dir <new-directory>` writes the four versioned snapshots and a bounded capture manifest. The deployment auditor then receives each snapshot explicitly. Neither command has production defaults.

Capture is read-only: it uses bounded `systemctl` inventory, `nginx -T`, `crontab -l`, and `ps` output. It never changes a service, nginx, cron, SQLite, or processes. The operator must separately authorize capture and a single audit execution.

Each `webshare-*-snapshot/v1` has a UTC timestamp, redaction flag, normalized records, `capture_status`, `coverage_status`, command counters, examined/relevant counts, and bounded limitation codes. Snapshot limits are 2 MiB, 256 records for systemd/nginx/process, 128 for cron, and 4096 bytes per scalar. Assignment-style secrets are rejected.

`snapshot_set_complete` means that all four files validate. `material_evidence_complete` additionally requires successful complete-scope command capture, a command attempt and success, and examined records for every source. Placeholder files with zero attempts and zero examined records are rejected before an audit root is created. A successful inspection with no relevant records is valid complete-negative evidence. The auditor resolves the commit with `git -C <repository-root> rev-parse HEAD` and fails closed if it cannot do so.
