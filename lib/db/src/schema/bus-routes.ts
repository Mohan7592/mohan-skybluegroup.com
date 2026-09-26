import {
  boolean,
  check,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { inventoryAssetsTable, pitchProjectsTable } from "./pitch-intelligence";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const busRoutesTable = pgTable("bus_routes", {
  id: uuid("id").primaryKey().defaultRandom(),
  normalizedRouteId: text("normalized_route_id").notNull().unique(),
  routeId: text("route_id").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  ...timestamps,
});

export const busRouteSourceRowsTable = pgTable("bus_route_source_rows", {
  id: uuid("id").primaryKey().defaultRandom(),
  busRouteId: uuid("bus_route_id").notNull().references(() => busRoutesTable.id),
  sheetName: text("sheet_name").notNull(),
  sourceIdentity: text("source_identity").notNull(),
  sourceRowNumber: integer("source_row_number").notNull(),
  allocatedBusCount: integer("allocated_bus_count"),
  rawData: jsonb("raw_data").$type<Record<string, unknown>>().notNull().default({}),
  isActive: boolean("is_active").notNull().default(true),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  ...timestamps,
}, (table) => [
  uniqueIndex("bus_route_source_rows_sheet_identity_unique").on(table.sheetName, table.sourceIdentity),
]);

export const busRouteSyncRunsTable = pgTable("bus_route_sync_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  status: text("status").notNull(),
  trigger: text("trigger").notNull(),
  sourceTitle: text("source_title"),
  discoveredSheets: jsonb("discovered_sheets").$type<Array<{
    name: string;
    kind: "route" | "vehicle";
    dataRows: number;
    headers: string[];
  }>>().notNull().default([]),
  skippedSheets: jsonb("skipped_sheets").$type<string[]>().notNull().default([]),
  sourceRows: integer("source_rows").notNull().default(0),
  distinctRoutes: integer("distinct_routes").notNull().default(0),
  addedCount: integer("added_count").notNull().default(0),
  updatedCount: integer("updated_count").notNull().default(0),
  unchangedCount: integer("unchanged_count").notNull().default(0),
  inactiveCount: integer("inactive_count").notNull().default(0),
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const busVehicleProfilesTable = pgTable("bus_vehicle_profiles", {
  id: uuid("id").primaryKey().defaultRandom(),
  bodyNumber: text("body_number").notNull().unique(),
  inventoryAssetId: uuid("inventory_asset_id").references(() => inventoryAssetsTable.id),
  depot: text("depot"),
  plateNumber: text("plate_number"),
  client: text("client"),
  installationStatus: text("installation_status"),
  campaign: text("campaign"),
  availability: text("availability"),
  ...timestamps,
}, (table) => [
  uniqueIndex("bus_vehicle_profiles_inventory_asset_unique").on(table.inventoryAssetId),
]);

export const busVehicleRouteAssignmentsTable = pgTable("bus_vehicle_route_assignments", {
  id: uuid("id").primaryKey().defaultRandom(),
  vehicleId: uuid("vehicle_id").notNull().references(() => busVehicleProfilesTable.id),
  busRouteId: uuid("bus_route_id").notNull().references(() => busRoutesTable.id),
  assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
  unassignedAt: timestamp("unassigned_at", { withTimezone: true }),
  ...timestamps,
});

export const projectBusRouteSelectionsTable = pgTable("project_bus_route_selections", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => pitchProjectsTable.id),
  sourceVariantId: uuid("source_variant_id").notNull().references(() => busRouteSourceRowsTable.id),
  proposedQuantity: integer("proposed_quantity").notNull(),
  status: text("status", { enum: ["PROPOSED", "SHORTLISTED", "REJECTED"] }).notNull().default("PROPOSED"),
  internalNote: text("internal_note"),
  overrideSourceCount: boolean("override_source_count").notNull().default(false),
  overrideReason: text("override_reason"),
  overrideAt: timestamp("override_at", { withTimezone: true }),
  overrideCountSnapshot: integer("override_count_snapshot"),
  ...timestamps,
}, (table) => [
  uniqueIndex("project_bus_route_selection_variant_unique").on(table.projectId, table.sourceVariantId),
  check("project_bus_route_selection_quantity_positive", sql`${table.proposedQuantity} > 0`),
]);

export const busPlanOverrideEventsTable = pgTable("bus_plan_override_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => pitchProjectsTable.id),
  // Intentionally not a foreign key: audit events remain after a project selection is removed.
  selectionId: uuid("selection_id").notNull(),
  priorQuantity: integer("prior_quantity"),
  proposedQuantity: integer("proposed_quantity").notNull(),
  sourceBusCountSnapshot: integer("source_bus_count_snapshot"),
  reason: text("reason").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("bus_plan_override_event_prior_quantity_positive", sql`${table.priorQuantity} IS NULL OR ${table.priorQuantity} > 0`),
  check("bus_plan_override_event_proposed_quantity_positive", sql`${table.proposedQuantity} > 0`),
  check("bus_plan_override_event_source_count_nonnegative", sql`${table.sourceBusCountSnapshot} IS NULL OR ${table.sourceBusCountSnapshot} >= 0`),
  check("bus_plan_override_event_reason_nonempty", sql`length(trim(${table.reason})) > 0`),
]);

export const insertBusRouteSchema = createInsertSchema(busRoutesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertBusRoute = z.infer<typeof insertBusRouteSchema>;
export type BusRoute = typeof busRoutesTable.$inferSelect;
export type BusRouteSourceRow = typeof busRouteSourceRowsTable.$inferSelect;
export const insertProjectBusRouteSelectionSchema = createInsertSchema(projectBusRouteSelectionsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertProjectBusRouteSelection = z.infer<typeof insertProjectBusRouteSelectionSchema>;
export type ProjectBusRouteSelection = typeof projectBusRouteSelectionsTable.$inferSelect;
export type BusPlanOverrideEvent = typeof busPlanOverrideEventsTable.$inferSelect;