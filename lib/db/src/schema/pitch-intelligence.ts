import {
  boolean,
  date,
  doublePrecision,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const projectStageEnum = pgEnum("project_stage", [
  "research",
  "explore",
  "decide",
  "plan",
  "create",
  "pitch",
]);
export const projectStatusEnum = pgEnum("project_status", [
  "active",
  "on_hold",
  "completed",
]);
export const campaignGeographyEnum = pgEnum("campaign_geography", [
  "DUBAI",
  "ABU_DHABI",
  "UAE",
  "CUSTOM",
]);
export const confidenceEnum = pgEnum("claim_confidence", [
  "confirmed",
  "strongly_indicated",
  "estimated",
  "user_provided",
]);
export const approvalStatusEnum = pgEnum("approval_status", [
  "draft",
  "approved",
  "rejected",
  "superseded",
]);
export const messageRoleEnum = pgEnum("message_role", ["user", "assistant"]);
export const researchRunStatusEnum = pgEnum("research_run_status", [
  "queued",
  "running",
  "awaiting_brand_confirmation",
  "awaiting_competitor_review",
  "partial_success",
  "completed",
  "failed",
]);
export const strategyDecisionStatusEnum = pgEnum("strategy_decision_status", [
  "draft",
  "approved",
  "rejected",
  "edited",
]);
export const claimTypeEnum = pgEnum("claim_type", [
  "verified_fact",
  "reported_claim",
  "estimate",
  "ai_interpretation",
]);
export const projectLocationRoleEnum = pgEnum("project_location_role", ["CLIENT", "COMPETITOR", "POI"]);
export const projectLocationReviewEnum = pgEnum("project_location_review", ["NEEDS_REVIEW", "APPROVED", "REJECTED"]);
export const locationStrategyStatusEnum = pgEnum("location_strategy_status", ["DRAFT", "APPROVED"]);
export const locationRecommendationDecisionEnum = pgEnum("location_recommendation_decision", ["UNREVIEWED", "SHORTLISTED", "REJECTED"]);

export const usersTable = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  displayName: text("display_name").notNull(),
  email: text("email").notNull().unique(),
  ...timestamps,
});

export const clientsTable = pgTable("clients", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  normalizedName: text("normalized_name").notNull().unique(),
  market: text("market").notNull(),
  category: text("category"),
  ...timestamps,
});

export const pitchProjectsTable = pgTable("pitch_projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => usersTable.id),
  clientId: uuid("client_id").notNull().references(() => clientsTable.id),
  title: text("title").notNull(),
  market: text("market").notNull(),
  campaignGeography: campaignGeographyEnum("campaign_geography").notNull().default("DUBAI"),
  campaignAreas: text("campaign_areas").array().notNull().default([]),
  category: text("category"),
  pitchObjective: text("pitch_objective"),
  productFocus: text("product_focus"),
  preferredMedia: text("preferred_media"),
  targetQuantity: integer("target_quantity"),
  stage: projectStageEnum("stage").notNull().default("research"),
  status: projectStatusEnum("status").notNull().default("active"),
  isDemo: boolean("is_demo").notNull().default(false),
  enteredBrandName: text("entered_brand_name"),
  canonicalBrandName: text("canonical_brand_name"),
  officialWebsite: text("official_website"),
  regionalEntity: text("regional_entity"),
  ...timestamps,
});

