# WhatsApp (Meta WhatsApp Cloud API)

Send receipts and customer messages on WhatsApp: payment confirmations, order ready, delivery updates and
reservations.

## Set up

1. In **Meta Business Suite**, create a WhatsApp Business app and add your business phone number. A number that
   is already used in the WhatsApp app must be moved to the API first.
2. Under **WhatsApp → API setup**, copy the **Phone number ID**. Create a **System User** with a permanent access
   token that has `whatsapp_business_messaging` permission.
3. Under **WhatsApp Manager → Message templates**, create a **Utility** template:
   - Name: `chili_message`
   - Language: English (`en`)
   - Body: `Message from {{1}}:` (blank line) `{{2}}`

   Wait until it is *Approved*.
4. In Chili POS, go to **Integrations → WhatsApp → Configure & test** and enter the phone number ID, access token,
   template name and language. Then send a test message to your own WhatsApp number.

## How messages are sent

- **Template (recommended)**: works at any time. `{{1}}` is filled with the business name and `{{2}}` with the
  message. WhatsApp does not allow line breaks inside template variables, so a receipt arrives as one paragraph,
  with lines separated by " · ".
- **Free text**: keeps the line breaks, but only works within 24 hours of the customer messaging you. Otherwise
  WhatsApp answers with error 131047.

**Use for customer messages**:
- *Only when chosen*: a WhatsApp button next to SMS and email on the receipt screen.
- *Instead of SMS*: customer messages go by WhatsApp only.
- *As well as SMS*: customer messages go both ways.

Staff and manager messages (daily summary, low stock, alerts) always stay SMS or email.

Meta charges per conversation. Check pricing in Meta Business Suite. The *Simulated* provider (non-production only)
lets you try the flow without sending anything.
