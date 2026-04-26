# Database Schema

## Phase 1 tables

### shops
- id: String @id @default(uuid())
- shopifyDomain: String @unique
- accessToken: String
- maxConcurrentTests: Int @default(5)
- requireHumanApproval: Boolean @default(false)
- brandGuardrails: Json? (also stores _latestDataSnapshot for research pipeline)
- slackWebhookUrl: String?
- installedAt: DateTime @default(now())
- timezone: String @default("UTC")

### experiments
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
- Index on shopId

### variants
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

### events
- id: String @id @default(uuid())
- experimentId: String (FK → experiments)
- variantId: String (FK → variants)
- visitorId: String (hashed — no PII)
- sessionId: String
- eventType: String (view | add_to_cart | checkout_started | purchase)
- revenue: Float?
- checkoutToken: String? (for orders/paid webhook attribution)
- occurredAt: DateTime @default(now())
- Index on experimentId, occurredAt, visitorId

### results
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
- pValue: Float? (null — Bayesian mode; kept for schema compat)
- probToBeatControl: Float? (Phase 2: Bayesian P(treatment > control))
- isSignificant: Boolean @default(false) (true when probToBeatControl >= 0.95)
- guardrailStatus: String @default("ok") (ok | aov_tripped)
- decision: String? (null | ship_winner | kill | inconclusive)
- decisionMadeAt: DateTime?

---

## Phase 2 tables

### data_sources
- id: String @id @default(uuid())
- shopId: String (FK → shops)
- type: String (ga4 | shopify_admin)
- config: Json (GA4: { propertyId, serviceAccountKey } — serviceAccountKey is base64-encoded service account JSON)
- lastSyncedAt: DateTime?
- createdAt: DateTime @default(now())
- Index on shopId

### research_reports
- id: String @id @default(uuid())
- shopId: String (FK → shops)
- generatedAt: DateTime @default(now())
- dataSnapshot: Json (assembled metrics snapshot at time of generation)
- reportMd: String (Claude's markdown friction-point analysis)
- status: String @default("pending") (pending | complete | failed)
- Index on shopId

### hypotheses
- id: String @id @default(uuid())
- shopId: String (FK → shops)
- reportId: String? (FK → research_reports)
- title: String (short, 5-8 words)
- hypothesis: String (full "We believe..." statement)
- pageType: String
- elementType: String
- targetMetric: String
- iceImpact: Int (1-10)
- iceConfidence: Int (1-10)
- iceEase: Int (1-10)
- iceScore: Float (impact * confidence * ease, max 1000)
- status: String @default("backlog") (backlog | promoted | rejected)
- promotedExperimentId: String? (FK → experiments, set when promoted)
- createdAt: DateTime @default(now())
- Index on shopId, iceScore

### knowledge_base
- id: String @id @default(uuid())
- shopId: String (FK → shops)
- experimentId: String @unique (FK → experiments)
- hypothesisText: String
- segmentTargeted: String?
- variantDescription: String
- result: String (win | loss | inconclusive)
- liftPercentage: Float?
- pageType: String
- elementType: String
- tags: String[] (e.g. ["cta", "win", "social_proof"])
- embedding: vector(1536)? (pgvector — populated by embeddings job once ANTHROPIC_API_KEY is set)
- createdAt: DateTime @default(now())
- Index on shopId

---

## Phase 3 tables (planned)

### segments
- id, shopId, name, deviceType, trafficSource, visitorType,
  geoCountry[], geoRegion[], timeOfDay{from,to}, dayOfWeek[],
  productCategory[], cartState, customerTags[]

### orchestrator_log
- id, shopId, stage (RESEARCH|HYPOTHESIS|BUILD|QA|ACTIVATE|MONITOR|DECIDE|SHIP),
  status, payload, startedAt, completedAt
