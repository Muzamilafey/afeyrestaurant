# SMS — Talk Sasa

Messages are queued and sent by the background worker with retries (exponential backoff for temporary errors, no
retry for permanent ones) and de-duplication, so the same notification is never sent twice.

## Configure (Integrations → Talk Sasa SMS)

- **API base URL**: default `https://bulksms.talksasa.com/api/v3`.
- **API token**: from your Talk Sasa dashboard (Developers/API). Sent as `Authorization: Bearer <token>`.
- **Sender ID**: your approved alphanumeric sender ID (3–11 characters).
- **Send/balance paths**: default `sms/send` (POST `{recipient, sender_id, type: "plain", message}`) and `balance`.
- **Delivery reports**: click *Delivery-report URL* and paste the one-time URL into Talk Sasa. Reports update message
  status to *delivered*.
- **Send test** sends a real SMS and reports the provider’s message id.

> **Unverified**: Talk Sasa’s official API reference could not be retrieved while building this integration; the
> request format follows their v3 API as used by a community client. The paths are configurable. Confirm the
> endpoints and delivery-report format in your Talk Sasa dashboard documentation and send a test before go-live.

## Templates & consent

Templates (Integrations → Message templates) use `{{variables}}` and show the SMS segment count (GSM-7/UCS-2);
templates over 6 segments are rejected. Transactional messages (receipts, order ready, reservations, alerts) are
always sent; **promotional** messages are sent only to customers who opted in, and include an opt-out line.

Phone numbers are normalised to `2547…/2541…`. Logs record status and provider ids, never the API key.
