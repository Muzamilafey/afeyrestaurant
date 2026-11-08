# KRA eTIMS (OSCU)

Every paid sale is sent to KRA's eTIMS and signed. The receipt then prints KRA's details: the CU serial and
invoice number, the internal data, the receipt signature and a QR code that customers can scan to check the
invoice on KRA's site. Refunds are sent as credit notes against the signed sale.

Chili POS talks to eTIMS through **OSCU** (Online Sales Control Unit), the option for systems that are online. This
follows KRA's *OSCU Specification Document v2.0*. **It has not been certified by KRA or tested against a live KRA
account yet.** Test everything in the KRA sandbox before you switch to production.

## Before you start (KRA side)

1. Sign up on the eTIMS portal (sandbox: <https://etims-sbx.kra.go.ke>, production: <https://etims.kra.go.ke>)
   with your iTax PIN and choose **OSCU**.
2. Register this POS as your third-party system. KRA approves an **OSCU serial number** for your branch.
3. Note your **branch ID**: `00` is the head office; other branches are `01`, `02`… as registered on iTax.
4. Find the **item classification codes** for what you sell (food, soft drinks, alcohol…) in the portal's item
   classification list.

## Set up in Chili POS

1. **Integrations → KRA eTIMS → Configure & test.** Choose *KRA eTIMS* and *Sandbox*, then enter:
   - the KRA PIN, branch ID and OSCU serial number;
   - the default item classification, used for products without their own;
   - the tax type for items without VAT: A exempt, C zero-rated or D non-VAT.

   Press **Save**.
2. Press **Initialise device**. KRA checks the PIN, branch and serial and returns the communication key
   (`cmcKey`). The key is stored encrypted and is never shown again. This is done once per device.
3. Press **Test KRA connection**, then switch **Enabled** on and **Save**. Sales paid from that moment are sent.
   Earlier sales are not.
4. Optional: in **Settings → Menu**, give products their own KRA item classification and tax type. For example,
   give alcohol its own class.
5. Make a test sale, print the receipt, scan its QR code and check the invoice on the sandbox portal. When
   everything is right, initialise again with *Production* and your production serial number.

If this PIN and branch already sent invoices from another system, enter the **last invoice number already used**.
Chili POS continues from the next number.

## How sales are sent

- **Numbering.** A sale gets the next KRA invoice number as soon as it is paid, in the order sales were paid. KRA
  requires invoice numbers to rise by exactly one, with no gaps.
- **Prices.** Prices are sent including VAT, as eTIMS requires.
  - B (16%) or E (8%) comes from the product's taxes, unless the product has its own KRA tax type.
  - An order discount is spread over the lines as line discounts.
  - Service charge and the delivery fee are sent as their own service lines.
  - The lines always add up to the receipt total.
  - Tips are not sales and are not sent.
- **Items.** Each product is registered with KRA under an item code (`KE2NTU0000001`…) the first time it is sold.
  It is registered again if its name, classification or tax type changes.
- **Refunds.** A refund is sent as a credit note (reason *refund*) once its sale has been signed. A partial refund
  credits every line in proportion.
- **Offline and outages.** The till never waits for KRA.
  - If KRA or the internet is down, the invoice keeps its number and is retried, at first every 30 seconds and up
    to every 30 minutes.
  - Meanwhile the receipt says *"KRA eTIMS invoice is being signed — reprint shortly for the signed copy"*.
  - Offline sales are sent once they reach the server.
- **Live copy.** On a live (VPS) copy nothing is sent. Only the restaurant's own server talks to KRA.

## When KRA refuses an invoice

Refused invoices are listed under **Integrations → KRA eTIMS → Device & invoices** with KRA's message (for example
`KRA 910: Request parameter error`).

1. Fix the cause. Usually this is a missing or wrong item classification, or the wrong PIN or branch.
2. Press **Resend**. The invoice is sent again with the same number.

**"Already at KRA"** means KRA already has this invoice number. An earlier send got through, but its answer was
lost. Look the invoice up on the eTIMS portal.

## What prints on the receipt

| Line | From KRA |
| --- | --- |
| CU Serial No. | `sdcId` |
| CU Invoice No. | `sdcId/curRcptNo` |
| Invoice No. | `invcNo` (Chili POS numbering, as sent) |
| Date | `sdcDateTime` |
| Internal Data | `intrlData` |
| Receipt Signature | `rcptSign` |
| QR code | KRA receipt page for PIN + branch + signature |

Receipts made with the **simulated** provider say *SIMULATED - NOT SENT TO KRA*. The simulated provider is only for
development and cannot be used in production.