export const researchRunsTable = pgTable("research_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => pitchProjectsTable.id),
  scope: text("scope").notNull(),
  status: researchRunStatusEnum("status").notNull().default("queued"),
  stage: text("stage").notNull().default("brand_resolution"),
  stages: jsonb("stages").$type<Array<{ key: string; status: string; note?: string }>>().notNull().default([]),
  brand: text("brand"),
  market: text("market"),
  focus: text("focus"),
  brandCandidates: jsonb("brand_candidates").$type<Array<{ name: string; website: string; parent?: string | null; industry?: string | null; sourceUrl?: string | null; evidenceQuote?: string | null; regionalEntity?: string | null; regionalEntityEvidenceQuote?: string | null }>>().notNull().default([]),
  confirmedBrand: jsonb("confirmed_brand").$type<{ name: string; website: string; parent?: string | null; industry?: string | null; sourceUrl?: string | null; evidenceQuote?: string | null; regionalEntity?: string | null; regionalEntityEvidenceQuote?: string | null } | null>(),
  competitorCandidates: jsonb("competitor_candidates").$type<Array<{ name: string; selected: boolean; relevance?: string; sourceUrl?: string | null }>>().notNull().default([]),
  providerUsage: jsonb("provider_usage").$type<Record<string, number | string>>().notNull().default({}),
  coverageSnapshot: jsonb("coverage_snapshot").$type<Record<string, unknown> | null>(),
  coverageSnapshotAt: timestamp("coverage_snapshot_at", { withTimezone: true }),
  coverageSnapshotStatus: text("coverage_snapshot_status", {
    enum: ["captured_at_completion", "backfilled_before_retry", "unavailable"],
  }).notNull().default("unavailable"),
  sourcesFound: integer("sources_found").notNull().default(0),
  claimsGenerated: integer("claims_generated").notNull().default(0),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
  lastAttemptedAt: timestamp("last_attempted_at", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  errorMessage: text("error_message"),
  ...timestamps,
});

export const sourcesTable = pgTable("sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  researchRunId: uuid("research_run_id").references(() => researchRunsTable.id),
  title: text("title").notNull(),
  url: text("url"),
  publisher: text("publisher"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  geography: text("geography"),
  snippet: text("snippet"),
  qualityScore: integer("quality_score"),
  sourceKind: text("source_kind"),
  retrievedAt: timestamp("retrieved_at", { withTimezone: true }).notNull().defaultNow(),
  ...timestamps,
});

export const researchClaimsTable = pgTable("research_claims", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => pitchProjectsTable.id),
  researchRunId: uuid("research_run_id").references(() => researchRunsTable.id),
  sourceId: uuid("source_id").references(() => sourcesTable.id),
  claim: text("claim").notNull(),
  category: text("category").notNull(),
  relatedBrand: text("related_brand"),
  relatedCampaignId: uuid("related_campaign_id"),
  relatedCompetitorId: uuid("related_competitor_id"),
  methodology: text("methodology"),
  claimType: claimTypeEnum("claim_type").notNull().default("ai_interpretation"),
  isDemo: boolean("is_demo").notNull().default(false),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  geography: text("geography").notNull(),
  confidence: confidenceEnum("confidence").notNull(),
  status: approvalStatusEnum("status").notNull().default("draft"),
  ...timestamps,
});

export const claimReviewsTable = pgTable("claim_reviews", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => pitchProjectsTable.id),
  claimId: uuid("claim_id").notNull().references(() => researchClaimsTable.id),
  decision: text("decision", { enum: ["approved", "rejected", "needs_review"] }).notNull(),
  researchNote: text("research_note"),
  additionalSourceUrl: text("additional_source_url"),
  verifiedSourceId: uuid("verified_source_id").references(() => sourcesTable.id),
  verifiedSourceTitle: text("verified_source_title"),
  verifiedSourcePublisher: text("verified_source_publisher"),
  verifiedSourcePublishedAt: timestamp("verified_source_published_at", { withTimezone: true }),
  sourceVerifiedAt: timestamp("source_verified_at", { withTimezone: true }),
  sourceQuote: text("source_quote"),
  quoteVerifiedAt: timestamp("quote_verified_at", { withTimezone: true }),
  originalClaim: text("original_claim").notNull(),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }).notNull().defaultNow(),
});

export const strategyDecisionsTable = pgTable("strategy_decisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => pitchProjectsTable.id),
  researchRunId: uuid("research_run_id").references(() => researchRunsTable.id),
  decisionType: text("decision_type").notNull(),
  recommendation: jsonb("recommendation").$type<Record<string, unknown>>().notNull(),
  rationale: text("rationale").notNull(),
  status: strategyDecisionStatusEnum("status").notNull().default("draft"),
  userRationale: text("user_rationale"),
  evidenceClaimIds: uuid("evidence_claim_ids").array().notNull().default([]),
  isDemo: boolean("is_demo").notNull().default(false),
  ...timestamps,
});

