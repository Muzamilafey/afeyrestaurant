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
4. **Callback base URL** must be public HTTPS (your `PUBLIC_API_URL`). Callbacks go to
   `/api/v1/mpesa/callback/stk/<attempt>/<one-time token>`.
5. **Test Daraja authentication**, then make a small real payment. Production requires Safaricom go-live approval.
6. Optional: **Register C2B URLs** to receive direct Till/Paybill payments, which cashiers can apply to orders under
   the payment dialog (verified by Safaricom’s confirmation, not by the cashier).

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

**Manual M-Pesa codes** (customer paid outside the prompt): requires `payments.manual_confirm` or a manager PIN,
a reason, and is audited and shown separately in reconciliation.

**Development**: the *Simulated* provider (non-production only) lets you complete the full flow with
*Simulate success/cancel* buttons; results are labelled SIMULATED.

**Verification status**: implemented against the published Daraja contract and covered by automated tests with the
simulated provider. Not yet exercised against the live Daraja sandbox from this environment — run the sandbox test
in Integrations before go-live.
