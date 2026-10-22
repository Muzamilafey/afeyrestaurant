/** Built-in templates used when a tenant has not customised a template. */
export const DEFAULT_TEMPLATES: Record<string, { sms?: string; email?: { subject: string; body: string } }> = {
  payment_confirmation: {
    sms: 'Thank you for dining at {{restaurant_name}}. Order {{order_number}}: KSh {{amount}} received via {{payment_method}}. Receipt: {{receipt_number}}. We appreciate your visit.',
    email: { subject: 'Your receipt from {{restaurant_name}} — {{receipt_number}}', body: 'Thank you for dining at {{restaurant_name}}.\n\nOrder: {{order_number}}\nAmount paid: KSh {{amount}}\nPayment method: {{payment_method}}\nReceipt: {{receipt_number}}\n\n{{receipt_text}}' },
  },
  mpesa_receipt: { sms: '{{restaurant_name}}: M-Pesa payment {{mpesa_receipt}} of KSh {{amount}} received for order {{order_number}}. Thank you!' },
  order_confirmation: { sms: 'Hello {{customer_name}}, {{restaurant_name}} has received your order {{order_number}}. Estimated ready time: {{eta}}.' },
  order_ready: { sms: 'Hello {{customer_name}}, your order {{order_number}} from {{restaurant_name}} is ready for collection. Thank you!' },
  delivery_update: { sms: 'Hello {{customer_name}}, your order {{order_number}} is {{delivery_status}}. Track: {{tracking_code}}' },
  reservation_confirmation: {
    sms: 'Hello {{customer_name}}, your table at {{restaurant_name}} is reserved for {{reservation_date}} at {{reservation_time}} for {{guest_count}} guests. Reference: {{reservation_code}}.',
    email: { subject: 'Reservation confirmed — {{restaurant_name}}', body: 'Hello {{customer_name}},\n\nYour table at {{restaurant_name}} is reserved for {{reservation_date}} at {{reservation_time}} for {{guest_count}} guests.\nReference: {{reservation_code}}' },
  },
  reservation_reminder: { sms: 'Reminder: your table at {{restaurant_name}} is booked for today at {{reservation_time}} ({{guest_count}} guests). Ref {{reservation_code}}.' },
  reservation_cancellation: { sms: 'Hello {{customer_name}}, your reservation {{reservation_code}} at {{restaurant_name}} has been cancelled.' },
  loyalty_points: { sms: 'Hi {{customer_name}}, you earned {{points}} points at {{restaurant_name}}. Balance: {{balance}} points.' },
  promotion: { sms: '{{restaurant_name}}: {{message}} Reply STOP to opt out.' },
  manager_sales_summary: {
    sms: '{{restaurant_name}} {{branch_name}} {{date}}: Sales KSh {{total_sales}}, {{order_count}} orders.',
    email: { subject: 'Daily sales summary — {{branch_name}} {{date}}', body: 'Sales: KSh {{total_sales}}\nOrders: {{order_count}}\nAverage order: KSh {{avg_order}}\n\n{{details}}' },
  },
  low_stock_alert: {
    sms: '{{restaurant_name}} {{branch_name}}: low stock — {{items}}',
    email: { subject: 'Low stock alert — {{branch_name}}', body: 'The following items are at or below their minimum level:\n\n{{items}}' },
  },
  staff_attendance: { sms: 'Hi {{employee_name}}, {{event}} recorded at {{time}} ({{branch_name}}).' },
  subscription_expiry: {
    sms: 'Your Chili POS subscription for {{restaurant_name}} expires on {{expiry_date}}. Renew to avoid interruption.',
    email: { subject: 'Your Chili POS subscription expires on {{expiry_date}}', body: 'Hello,\n\nThe {{plan_name}} subscription for {{restaurant_name}} expires on {{expiry_date}}.' },
  },
  integration_failure: { email: { subject: 'Integration failure: {{integration}}', body: 'The {{integration}} integration reported an error at {{time}}:\n\n{{error}}' }, sms: 'Chili POS: {{integration}} integration failing — {{error}}' },
  receipt: { email: { subject: 'Receipt {{receipt_number}} — {{restaurant_name}}', body: '{{receipt_text}}' } },
  invoice: { email: { subject: 'Invoice {{invoice_number}} — {{restaurant_name}}', body: '{{invoice_text}}' } },
  purchase_order: { email: { subject: 'Purchase order {{po_number}} from {{restaurant_name}}', body: 'Dear {{supplier_name}},\n\nPlease supply the following:\n\n{{lines}}\n\nExpected delivery: {{expected_date}}\n\nRegards,\n{{restaurant_name}}' } },
  supplier_payment: { email: { subject: 'Payment notification — {{restaurant_name}}', body: 'Dear {{supplier_name}},\n\nWe have paid KSh {{amount}} against invoice {{invoice_no}}. Reference: {{reference}}.' } },
  password_reset: { email: { subject: 'Reset your Chili POS password', body: 'Hello {{name}},\n\nUse the link below to reset your password. It expires in 30 minutes.\n\n{{reset_link}}\n\nIf you did not request this, ignore this email.' } },
  login_alert: { email: { subject: 'New sign-in to your Chili POS account', body: 'Hello {{name}},\n\nYour account signed in from {{ip}} at {{time}}. If this was not you, reset your password immediately.' } },
  report_export: { email: { subject: '{{report_name}} — {{restaurant_name}}', body: 'Your requested report is attached.' } },
  test: { sms: 'Chili POS test message from {{restaurant_name}}. Your SMS integration works.', email: { subject: 'Chili POS test email', body: 'This is a test email from {{restaurant_name}}. Your SMTP integration is working.' } },
};