export const competitorsTable = pgTable("competitors", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => pitchProjectsTable.id),
  researchRunId: uuid("research_run_id").references(() => researchRunsTable.id),
  name: text("name").notNull(),
  category: text("category"),
  relevance: text("relevance"),
  positioning: text("positioning"),
  mainProducts: text("main_products"),
  recentMarketing: text("recent_marketing"),
  outdoorActivity: text("outdoor_activity"),
  mainMessage: text("main_message"),
  strengths: text("strengths"),
  observableGaps: text("observable_gaps"),
  currentPromotion: text("current_promotion"),
  doohActivity: text("dooh_activity"),
  transitActivity: text("transit_activity"),
  evidenceClaimIds: uuid("evidence_claim_ids").array().notNull().default([]),
  isDemo: boolean("is_demo").notNull().default(false),
  ...timestamps,
});

export const campaignsTable = pgTable("campaigns", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => pitchProjectsTable.id),
  researchRunId: uuid("research_run_id").references(() => researchRunsTable.id),
  dedupeKey: text("dedupe_key"),
  evidenceStatus: text("evidence_status").notNull().default("insufficient_evidence"),
  name: text("name").notNull(),
  brandOrProduct: text("brand_or_product"),
  productFocus: text("product_focus"),
  startDate: date("start_date", { mode: "string" }),
  endDate: date("end_date", { mode: "string" }),
  medium: text("medium"),
  oohMediumType: text("ooh_medium_type"),
  location: text("location"),
  referenceImageUrl: text("reference_image_url"),
  sourceId: uuid("source_id").references(() => sourcesTable.id),
  sourceIds: uuid("source_ids").array().notNull().default([]),
  isCurrent: boolean("is_current").notNull().default(false),
  geography: text("geography"),
  message: text("message"),
  evidenceQuote: text("evidence_quote"),
  confidence: confidenceEnum("confidence").notNull().default("user_provided"),
  isDemo: boolean("is_demo").notNull().default(false),
  ...timestamps,
}, (table) => [
  uniqueIndex("campaigns_project_dedupe_key_unique").on(table.projectId, table.dedupeKey),
]);

