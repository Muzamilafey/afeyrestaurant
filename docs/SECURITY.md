# Security notes

- **Authentication**: Argon2id password hashing (OWASP parameters); 15-minute JWT access tokens kept in memory;
  httpOnly, SameSite=Strict refresh cookie with **rotation** and **reuse detection** (reuse after a 30 s grace window
  revokes the whole session family); anti-CSRF header on cookie endpoints; login rate limiting and account lockout;
  optional TOTP MFA; password reset tokens hashed, single-use, 30-minute expiry, no account enumeration.
- **PIN sign-in** only works on terminals registered by a manager (hashed terminal token); PINs are numeric 4–6
  digits, trivial PINs are rejected, wrong PINs lock the account, and terminals auto-lock when idle.
- **Authorization**: every route declares its permission and is checked on the server; branch access is validated
  on every request; manager approvals (voids, discounts above threshold, refunds, overrides, manual payment
  confirmation) use the approver's own PIN and are audited with the reason.
- **Data scoping**: a Mongoose guard rejects any query on business data that is not explicitly scoped.
- **Input**: Zod validation on every body/query; `$`-prefixed and dotted keys stripped (NoSQL injection); 1 MB JSON
  limit; image uploads limited by size, MIME type **and** file signature, stored with random names.
- **Secrets**: integration credentials AES-256-GCM encrypted at rest, never returned to clients, redacted from logs.
  No card numbers or CVVs are ever collected (card payments record the terminal approval code only).
- **Webhooks**: M-Pesa callbacks authenticated with per-attempt one-time tokens (+ optional IP allowlist and status
  query); C2B and SMS delivery reports use secret URL keys; all processing is idempotent.
- **Ledgers**: payments, refunds, stock movements and audit logs are append-only; corrections are reversals.
- **Headers**: Helmet, strict CORS allowlist, HSTS via Nginx.
