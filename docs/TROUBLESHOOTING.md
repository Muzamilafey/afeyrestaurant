# Troubleshooting

| Symptom | Fix |
|---|---|
| API exits with *Refusing to start in production* | Set `JWT_ACCESS_SECRET`, `SECRETS_ENCRYPTION_KEY` and `COOKIE_SECURE=true`. |
| `Transaction numbers are only allowed on a replica set member` / setup returns 503 `DATABASE_TRANSACTIONS_UNAVAILABLE` | MongoDB is standalone — convert it to a single-node replica set: [MONGODB-WINDOWS.md](MONGODB-WINDOWS.md) (Windows) or SETUP.md §1. Run `npm run db:check`. |
| `ReplicaSetNoPrimary` at start-up | `MONGODB_URI` has `?replicaSet=rs0` but the server is standalone, not initiated, or the member host is unreachable — `npm run db:check` and MONGODB-WINDOWS.md. |
| App does not offer **Install** | Must be served over HTTPS (or localhost) and `/api/v1/manifest.webmanifest` must reach the API. Chrome/Edge: ⋮ → Install. iPhone/iPad: Safari → Share → Add to Home Screen. |
| Signed out on every refresh | Serve the app and API from the same site over HTTPS with `COOKIE_SECURE=true`, and include the web origin in `CORS_ORIGINS`. |
| *This device is not registered for PIN sign-in* | A manager must sign in on that device and choose **Use this device** (account menu). |
| PIN locked | Wait `LOGIN_LOCK_MINUTES` or a manager resets the PIN in Settings → Users. |
| M-Pesa prompt never confirms | `PUBLIC_API_URL`/callback base must be public HTTPS; check Integrations → M-Pesa recent activity and Accounting → Reconciliation → M-Pesa exceptions. |
| SMS/email “skipped” | The integration is disabled, the number/email is invalid, or a marketing message lacks consent — the reason is shown in the message queue. |
| Kitchen tickets not printing | Bridge offline (Integrations → Local bridges “last seen”), printer IP/port wrong (*Test print*), or the printer role is not *Kitchen tickets*. |
| ZKTeco device offline | Check LAN reachability of port 4370 from the bridge PC, the device's comm key (must be 0), and that only one program polls the device. |
| Offline sales “pending sync” | They sync automatically every 30 s once online; rejected sales stay in the outbox with the reason. |
| Restoring a backup | See DEPLOYMENT.md → Restore drill. |