export const inventoryAssetsTable = pgTable("inventory_assets", {
  id: uuid("id").primaryKey().defaultRandom(),
  assetCode: text("asset_code").notNull().unique(),
  assetType: text("asset_type").notNull(),
  sourceFamily: text("source_family").notNull().default("MANUAL"),
  sourceKey: text("source_key").unique(),
  sourceSheet: text("source_sheet"),
  shelterNumber: text("shelter_number"),
  shelterConfiguration: text("shelter_configuration"),
  sourceMediaType: text("source_media_type"),
  powerStatus: text("power_status"),
  lightType: text("light_type"),
  accountability: text("accountability"),
  sourceBusRouteRaw: text("source_bus_route_raw"),
  stopName: text("stop_name"),
  coordinatesRaw: text("coordinates_raw"),
  mupiRaw: text("mupi_raw"),
  sourceMapLink: text("source_map_link"),
  tentativeClient: text("tentative_client"),
  currentClientRaw: text("current_client_raw"),
  artworkRaw: text("artwork_raw"),
  remarks: text("remarks"),
  campaignStartDateRaw: text("campaign_start_date_raw"),
  campaignEndDateRaw: text("campaign_end_date_raw"),
  isActive: boolean("is_active").notNull().default(true),
  sourceLifecycleStatus: text("source_lifecycle_status").notNull().default("ACTIVE"),
  removedDetectedAt: timestamp("removed_detected_at", { withTimezone: true }),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  sourceRecordHash: text("source_record_hash"),
  syncReviewReasons: text("sync_review_reasons").array().notNull().default([]),
  assetTypeOriginal: text("asset_type_original"),
  assetSubtype: text("asset_subtype"),
  assetName: text("asset_name"),
  area: text("area"),
  areaOriginal: text("area_original"),
  areaNormalized: text("area_normalized"),
  road: text("road"),
  roadOriginal: text("road_original"),
  roadNormalized: text("road_normalized"),
  direction: text("direction"),
  emirate: text("emirate"),
  routes: text("routes").array().notNull().default([]),
  depot: text("depot"),
  availability: text("availability"),
  availabilityOriginal: text("availability_original"),
  bookingStatus: text("booking_status"),
  campaign: text("campaign"),
  client: text("client"),
  startDate: date("start_date", { mode: "string" }),
  endDate: date("end_date", { mode: "string" }),
  mediaFormat: text("media_format"),
  dimensions: text("dimensions"),
  displayTechnology: text("display_technology"),
  latitude: doublePrecision("latitude"),
  longitude: doublePrecision("longitude"),
  rate: numeric("rate", { precision: 12, scale: 2 }),
  photoPath: text("photo_path"),
  mapUrl: text("map_url"),
  templatePath: text("template_path"),
  nearbyPois: text("nearby_pois").array().notNull().default([]),
  audienceTags: text("audience_tags").array().notNull().default([]),
  trafficVisibility: jsonb("traffic_visibility").$type<Record<string, unknown>>().notNull().default({}),
  internalNotes: text("internal_notes"),
  sourceImportBatchId: uuid("source_import_batch_id"),
  rawImportData: jsonb("raw_import_data").$type<Record<string, unknown>>().notNull().default({}),
  tags: text("tags").array().notNull().default([]),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  ...timestamps,
}, (table) => [
  uniqueIndex("inventory_assets_asset_code_ci_unique").on(sql`lower(${table.assetCode})`),
]);

export const pointsOfInterestTable = pgTable("points_of_interest", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  category: text("category").notNull(),
  address: text("address"),
  geography: text("geography"),
  latitude: doublePrecision("latitude"),
  longitude: doublePrecision("longitude"),
  sourceId: uuid("source_id").references(() => sourcesTable.id),
  source: text("source"),
  sourceReference: text("source_reference"),
  sourceUrl: text("source_url"),
  retrievedAt: timestamp("retrieved_at", { withTimezone: true }).notNull().defaultNow(),
  brand: text("brand"),
  ...timestamps,
}, (table) => [
  uniqueIndex("points_of_interest_source_reference_unique")
    .on(table.sourceReference)
    .where(sql`${table.sourceReference} IS NOT NULL`),
]);

export const inventoryMediaUnitsTable = pgTable("inventory_media_units", {
  id: uuid("id").primaryKey().defaultRandom(),
  parentInventoryAssetId: uuid("parent_inventory_asset_id").notNull().references(() => inventoryAssetsTable.id),
  unitType: text("unit_type").notNull(),
  format: text("format").notNull(),
  sourceType: text("source_type"),
  availabilityStatus: text("availability_status").notNull().default("UNKNOWN"),
  lifecycleStatus: text("lifecycle_status").notNull().default("ACTIVE"),
  currentClient: text("current_client"),
  campaignStart: date("campaign_start", { mode: "string" }),
  campaignEnd: date("campaign_end", { mode: "string" }),
  internalNotes: text("internal_notes"),
  ...timestamps,
}, (table) => [
  uniqueIndex("inventory_media_unit_parent_type_unique").on(table.parentInventoryAssetId, table.unitType),
]);

