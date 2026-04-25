# Phase 1 Database Schema

## shops
- id: String @id @default(uuid())
- shopifyDomain: String @unique
- accessToken: String
- maxConcurrentTests: Int @default(5)
- requireHumanApproval: Boolean @default(false)
- brandGuardrails: Json?
- slackWebhookUrl: String?
- installedAt: DateTime @default(now())
- timezone: String @default("UTC")

## experiments
- id: String @id @default(uuid())
- shopId: String (FK → shops)
- name: String
- hypothesis: String
- pageType: String (product | collection | cart | homepage | any)
- elementType: String (headline | cta | image | layout | trust | price | other)
- targetMetric: String (conversion_rate | add_to_cart_rate | revenue_per_visitor)
- status: String @default("draft") (draft | active | paused | concluded)
- trafficSplit: Float @default(0.5)
- minRuntimeDays: Int @default(7)
- maxRuntimeDays: Int @default(28)
- startedAt: DateTime?
- concludedAt: DateTime?
- createdAt: DateTime @default(now())
- updatedAt: DateTime @updatedAt
- shopId indexed

## variants
- id: String @id @default(uuid())
- experimentId: String (FK → experiments)
- type: String (control | treatment)
- name: String
- description: String
- htmlPatch: String?
- cssPatch: String?
- jsPatch: String?
- themeExtensionHandle: String?
- createdAt: DateTime @default(now())

## events
- id: String @id @default(uuid())
- experimentId: String (FK → experiments)
- variantId: String (FK → variants)
- visitorId: String (hashed — no PII)
- sessionId: String
- eventType: String (view | add_to_cart | checkout_started | purchase)
- revenue: Float?
- occurredAt: DateTime @default(now())
- Index on experimentId
- Index on occurredAt
- Index on visitorId

## results
- id: String @id @default(uuid())
- experimentId: String @unique (FK → experiments)
- computedAt: DateTime
- controlVisitors: Int @default(0)
- treatmentVisitors: Int @default(0)
- controlConversions: Int @default(0)
- treatmentConversions: Int @default(0)
- controlRevenue: Float @default(0)
- treatmentRevenue: Float @default(0)
- controlConversionRate: Float @default(0)
- treatmentConversionRate: Float @default(0)
- relativeLift: Float?
- pValue: Float?
- isSignificant: Boolean @default(false)
- guardrailStatus: String @default("ok") (ok | aov_tripped)
- decision: String? (null | ship_winner | kill | inconclusive)
- decisionMadeAt: DateTime?