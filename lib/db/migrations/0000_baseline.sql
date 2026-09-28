CREATE TYPE "public"."approval_status" AS ENUM('draft', 'approved', 'rejected', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."campaign_geography" AS ENUM('DUBAI', 'ABU_DHABI', 'UAE', 'CUSTOM');--> statement-breakpoint
CREATE TYPE "public"."claim_type" AS ENUM('verified_fact', 'reported_claim', 'estimate', 'ai_interpretation');--> statement-breakpoint
CREATE TYPE "public"."claim_confidence" AS ENUM('confirmed', 'strongly_indicated', 'estimated', 'user_provided');--> statement-breakpoint
CREATE TYPE "public"."location_recommendation_decision" AS ENUM('UNREVIEWED', 'SHORTLISTED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."location_strategy_status" AS ENUM('DRAFT', 'APPROVED');--> statement-breakpoint
CREATE TYPE "public"."message_role" AS ENUM('user', 'assistant');--> statement-breakpoint
CREATE TYPE "public"."project_location_review" AS ENUM('NEEDS_REVIEW', 'APPROVED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."project_location_role" AS ENUM('CLIENT', 'COMPETITOR', 'POI');--> statement-breakpoint
CREATE TYPE "public"."project_stage" AS ENUM('research', 'explore', 'decide', 'plan', 'create', 'pitch');--> statement-breakpoint
CREATE TYPE "public"."project_status" AS ENUM('active', 'on_hold', 'completed');--> statement-breakpoint
CREATE TYPE "public"."research_run_status" AS ENUM('queued', 'running', 'awaiting_brand_confirmation', 'awaiting_competitor_review', 'partial_success', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."strategy_decision_status" AS ENUM('draft', 'approved', 'rejected', 'edited');--> statement-breakpoint
CREATE TYPE "public"."passenger_metric_mapping_status" AS ENUM('MATCHED_VARIANT', 'ROUTE_LEVEL_ONLY', 'UNMATCHED', 'CONFLICT');--> statement-breakpoint
CREATE TABLE "asset_poi_relationships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"inventory_asset_id" uuid NOT NULL,
	"poi_id" uuid NOT NULL,
	"relationship_type" text NOT NULL,
	"radius_meters" integer NOT NULL,
	"distance_meters" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "asset_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"inventory_asset_id" uuid NOT NULL,
	"score" integer NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brand_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brand" text NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"latitude" double precision,
	"longitude" double precision,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"research_run_id" uuid,
	"dedupe_key" text,
	"evidence_status" text DEFAULT 'insufficient_evidence' NOT NULL,
	"name" text NOT NULL,
	"brand_or_product" text,
	"product_focus" text,
	"start_date" date,
	"end_date" date,
	"medium" text,
	"ooh_medium_type" text,
	"location" text,
	"reference_image_url" text,
	"source_id" uuid,
	"source_ids" uuid[] DEFAULT '{}' NOT NULL,
	"is_current" boolean DEFAULT false NOT NULL,
	"geography" text,
	"message" text,
	"evidence_quote" text,
	"confidence" "claim_confidence" DEFAULT 'user_provided' NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catchments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"name" text NOT NULL,
	"center_latitude" double precision,
	"center_longitude" double precision,
	"radius_meters" integer,
	"geometry" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claim_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"claim_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"research_note" text,
	"additional_source_url" text,
	"verified_source_id" uuid,
	"verified_source_title" text,
	"verified_source_publisher" text,
	"verified_source_published_at" timestamp with time zone,
	"source_verified_at" timestamp with time zone,
	"source_quote" text,
	"quote_verified_at" timestamp with time zone,
	"original_claim" text NOT NULL,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"market" text NOT NULL,
	"category" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clients_normalized_name_unique" UNIQUE("normalized_name")
);
--> statement-breakpoint
CREATE TABLE "competitor_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"competitor" text NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"latitude" double precision,
	"longitude" double precision,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competitors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"research_run_id" uuid,
	"name" text NOT NULL,
	"category" text,
	"relevance" text,
	"positioning" text,
	"main_products" text,
	"recent_marketing" text,
	"outdoor_activity" text,
	"main_message" text,
	"strengths" text,
	"observable_gaps" text,
	"current_promotion" text,
	"dooh_activity" text,
	"transit_activity" text,
	"evidence_claim_ids" uuid[] DEFAULT '{}' NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" "message_role" NOT NULL,
	"content" text NOT NULL,
	"is_placeholder" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text DEFAULT 'Project Copilot' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_project_id_unique" UNIQUE("project_id")
);
--> statement-breakpoint
CREATE TABLE "deck_slides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deck_id" uuid NOT NULL,
	"sort_order" integer NOT NULL,
	"title" text NOT NULL,
	"content" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_hidden" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"status" "approval_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "decks_project_id_unique" UNIQUE("project_id")
);
--> statement-breakpoint
CREATE TABLE "inventory_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_code" text NOT NULL,
	"asset_type" text NOT NULL,
	"source_family" text DEFAULT 'MANUAL' NOT NULL,
	"source_key" text,
	"source_sheet" text,
	"shelter_number" text,
	"shelter_configuration" text,
	"source_media_type" text,
	"power_status" text,
	"light_type" text,
	"accountability" text,
	"source_bus_route_raw" text,
	"stop_name" text,
	"coordinates_raw" text,
	"mupi_raw" text,
	"source_map_link" text,
	"tentative_client" text,
	"current_client_raw" text,
	"artwork_raw" text,
	"remarks" text,
	"campaign_start_date_raw" text,
	"campaign_end_date_raw" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"source_lifecycle_status" text DEFAULT 'ACTIVE' NOT NULL,
	"removed_detected_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"source_record_hash" text,
	"sync_review_reasons" text[] DEFAULT '{}' NOT NULL,
	"asset_type_original" text,
	"asset_subtype" text,
	"asset_name" text,
	"area" text,
	"area_original" text,
	"area_normalized" text,
	"road" text,
	"road_original" text,
	"road_normalized" text,
	"direction" text,
	"emirate" text,
	"routes" text[] DEFAULT '{}' NOT NULL,
	"depot" text,
	"availability" text,
	"availability_original" text,
	"booking_status" text,
	"campaign" text,
	"client" text,
	"start_date" date,
	"end_date" date,
	"media_format" text,
	"dimensions" text,
	"display_technology" text,
	"latitude" double precision,
	"longitude" double precision,
	"rate" numeric(12, 2),
	"photo_path" text,
	"map_url" text,
	"template_path" text,
	"nearby_pois" text[] DEFAULT '{}' NOT NULL,
	"audience_tags" text[] DEFAULT '{}' NOT NULL,
	"traffic_visibility" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"internal_notes" text,
	"source_import_batch_id" uuid,
	"raw_import_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_assets_asset_code_unique" UNIQUE("asset_code"),
	CONSTRAINT "inventory_assets_source_key_unique" UNIQUE("source_key")
);
--> statement-breakpoint
CREATE TABLE "inventory_import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_name" text,
	"status" text DEFAULT 'committed' NOT NULL,
	"mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"added_count" integer DEFAULT 0 NOT NULL,
	"updated_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_media_units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_inventory_asset_id" uuid NOT NULL,
	"unit_type" text NOT NULL,
	"format" text NOT NULL,
	"source_type" text,
	"availability_status" text DEFAULT 'UNKNOWN' NOT NULL,
	"lifecycle_status" text DEFAULT 'ACTIVE' NOT NULL,
	"current_client" text,
	"campaign_start" date,
	"campaign_end" date,
	"internal_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_sync_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sync_run_id" uuid NOT NULL,
	"inventory_asset_id" uuid,
	"source_key" text NOT NULL,
	"change_type" text NOT NULL,
	"changed_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_family" text DEFAULT 'BUS_SHELTER' NOT NULL,
	"status" text NOT NULL,
	"trigger" text NOT NULL,
	"source_title" text,
	"source_url" text,
	"source_rows" integer DEFAULT 0 NOT NULL,
	"added_count" integer DEFAULT 0 NOT NULL,
	"updated_count" integer DEFAULT 0 NOT NULL,
	"unchanged_count" integer DEFAULT 0 NOT NULL,
	"removed_count" integer DEFAULT 0 NOT NULL,
	"missing_count" integer DEFAULT 0 NOT NULL,
	"review_count" integer DEFAULT 0 NOT NULL,
	"duplicate_count" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "location_recommendations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"inventory_asset_id" uuid,
	"inventory_media_unit_id" uuid,
	"matching_radius_meters" integer DEFAULT 500 NOT NULL,
	"area" text NOT NULL,
	"rationale" text NOT NULL,
	"fit_score" integer,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"explanation" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"missing_information" text[] DEFAULT '{}' NOT NULL,
	"scoring_version" text DEFAULT 'location-v1' NOT NULL,
	"decision" "location_recommendation_decision" DEFAULT 'UNREVIEWED' NOT NULL,
	"decision_reason" text,
	"decision_note" text,
	"is_selected" boolean DEFAULT false NOT NULL,
	"is_current" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "location_route_recommendations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"source_variant_id" uuid NOT NULL,
	"route_id" text NOT NULL,
	"score" integer NOT NULL,
	"suggested_quantity" integer NOT NULL,
	"scoring_version" text DEFAULT 'location-route-v1' NOT NULL,
	"explanation" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"missing_information" text[] DEFAULT '{}' NOT NULL,
	"decision" "location_recommendation_decision" DEFAULT 'UNREVIEWED' NOT NULL,
	"decision_reason" text,
	"decision_note" text,
	"is_current" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mockups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"asset_type" text,
	"source_path" text,
	"output_path" text,
	"status" "approval_status" DEFAULT 'draft' NOT NULL,
	"generation_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pitch_projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"title" text NOT NULL,
	"market" text NOT NULL,
	"campaign_geography" "campaign_geography" DEFAULT 'DUBAI' NOT NULL,
	"campaign_areas" text[] DEFAULT '{}' NOT NULL,
	"category" text,
	"pitch_objective" text,
	"product_focus" text,
	"preferred_media" text,
	"target_quantity" integer,
	"stage" "project_stage" DEFAULT 'research' NOT NULL,
	"status" "project_status" DEFAULT 'active' NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"entered_brand_name" text,
	"canonical_brand_name" text,
	"official_website" text,
	"regional_entity" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "points_of_interest" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"address" text,
	"geography" text,
	"latitude" double precision,
	"longitude" double precision,
	"source_id" uuid,
	"source" text,
	"source_reference" text,
	"source_url" text,
	"retrieved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"brand" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_inventory_selections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"inventory_asset_id" uuid NOT NULL,
	"inventory_media_unit_id" uuid,
	"status" text DEFAULT 'shortlist' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_location_strategies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"target_areas" text[] DEFAULT '{}' NOT NULL,
	"target_roads" text[] DEFAULT '{}' NOT NULL,
	"audience" text,
	"preferred_formats" text[] DEFAULT '{}' NOT NULL,
	"campaign_scale" text DEFAULT 'BALANCED' NOT NULL,
	"status" "location_strategy_status" DEFAULT 'DRAFT' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_location_strategies_project_id_unique" UNIQUE("project_id")
);
--> statement-breakpoint
CREATE TABLE "project_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"poi_id" uuid,
	"role" "project_location_role" NOT NULL,
	"name" text NOT NULL,
	"brand" text,
	"category" text NOT NULL,
	"address" text,
	"location_type" text DEFAULT 'UNVERIFIED_CANDIDATE' NOT NULL,
	"latitude" double precision,
	"longitude" double precision,
	"coordinates_source_url" text,
	"area" text,
	"provider" text,
	"provider_id" text,
	"source_reference" text,
	"source_url" text,
	"evidence" text,
	"evidence_type" text,
	"evidence_status" text DEFAULT 'NEEDS_SOURCE_VERIFICATION' NOT NULL,
	"source_date" date,
	"retrieved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confidence" text NOT NULL,
	"review_status" "project_location_review" DEFAULT 'NEEDS_REVIEW' NOT NULL,
	"review_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"research_run_id" uuid,
	"source_id" uuid,
	"claim" text NOT NULL,
	"category" text NOT NULL,
	"related_brand" text,
	"related_campaign_id" uuid,
	"related_competitor_id" uuid,
	"methodology" text,
	"claim_type" "claim_type" DEFAULT 'ai_interpretation' NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"published_at" timestamp with time zone,
	"geography" text NOT NULL,
	"confidence" "claim_confidence" NOT NULL,
	"status" "approval_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"status" "research_run_status" DEFAULT 'queued' NOT NULL,
	"stage" text DEFAULT 'brand_resolution' NOT NULL,
	"stages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"brand" text,
	"market" text,
	"focus" text,
	"brand_candidates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confirmed_brand" jsonb,
	"competitor_candidates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provider_usage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"coverage_snapshot" jsonb,
	"coverage_snapshot_at" timestamp with time zone,
	"coverage_snapshot_status" text DEFAULT 'unavailable' NOT NULL,
	"sources_found" integer DEFAULT 0 NOT NULL,
	"claims_generated" integer DEFAULT 0 NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_attempted_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"research_run_id" uuid,
	"title" text NOT NULL,
	"url" text,
	"publisher" text,
	"published_at" timestamp with time zone,
	"geography" text,
	"snippet" text,
	"quality_score" integer,
	"source_kind" text,
	"retrieved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "strategy_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"research_run_id" uuid,
	"decision_type" text NOT NULL,
	"recommendation" jsonb NOT NULL,
	"rationale" text NOT NULL,
	"status" "strategy_decision_status" DEFAULT 'draft' NOT NULL,
	"user_rationale" text,
	"evidence_claim_ids" uuid[] DEFAULT '{}' NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "bus_plan_override_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"selection_id" uuid NOT NULL,
	"prior_quantity" integer,
	"proposed_quantity" integer NOT NULL,
	"source_bus_count_snapshot" integer,
	"reason" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bus_plan_override_event_prior_quantity_positive" CHECK ("bus_plan_override_events"."prior_quantity" IS NULL OR "bus_plan_override_events"."prior_quantity" > 0),
	CONSTRAINT "bus_plan_override_event_proposed_quantity_positive" CHECK ("bus_plan_override_events"."proposed_quantity" > 0),
	CONSTRAINT "bus_plan_override_event_source_count_nonnegative" CHECK ("bus_plan_override_events"."source_bus_count_snapshot" IS NULL OR "bus_plan_override_events"."source_bus_count_snapshot" >= 0),
	CONSTRAINT "bus_plan_override_event_reason_nonempty" CHECK (length(trim("bus_plan_override_events"."reason")) > 0)
);
--> statement-breakpoint
CREATE TABLE "bus_route_source_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bus_route_id" uuid NOT NULL,
	"sheet_name" text NOT NULL,
	"source_identity" text NOT NULL,
	"source_row_number" integer NOT NULL,
	"allocated_bus_count" integer,
	"raw_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bus_route_sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" text NOT NULL,
	"trigger" text NOT NULL,
	"source_title" text,
	"discovered_sheets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"skipped_sheets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_rows" integer DEFAULT 0 NOT NULL,
	"distinct_routes" integer DEFAULT 0 NOT NULL,
	"added_count" integer DEFAULT 0 NOT NULL,
	"updated_count" integer DEFAULT 0 NOT NULL,
	"unchanged_count" integer DEFAULT 0 NOT NULL,
	"inactive_count" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "bus_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"normalized_route_id" text NOT NULL,
	"route_id" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bus_routes_normalized_route_id_unique" UNIQUE("normalized_route_id")
);
--> statement-breakpoint
CREATE TABLE "bus_vehicle_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"body_number" text NOT NULL,
	"inventory_asset_id" uuid,
	"depot" text,
	"plate_number" text,
	"client" text,
	"installation_status" text,
	"campaign" text,
	"availability" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bus_vehicle_profiles_body_number_unique" UNIQUE("body_number")
);
--> statement-breakpoint
CREATE TABLE "bus_vehicle_route_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"bus_route_id" uuid NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unassigned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_bus_route_selections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"source_variant_id" uuid NOT NULL,
	"proposed_quantity" integer NOT NULL,
	"status" text DEFAULT 'PROPOSED' NOT NULL,
	"internal_note" text,
	"override_source_count" boolean DEFAULT false NOT NULL,
	"override_reason" text,
	"override_at" timestamp with time zone,
	"override_count_snapshot" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_bus_route_selection_quantity_positive" CHECK ("project_bus_route_selections"."proposed_quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "passenger_metric_import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_file" text NOT NULL,
	"source_object_path" text NOT NULL,
	"source_sha256" text NOT NULL,
	"source_row_count" integer DEFAULT 0 NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "passenger_route_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"import_batch_id" uuid NOT NULL,
	"source_route_identifier" text NOT NULL,
	"normalized_source_route_identifier" text NOT NULL,
	"source_variant_identifier" text,
	"bus_route_id" uuid,
	"source_variant_id" uuid,
	"route_candidates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mapping_status" "passenger_metric_mapping_status" NOT NULL,
	"mapping_method" text NOT NULL,
	"mapping_note" text,
	"month" text NOT NULL,
	"passenger_count" integer NOT NULL,
	"trip_count" integer,
	"source_file" text NOT NULL,
	"source_row" integer NOT NULL,
	"source_values" jsonb NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "passenger_route_metrics_month_valid" CHECK ("passenger_route_metrics"."month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "passenger_route_metrics_counts_nonnegative" CHECK ("passenger_route_metrics"."passenger_count" >= 0 AND ("passenger_route_metrics"."trip_count" IS NULL OR "passenger_route_metrics"."trip_count" >= 0)),
	CONSTRAINT "passenger_route_metrics_mapping_consistency" CHECK ((
    ("passenger_route_metrics"."mapping_status" = 'MATCHED_VARIANT' AND "passenger_route_metrics"."bus_route_id" IS NOT NULL AND "passenger_route_metrics"."source_variant_id" IS NOT NULL)
    OR ("passenger_route_metrics"."mapping_status" = 'ROUTE_LEVEL_ONLY' AND "passenger_route_metrics"."bus_route_id" IS NOT NULL AND "passenger_route_metrics"."source_variant_id" IS NULL)
    OR ("passenger_route_metrics"."mapping_status" IN ('UNMATCHED', 'CONFLICT') AND "passenger_route_metrics"."bus_route_id" IS NULL AND "passenger_route_metrics"."source_variant_id" IS NULL)
  ))
);
--> statement-breakpoint
ALTER TABLE "asset_poi_relationships" ADD CONSTRAINT "asset_poi_relationships_project_id_pitch_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."pitch_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_poi_relationships" ADD CONSTRAINT "asset_poi_relationships_inventory_asset_id_inventory_assets_id_fk" FOREIGN KEY ("inventory_asset_id") REFERENCES "public"."inventory_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_poi_relationships" ADD CONSTRAINT "asset_poi_relationships_poi_id_project_locations_id_fk" FOREIGN KEY ("poi_id") REFERENCES "public"."project_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_scores" ADD CONSTRAINT "asset_scores_project_id_pitch_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."pitch_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_scores" ADD CONSTRAINT "asset_scores_inventory_asset_id_inventory_assets_id_fk" FOREIGN KEY ("inventory_asset_id") REFERENCES "public"."inventory_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_project_id_pitch_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."pitch_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_research_run_id_research_runs_id_fk" FOREIGN KEY ("research_run_id") REFERENCES "public"."research_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catchments" ADD CONSTRAINT "catchments_project_id_pitch_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."pitch_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_reviews" ADD CONSTRAINT "claim_reviews_project_id_pitch_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."pitch_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_reviews" ADD CONSTRAINT "claim_reviews_claim_id_research_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."research_claims"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_reviews" ADD CONSTRAINT "claim_reviews_verified_source_id_sources_id_fk" FOREIGN KEY ("verified_source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitors" ADD CONSTRAINT "competitors_project_id_pitch_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."pitch_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitors" ADD CONSTRAINT "competitors_research_run_id_research_runs_id_fk" FOREIGN KEY ("research_run_id") REFERENCES "public"."research_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_project_id_pitch_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."pitch_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deck_slides" ADD CONSTRAINT "deck_slides_deck_id_decks_id_fk" FOREIGN KEY ("deck_id") REFERENCES "public"."decks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decks" ADD CONSTRAINT "decks_project_id_pitch_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."pitch_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_media_units" ADD CONSTRAINT "inventory_media_units_parent_inventory_asset_id_inventory_assets_id_fk" FOREIGN KEY ("parent_inventory_asset_id") REFERENCES "public"."inventory_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_sync_changes" ADD CONSTRAINT "inventory_sync_changes_sync_run_id_inventory_sync_runs_id_fk" FOREIGN KEY ("sync_run_id") REFERENCES "public"."inventory_sync_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_sync_changes" ADD CONSTRAINT "inventory_sync_changes_inventory_asset_id_inventory_assets_id_fk" FOREIGN KEY ("inventory_asset_id") REFERENCES "public"."inventory_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_recommendations" ADD CONSTRAINT "location_recommendations_project_id_pitch_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."pitch_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_recommendations" ADD CONSTRAINT "location_recommendations_inventory_asset_id_inventory_assets_id_fk" FOREIGN KEY ("inventory_asset_id") REFERENCES "public"."inventory_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_recommendations" ADD CONSTRAINT "location_recommendations_inventory_media_unit_id_inventory_media_units_id_fk" FOREIGN KEY ("inventory_media_unit_id") REFERENCES "public"."inventory_media_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_route_recommendations" ADD CONSTRAINT "location_route_recommendations_project_id_pitch_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."pitch_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockups" ADD CONSTRAINT "mockups_project_id_pitch_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."pitch_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pitch_projects" ADD CONSTRAINT "pitch_projects_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pitch_projects" ADD CONSTRAINT "pitch_projects_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "points_of_interest" ADD CONSTRAINT "points_of_interest_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_inventory_selections" ADD CONSTRAINT "project_inventory_selections_project_id_pitch_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."pitch_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_inventory_selections" ADD CONSTRAINT "project_inventory_selections_inventory_asset_id_inventory_assets_id_fk" FOREIGN KEY ("inventory_asset_id") REFERENCES "public"."inventory_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_inventory_selections" ADD CONSTRAINT "project_inventory_selections_inventory_media_unit_id_inventory_media_units_id_fk" FOREIGN KEY ("inventory_media_unit_id") REFERENCES "public"."inventory_media_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_location_strategies" ADD CONSTRAINT "project_location_strategies_project_id_pitch_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."pitch_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_locations" ADD CONSTRAINT "project_locations_project_id_pitch_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."pitch_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_locations" ADD CONSTRAINT "project_locations_poi_id_points_of_interest_id_fk" FOREIGN KEY ("poi_id") REFERENCES "public"."points_of_interest"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_claims" ADD CONSTRAINT "research_claims_project_id_pitch_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."pitch_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_claims" ADD CONSTRAINT "research_claims_research_run_id_research_runs_id_fk" FOREIGN KEY ("research_run_id") REFERENCES "public"."research_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_claims" ADD CONSTRAINT "research_claims_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_runs" ADD CONSTRAINT "research_runs_project_id_pitch_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."pitch_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_research_run_id_research_runs_id_fk" FOREIGN KEY ("research_run_id") REFERENCES "public"."research_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_decisions" ADD CONSTRAINT "strategy_decisions_project_id_pitch_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."pitch_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_decisions" ADD CONSTRAINT "strategy_decisions_research_run_id_research_runs_id_fk" FOREIGN KEY ("research_run_id") REFERENCES "public"."research_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bus_plan_override_events" ADD CONSTRAINT "bus_plan_override_events_project_id_pitch_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."pitch_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bus_route_source_rows" ADD CONSTRAINT "bus_route_source_rows_bus_route_id_bus_routes_id_fk" FOREIGN KEY ("bus_route_id") REFERENCES "public"."bus_routes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bus_vehicle_profiles" ADD CONSTRAINT "bus_vehicle_profiles_inventory_asset_id_inventory_assets_id_fk" FOREIGN KEY ("inventory_asset_id") REFERENCES "public"."inventory_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bus_vehicle_route_assignments" ADD CONSTRAINT "bus_vehicle_route_assignments_vehicle_id_bus_vehicle_profiles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."bus_vehicle_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bus_vehicle_route_assignments" ADD CONSTRAINT "bus_vehicle_route_assignments_bus_route_id_bus_routes_id_fk" FOREIGN KEY ("bus_route_id") REFERENCES "public"."bus_routes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_bus_route_selections" ADD CONSTRAINT "project_bus_route_selections_project_id_pitch_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."pitch_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_bus_route_selections" ADD CONSTRAINT "project_bus_route_selections_source_variant_id_bus_route_source_rows_id_fk" FOREIGN KEY ("source_variant_id") REFERENCES "public"."bus_route_source_rows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passenger_route_metrics" ADD CONSTRAINT "passenger_route_metrics_import_batch_id_passenger_metric_import_batches_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."passenger_metric_import_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passenger_route_metrics" ADD CONSTRAINT "passenger_route_metrics_bus_route_id_bus_routes_id_fk" FOREIGN KEY ("bus_route_id") REFERENCES "public"."bus_routes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passenger_route_metrics" ADD CONSTRAINT "passenger_route_metrics_source_variant_id_bus_route_source_rows_id_fk" FOREIGN KEY ("source_variant_id") REFERENCES "public"."bus_route_source_rows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "asset_poi_relationship_unique" ON "asset_poi_relationships" USING btree ("project_id","inventory_asset_id","poi_id","radius_meters");--> statement-breakpoint
CREATE UNIQUE INDEX "campaigns_project_dedupe_key_unique" ON "campaigns" USING btree ("project_id","dedupe_key");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_assets_asset_code_ci_unique" ON "inventory_assets" USING btree (lower("asset_code"));--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_media_unit_parent_type_unique" ON "inventory_media_units" USING btree ("parent_inventory_asset_id","unit_type");--> statement-breakpoint
CREATE UNIQUE INDEX "location_recommendations_project_unit_radius_unique" ON "location_recommendations" USING btree ("project_id","inventory_media_unit_id","matching_radius_meters");--> statement-breakpoint
CREATE UNIQUE INDEX "location_route_recommendation_project_variant_unique" ON "location_route_recommendations" USING btree ("project_id","source_variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "points_of_interest_source_reference_unique" ON "points_of_interest" USING btree ("source_reference") WHERE "points_of_interest"."source_reference" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "project_inventory_selection_shelter_unique" ON "project_inventory_selections" USING btree ("project_id","inventory_asset_id") WHERE "project_inventory_selections"."inventory_media_unit_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "project_inventory_selection_unit_unique" ON "project_inventory_selections" USING btree ("project_id","inventory_media_unit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_locations_provider_dedupe" ON "project_locations" USING btree ("project_id","role","provider","provider_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bus_route_source_rows_sheet_identity_unique" ON "bus_route_source_rows" USING btree ("sheet_name","source_identity");--> statement-breakpoint
CREATE UNIQUE INDEX "bus_vehicle_profiles_inventory_asset_unique" ON "bus_vehicle_profiles" USING btree ("inventory_asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_bus_route_selection_variant_unique" ON "project_bus_route_selections" USING btree ("project_id","source_variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "passenger_metric_import_source_object_unique" ON "passenger_metric_import_batches" USING btree ("source_object_path");--> statement-breakpoint
CREATE UNIQUE INDEX "passenger_metric_import_source_sha256_unique" ON "passenger_metric_import_batches" USING btree ("source_sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "passenger_route_metrics_batch_row_unique" ON "passenger_route_metrics" USING btree ("import_batch_id","source_row");