export const inventorySyncRunsTable = pgTable("inventory_sync_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceFamily: text("source_family").notNull().default("BUS_SHELTER"),
  status: text("status").notNull(),
  trigger: text("trigger").notNull(),
  sourceTitle: text("source_title"),
  sourceUrl: text("source_url"),
  sourceRows: integer("source_rows").notNull().default(0),
  addedCount: integer("added_count").notNull().default(0),
  updatedCount: integer("updated_count").notNull().default(0),
  unchangedCount: integer("unchanged_count").notNull().default(0),
  removedCount: integer("removed_count").notNull().default(0),
  missingCount: integer("missing_count").notNull().default(0),
  reviewCount: integer("review_count").notNull().default(0),
  duplicateCount: integer("duplicate_count").notNull().default(0),
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const inventorySyncChangesTable = pgTable("inventory_sync_changes", {
  id: uuid("id").primaryKey().defaultRandom(),
  syncRunId: uuid("sync_run_id").notNull().references(() => inventorySyncRunsTable.id),
  inventoryAssetId: uuid("inventory_asset_id").references(() => inventoryAssetsTable.id),
  sourceKey: text("source_key").notNull(),
  changeType: text("change_type").notNull(),
  changedFields: jsonb("changed_fields").$type<Record<string, { before: unknown; after: unknown }>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const inventoryImportBatchesTable = pgTable("inventory_import_batches", {
  id: uuid("id").primaryKey().defaultRandom(),
  fileName: text("file_name"),
  status: text("status", { enum: ["committed"] }).notNull().default("committed"),
  mapping: jsonb("mapping").$type<Record<string, string>>().notNull().default({}),
  rowCount: integer("row_count").notNull().default(0),
  addedCount: integer("added_count").notNull().default(0),
  updatedCount: integer("updated_count").notNull().default(0),
  skippedCount: integer("skipped_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const projectInventorySelectionsTable = pgTable("project_inventory_selections", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => pitchProjectsTable.id),
  inventoryAssetId: uuid("inventory_asset_id").notNull().references(() => inventoryAssetsTable.id),
  inventoryMediaUnitId: uuid("inventory_media_unit_id").references(() => inventoryMediaUnitsTable.id),
  status: text("status", { enum: ["shortlist", "selected", "rejected"] }).notNull().default("shortlist"),
  note: text("note"),
  ...timestamps,
}, (table) => [
  uniqueIndex("project_inventory_selection_shelter_unique").on(table.projectId, table.inventoryAssetId).where(sql`${table.inventoryMediaUnitId} IS NULL`),
  uniqueIndex("project_inventory_selection_unit_unique").on(table.projectId, table.inventoryMediaUnitId),
]);

export const brandLocationsTable = pgTable("brand_locations", {
  id: uuid("id").primaryKey().defaultRandom(),
  brand: text("brand").notNull(),
  name: text("name").notNull(),
  address: text("address"),
  latitude: doublePrecision("latitude"),
  longitude: doublePrecision("longitude"),
  source: text("source"),
  ...timestamps,
});

export const competitorLocationsTable = pgTable("competitor_locations", {
  id: uuid("id").primaryKey().defaultRandom(),
  competitor: text("competitor").notNull(),
  name: text("name").notNull(),
  address: text("address"),
  latitude: doublePrecision("latitude"),
  longitude: doublePrecision("longitude"),
  source: text("source"),
  ...timestamps,
});

export const catchmentsTable = pgTable("catchments", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").references(() => pitchProjectsTable.id),
  name: text("name").notNull(),
  centerLatitude: doublePrecision("center_latitude"),
  centerLongitude: doublePrecision("center_longitude"),
  radiusMeters: integer("radius_meters"),
  geometry: jsonb("geometry").$type<Record<string, unknown> | null>(),
  ...timestamps,
});

export const projectLocationStrategiesTable = pgTable("project_location_strategies", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => pitchProjectsTable.id).unique(),
  categories: jsonb("categories").$type<Array<{ name: string; priority: number }>>().notNull().default([]),
  targetAreas: text("target_areas").array().notNull().default([]),
  targetRoads: text("target_roads").array().notNull().default([]),
  audience: text("audience"),
  preferredFormats: text("preferred_formats").array().notNull().default([]),
  campaignScale: text("campaign_scale", { enum: ["FOCUSED", "BALANCED", "HIGH_PRESENCE"] }).notNull().default("BALANCED"),
  status: locationStrategyStatusEnum("status").notNull().default("DRAFT"),
  ...timestamps,
});

export const projectLocationsTable = pgTable("project_locations", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => pitchProjectsTable.id),
  poiId: uuid("poi_id").references(() => pointsOfInterestTable.id),
  role: projectLocationRoleEnum("role").notNull(),
  name: text("name").notNull(),
  brand: text("brand"),
  category: text("category").notNull(),
  address: text("address"),
  locationType: text("location_type", {
    enum: [
      "BRAND_STORE",
      "AUTHORIZED_RETAILER",
      "DEALER_DISTRIBUTOR",
      "CAMPAIGN_ACTIVATION_LOCATION",
      "EXHIBITION_VENUE",
      "UNVERIFIED_CANDIDATE",
    ],
  }).notNull().default("UNVERIFIED_CANDIDATE"),
  latitude: doublePrecision("latitude"),
  longitude: doublePrecision("longitude"),
  coordinatesSourceUrl: text("coordinates_source_url"),
  area: text("area"),
  provider: text("provider"),
  providerId: text("provider_id"),
  sourceReference: text("source_reference"),
  sourceUrl: text("source_url"),
  evidence: text("evidence"),
  evidenceType: text("evidence_type", {
    enum: [
      "HISENSE_OFFICIAL_STORE_LOCATOR",
      "HISENSE_OFFICIAL_CAMPAIGN_PAGE",
      "HISENSE_OFFICIAL_TERMS_PDF",
      "HISENSE_OFFICIAL_RETAILER_LIST",
      "HISENSE_OFFICIAL_NEWSROOM",
      "OFFICIAL_MALL_DIRECTORY",
      "MAP_DIRECTORY",
      "USER_PROVIDED",
      "OTHER",
    ],
  }),
  evidenceStatus: text("evidence_status", {
    enum: [
      "OFFICIAL_SOURCE_VERIFIED",
      "OFFICIAL_TEXT_COORDINATES_UNVERIFIED",
      "NEEDS_SOURCE_VERIFICATION",
      "USER_PROVIDED",
    ],
  }).notNull().default("NEEDS_SOURCE_VERIFICATION"),
  sourceDate: date("source_date", { mode: "string" }),
  retrievedAt: timestamp("retrieved_at", { withTimezone: true }).notNull().defaultNow(),
  confidence: text("confidence", { enum: ["LIKELY", "NEEDS_REVIEW", "USER_PROVIDED"] }).notNull(),
  reviewStatus: projectLocationReviewEnum("review_status").notNull().default("NEEDS_REVIEW"),
  reviewNote: text("review_note"),
  ...timestamps,
}, (table) => [
  uniqueIndex("project_locations_provider_dedupe").on(table.projectId, table.role, table.provider, table.providerId),
]);

