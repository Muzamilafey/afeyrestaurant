# Email — SMTP

Works with any SMTP service: Zoho Mail (`smtp.zoho.com:587`), Brevo (`smtp-relay.brevo.com:587`), Google Workspace
(`smtp.gmail.com:587` with an app password), Microsoft 365 (`smtp.office365.com:587`) and others.

Configure under **Integrations → SMTP email**: host, port, encryption (STARTTLS on 587 is enforced — the
connection fails rather than sending in clear text; implicit TLS on 465), username, password (encrypted at rest),
sender name/email and reply-to. **Send test** verifies the connection and sends a message.

“Sent” means the SMTP server **accepted** the message (its message id is stored). That is not proof of inbox
delivery — bounces arrive at the sender mailbox.

Emails use a branded HTML template (business name and colour) with a plain-text alternative and are queued with
retries and de-duplication.

## Deliverability: SPF, DKIM, DMARC

Publish these DNS records for your sending domain (values come from your provider):

| Record | Example | Purpose |
|---|---|---|
| SPF (TXT on `@`) | `v=spf1 include:zoho.com ~all` | Authorises the provider to send for your domain. Only **one** SPF record per domain — merge `include:`s. |
| DKIM (TXT on `selector._domainkey`) | provided by Zoho/Brevo/Google | Signs messages so receivers can verify them. |
| DMARC (TXT on `_dmarc`) | `v=DMARC1; p=quarantine; rua=mailto:dmarc@yourdomain` | Tells receivers what to do with failures; start with `p=none` to monitor. |

Use a sender address on that domain (not a free webmail address), and verify with <https://www.mail-tester.com>.
