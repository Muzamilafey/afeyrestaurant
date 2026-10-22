# Printers, cash drawers and scanners

| Device | How it works |
|---|---|
| **Network ESC/POS printers** (Epson TM-T20/T82, Xprinter, etc., port 9100) | Driven by the [Chili Bridge](../../bridge/README.md) on the LAN. Add under Integrations → Printers with role *Receipts*, *Bills*, *Kitchen tickets* or *Bar tickets*. |
| **Kitchen / bar ticket printers** | When items are sent, each station's tickets are queued automatically to printers with that role (food → kitchen, drinks → bar). |
| **Receipt printer** | *Print receipt* sends to the branch's network receipt printer when one exists; otherwise the browser print dialog (80 mm layout). |
| **Cash drawer** | Connected to the receipt printer's DK port; opened with an ESC/POS pulse (print job kind `cash_drawer`). |
| **Barcode scanners** | USB/Bluetooth scanners in keyboard mode: scan into the POS search box — an exact barcode/SKU/PLU match adds the item. |
| USB / Bluetooth printers | Not driven by the bridge yet — use the browser print dialog with the OS printer driver. |

## Behaviour

- Print jobs are idempotent (`dedupeKey`), logged (Integrations → Printers → Print log) and their status
  (`queued → sent → printed/failed`) is reported by the bridge. **Test print** checks a printer end to end.
- A printer failure never affects a sale; the order stays paid and the job shows *failed* so it can be retried.
- Receipts: the first print is the **original**; later prints are marked **DUPLICATE COPY** and need
  `receipts.reprint` plus a reason (audited).
- Printer status (last print, last error) is shown in the Integrations centre; the bridge reports reconnects.

**Verification**: ESC/POS output and the network transport are tested against a TCP printer emulator, including a
full API → bridge → printer round trip. Test each physical printer model with *Test print* before go-live.