export const assetPoiRelationshipsTable = pgTable("asset_poi_relationships", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => pitchProjectsTable.id),
  inventoryAssetId: uuid("inventory_asset_id").notNull().references(() => inventoryAssetsTable.id),
  poiId: uuid("poi_id").notNull().references(() => projectLocationsTable.id),
  relationshipType: text("relationship_type", { enum: ["CLIENT", "COMPETITOR", "POI"] }).notNull(),
  radiusMeters: integer("radius_meters").notNull(),
  distanceMeters: doublePrecision("distance_meters").notNull(),
  ...timestamps,
}, (table) => [
  uniqueIndex("asset_poi_relationship_unique").on(table.projectId, table.inventoryAssetId, table.poiId, table.radiusMeters),
]);

export const locationRecommendationsTable = pgTable("location_recommendations", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => pitchProjectsTable.id),
  inventoryAssetId: uuid("inventory_asset_id").references(() => inventoryAssetsTable.id),
  inventoryMediaUnitId: uuid("inventory_media_unit_id").references(() => inventoryMediaUnitsTable.id),
  matchingRadiusMeters: integer("matching_radius_meters").notNull().default(500),
  area: text("area").notNull(),
  rationale: text("rationale").notNull(),
  fitScore: integer("fit_score"),
  reasons: jsonb("reasons").$type<string[]>().notNull().default([]),
  explanation: jsonb("explanation").$type<Record<string, unknown>>().notNull().default({}),
  missingInformation: text("missing_information").array().notNull().default([]),
  scoringVersion: text("scoring_version").notNull().default("location-v1"),
  decision: locationRecommendationDecisionEnum("decision").notNull().default("UNREVIEWED"),
  decisionReason: text("decision_reason"),
  decisionNote: text("decision_note"),
  isSelected: boolean("is_selected").notNull().default(false),
  isCurrent: boolean("is_current").notNull().default(false),
  ...timestamps,
}, (table) => [
  uniqueIndex("location_recommendations_project_unit_radius_unique").on(table.projectId, table.inventoryMediaUnitId, table.matchingRadiusMeters),
]);

