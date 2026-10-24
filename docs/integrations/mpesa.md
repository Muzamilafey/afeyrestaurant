# M-Pesa (Safaricom Daraja)

Implemented: Lipa Na M-Pesa Online (STK Push), STK status query, C2B URL registration with confirmation/validation
callbacks, reconciliation. Sandbox and production are separate settings.

## Configure (Integrations → M-Pesa Daraja)

1. Create an app on <https://developer.safaricom.co.ke> with *M-Pesa Express* (and *M-Pesa Customer to Business* for
   Till/Paybill confirmations).
2. Enter the **Consumer key**, **Consumer secret**, **Business short code** and **passkey**.
   Sandbox: short code `174379` and the sandbox passkey from the Daraja portal.
3. **Transaction type**: Paybill (`CustomerPayBillOnline`) or Buy Goods (`CustomerBuyGoodsOnline` — enter the Till
   number as *Till number*; the short code is the store/HO number).
4. **Callback base URL** must be public HTTPS (your `PUBLIC_API_URL`), not a local address such as `192.168.x.x`,
   `172.16–31.x.x` or `10.x.x.x`. Callbacks go to `/api/v1/payhooks/callback/stk/<attempt>/<one-time token>` and
   `/api/v1/payhooks/c2b/<id>/<key>/{validation,confirmation}`. Safaricom refuses URLs that contain the words
   *M-Pesa*, *Safaricom*, *exec*, *cmd*, *SQL* or *query*, so the paths avoid them (the old `/api/v1/mpesa/...`
   callback paths still work). **Register C2B URLs** checks the address first and says what is wrong.
   Without a public address, STK payments still complete: the server asks Safaricom for the status every few
   seconds and records the sale as soon as it is paid (the M-Pesa code is added if a callback arrives later).
5. **Test Daraja authentication**, then make a small real payment. Production requires Safaricom go-live approval.
6. Optional: **Register C2B URLs** to receive direct Till/Paybill payments, which cashiers can apply to orders under
   the payment dialog (verified by Safaricom’s confirmation, not by the cashier).

### Payer name (who paid)

After a prompt payment succeeds, Chili POS asks Safaricom's **Transaction Status API** who paid. The answer
(`DebitPartyName`, e.g. `254712345678 - JANE WANJIKU DOE`) arrives a few seconds later. It is shown on the
*Payment complete* screen ("Paid by JANE WANJIKU DOE"), printed on the receipt and stored on the payment.
Till/Paybill (C2B) payments carry the name in Safaricom's confirmation, so they need nothing extra.

Needs, in Integrations → M-Pesa:

1. **Initiator name**: an API user created in the M-Pesa org portal with the *Transaction Status Query* role
   (sandbox: `testapi`).
2. **Security credential**: the initiator password encrypted with Safaricom's certificate. Either paste the ready
   credential from the Daraja portal, or enter the **initiator password** and paste the **Safaricom certificate**
   (sandbox or production, from the portal) and Chili POS encrypts it.
3. A public **callback base URL**. Safaricom only delivers the answer to `…/api/v1/payhooks/status/…`, so a server
   reachable only on the local network never gets names. Payments are not affected: the sale completes either way.

If something is missing, the payment attempt records why (*nameLookup*), and the sale still completes. The
*Simulated* provider returns "SIMULATED CUSTOMER" so the flow can be tried without Safaricom.

Secrets are encrypted at rest (AES-256-GCM) and never returned to the browser; the UI shows masked hints only.

## Payment lifecycle and safeguards

1. The cashier sends a prompt; the server validates and normalises the phone number and creates a payment attempt
   with a unique idempotency key and a one-time callback token. Only one live prompt per order is allowed.
2. The order is **not** paid when the prompt is sent.
3. On the callback the server checks the token, CheckoutRequestID/MerchantRequestID, result code, **exact amount**
   and the M-Pesa receipt number (unique). By default a success callback is confirmed with an STK status query before
   it is trusted (`verifyCallbackWithQuery`).
4. The payment is recorded once (duplicate callbacks are ignored); the order is closed and the receipt issued only
   when fully paid. Cancelled (1032), timed-out (1037) and failed results never mark an order paid.
5. A reconciliation job re-queries attempts whose callback is overdue. Money arriving for an already-settled order
   (late callback) is flagged in the audit log for refund.
6. Optional `MPESA_CALLBACK_IP_ALLOWLIST` restricts callback source IPs.

Amounts must be whole shillings. **Refunds**: reverse the transaction in the M-Pesa organisation portal, then record
the refund with the reversal reference (manager approval, audited). Automated Daraja Reversal API calls require
initiator credentials and are not enabled.

**Manual M-Pesa** (customer paid to the Till/Paybill directly, outside the prompt): the cashier picks *Manual M-Pesa*
and completes the sale — no code, reason or approval needed. The payment records who confirmed it, is audited, and is
shown as manual in reconciliation, so check those against the M-Pesa statement at cash-up.

**Development**: the *Simulated* provider (non-production only) lets you complete the full flow with
*Simulate success/cancel* buttons; results are labelled SIMULATED.

**Verification status**: implemented against the published Daraja contract and covered by automated tests with the
simulated provider. Not yet exercised against the live Daraja sandbox from this environment — run the sandbox test
in Integrations before go-live.
