# Riwaq catalogue and Wuilt order bridge

Prepared, tested integration. No production webhook or outbound identity is activated by this change. The owner chose to supply the Riwaq WhatsApp number later. Existing education contacts and WhatsApp settings are not reused.

## Order flow

Wuilt sends `ORDER_PLACED`, `ORDER_UPDATED`, `ORDER_CANCELED`, and `SHIPMENT_UPDATED` notifications to one HTTPS endpoint. Save each webhook in Wuilt Dev tools → Notifications webhooks, JSON, API v1.0. The endpoint is `/webhooks/wuilt/<64 lowercase hex token>`. Treat the entire URL as a credential: do not publish it, include it in screenshots, or record request URLs in access logs. Wuilt's documented UI does not expose a signing secret or custom authorization header, so the high-entropy URL authenticates this endpoint. Before enabling, confirm the store-to-CRM access with the owner and verify hosting access-log redaction. Configure a fresh random token securely in the hosting environment; none is committed here.

`RIWAQ_WUILT_ENABLED=1` and `RIWAQ_WUILT_WEBHOOK_TOKEN=<secret>` enable receipt. Store ID is restricted to `Store_cmvy9cgt601fk01jre9un4st8` in both metadata and order. A committed database transaction precedes HTTP 200. SHA-256 replay detection and unique order/message keys prevent duplicate records. Separate order and shipment timestamps tolerate delivery order differences. Cancellation and final shipment states suppress obsolete pending messages. Wuilt owns stock and payment truth; this bridge does not decrement inventory, capture payments or create shipments.

Customer profiles and order snapshots are AES-256-GCM encrypted with the server key. Back up that key alongside the database using the existing protected backup process. Commerce records are separate tables and are owner-only at `/api/commerce` and `/commerce`. No existing contacts are merged by phone. Consent is recorded at `/api/commerce/consent` with actual evidence; newsletter subscription is not WhatsApp consent. Pending messages are not released by default.

## Dedicated WhatsApp setup, after the number is supplied

Use a registered WhatsApp Business Platform number and a token with messaging permission. Set only the dedicated `RIWAQ_WHATSAPP_*` variables; existing `META_*` education settings are deliberately not a fallback:

| Variable | Purpose |
| --- | --- |
| `RIWAQ_WHATSAPP_ENABLED` | Set `1` only after setup and owner-approved end-to-end testing |
| `RIWAQ_WHATSAPP_PHONE_ID` | Registered number ID, digits |
| `RIWAQ_WHATSAPP_ACCESS_TOKEN` | Private messaging token |
| `RIWAQ_WHATSAPP_VERSION` | Supported Graph API version, e.g. `vNN.0`; confirm in Meta at setup |
| `RIWAQ_WHATSAPP_LANGUAGE` | Approved template language; defaults to `ar` |
| `RIWAQ_WHATSAPP_TEMPLATE_ORDER` | Approved order template name |
| `RIWAQ_WHATSAPP_TEMPLATE_SHIPPED` | Approved shipment template name |
| `RIWAQ_WHATSAPP_TEMPLATES_APPROVED` | Set `1` only after Meta approval |

Suggested utility template drafts (submit for approval on the chosen Riwaq account):

* `riwaq_order_confirmation`: «رِواق — استلمنا طلبك رقم {{1}} بإجمالي {{2}}. الطلب قيد المراجعة والتجهيز. سنرسل تحديث الشحن بعد تسليم الشحنة لشركة الشحن.» Body variables: order serial, total with currency.
* `riwaq_shipment_update`: «رِواق — تم تسليم طلبك رقم {{1}} لشركة الشحن. رقم التتبع: {{2}}. شركة الشحن: {{3}}.» Body variables: order serial, tracking number, carrier.

`OrderShipmentPickedUp` and `OrderShipmentIsOnTheWay` make shipment notification eligible. `ORDER_PLACED` never means shipped. Check that these Wuilt events match the selected carrier's actual pickup semantics before activation. The dispatcher reads the saved recipient, requires explicit opted-in consent, sends one approved template and records Meta's message ID as **accepted**, never delivered. Network ambiguity or process interruption moves to **unknown** and is not retried automatically. Provider rejection is **failed**. Incoming opt-out and Meta delivery-status callbacks are not wired to the dedicated account yet; finish those when registering the number, before enabling outbound. Owner consent withdrawal immediately blocks pending sends. Do not use these transactional messages for marketing.

## Validation and activation checklist

Run `node --test tests/commerce.test.mjs` and `npm test`. In staging, use synthetic payloads to test authenticated receipt, replay, wrong store, cancellation, shipment-before-order, consent withdrawal and ambiguous send. Then select the real Riwaq number, add a visible optional checkout opt-in with wording and timestamp evidence, register/approve the templates, connect the account's incoming opt-out and delivery callbacks, confirm pickup/carrier settings, and run one owner-authorized real checkout/message before switching either integration on. The deployment remains disabled until this final setup.

Primary references: https://store-docs.wuilt.com/docs/webhooks ; https://www.postman.com/meta/whatsapp-business-platform/overview ; https://business.whatsapp.com/policy