export const locationRouteRecommendationsTable = pgTable("location_route_recommendations", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => pitchProjectsTable.id),
  sourceVariantId: uuid("source_variant_id").notNull(),
  routeId: text("route_id").notNull(),
  score: integer("score").notNull(),
  suggestedQuantity: integer("suggested_quantity").notNull(),
  scoringVersion: text("scoring_version").notNull().default("location-route-v1"),
  explanation: jsonb("explanation").$type<Record<string, unknown>>().notNull().default({}),
  missingInformation: text("missing_information").array().notNull().default([]),
  decision: locationRecommendationDecisionEnum("decision").notNull().default("UNREVIEWED"),
  decisionReason: text("decision_reason"),
  decisionNote: text("decision_note"),
  isCurrent: boolean("is_current").notNull().default(false),
  ...timestamps,
}, (table) => [
  uniqueIndex("location_route_recommendation_project_variant_unique").on(table.projectId, table.sourceVariantId),
]);

export const assetScoresTable = pgTable("asset_scores", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => pitchProjectsTable.id),
  inventoryAssetId: uuid("inventory_asset_id").notNull().references(() => inventoryAssetsTable.id),
  score: integer("score").notNull(),
  reasons: jsonb("reasons").$type<string[]>().notNull().default([]),
  ...timestamps,
});

export const conversationsTable = pgTable("conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => pitchProjectsTable.id).unique(),
  title: text("title").notNull().default("Project Copilot"),
  ...timestamps,
});

export const conversationMessagesTable = pgTable("conversation_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  conversationId: uuid("conversation_id").notNull().references(() => conversationsTable.id),
  role: messageRoleEnum("role").notNull(),
  content: text("content").notNull(),
  isPlaceholder: boolean("is_placeholder").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const mockupsTable = pgTable("mockups", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => pitchProjectsTable.id),
  name: text("name").notNull(),
  assetType: text("asset_type"),
  sourcePath: text("source_path"),
  outputPath: text("output_path"),
  status: approvalStatusEnum("status").notNull().default("draft"),
  generationMetadata: jsonb("generation_metadata").$type<Record<string, unknown>>().notNull().default({}),
  ...timestamps,
});

export const decksTable = pgTable("decks", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => pitchProjectsTable.id).unique(),
  title: text("title").notNull(),
  status: approvalStatusEnum("status").notNull().default("draft"),
  ...timestamps,
});

export const deckSlidesTable = pgTable("deck_slides", {
  id: uuid("id").primaryKey().defaultRandom(),
  deckId: uuid("deck_id").notNull().references(() => decksTable.id),
  sortOrder: integer("sort_order").notNull(),
  title: text("title").notNull(),
  content: jsonb("content").$type<Record<string, unknown>>().notNull().default({}),
  isHidden: boolean("is_hidden").notNull().default(false),
  ...timestamps,
});

export const insertProjectSchema = createInsertSchema(pitchProjectsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertProject = z.infer<typeof insertProjectSchema>;
export type PitchProjectRecord = typeof pitchProjectsTable.$inferSelect;