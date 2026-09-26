import {
  check,
  integer,
  jsonb,
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
import { busRouteSourceRowsTable, busRoutesTable } from "./bus-routes";

export const passengerMetricMappingStatusEnum = pgEnum("passenger_metric_mapping_status", [
  "MATCHED_VARIANT",
  "ROUTE_LEVEL_ONLY",
  "UNMATCHED",
  "CONFLICT",
]);

export const passengerMetricImportBatchesTable = pgTable("passenger_metric_import_batches", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceFile: text("source_file").notNull(),
  sourceObjectPath: text("source_object_path").notNull(),
  sourceSha256: text("source_sha256").notNull(),
  sourceRowCount: integer("source_row_count").notNull().default(0),
  importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("passenger_metric_import_source_object_unique").on(table.sourceObjectPath),
  uniqueIndex("passenger_metric_import_source_sha256_unique").on(table.sourceSha256),
]);

export const passengerRouteMetricsTable = pgTable("passenger_route_metrics", {
  id: uuid("id").primaryKey().defaultRandom(),
  importBatchId: uuid("import_batch_id").notNull().references(() => passengerMetricImportBatchesTable.id),
  sourceRouteIdentifier: text("source_route_identifier").notNull(),
  normalizedSourceRouteIdentifier: text("normalized_source_route_identifier").notNull(),
  sourceVariantIdentifier: text("source_variant_identifier"),
  busRouteId: uuid("bus_route_id").references(() => busRoutesTable.id),
  sourceVariantId: uuid("source_variant_id").references(() => busRouteSourceRowsTable.id),
  routeCandidates: jsonb("route_candidates").$type<Array<{
    id: string;
    routeId: string;
    sourceVariantId?: string;
    sourceIdentity?: string;
    sourceSheet?: string;
    sourceRow?: number;
    from?: string | null;
    to?: string | null;
    via?: string | null;
    sourceBusCount?: number | null;
  }>>().notNull().default([]),
  mappingStatus: passengerMetricMappingStatusEnum("mapping_status").notNull(),
  mappingMethod: text("mapping_method").notNull(),
  mappingNote: text("mapping_note"),
  month: text("month").notNull(),
  passengerCount: integer("passenger_count").notNull(),
  tripCount: integer("trip_count"),
  sourceFile: text("source_file").notNull(),
  sourceRow: integer("source_row").notNull(),
  sourceValues: jsonb("source_values").$type<Record<string, string>>().notNull(),
  importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("passenger_route_metrics_batch_row_unique").on(table.importBatchId, table.sourceRow),
  check("passenger_route_metrics_month_valid", sql`${table.month} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
  check("passenger_route_metrics_counts_nonnegative", sql`${table.passengerCount} >= 0 AND (${table.tripCount} IS NULL OR ${table.tripCount} >= 0)`),
  check("passenger_route_metrics_mapping_consistency", sql`(
    (${table.mappingStatus} = 'MATCHED_VARIANT' AND ${table.busRouteId} IS NOT NULL AND ${table.sourceVariantId} IS NOT NULL)
    OR (${table.mappingStatus} = 'ROUTE_LEVEL_ONLY' AND ${table.busRouteId} IS NOT NULL AND ${table.sourceVariantId} IS NULL)
    OR (${table.mappingStatus} IN ('UNMATCHED', 'CONFLICT') AND ${table.busRouteId} IS NULL AND ${table.sourceVariantId} IS NULL)
  )`),
]);

export const insertPassengerMetricImportBatchSchema = createInsertSchema(passengerMetricImportBatchesTable)
  .omit({ id: true, importedAt: true });
export type InsertPassengerMetricImportBatch = z.infer<typeof insertPassengerMetricImportBatchSchema>;
export type PassengerMetricImportBatch = typeof passengerMetricImportBatchesTable.$inferSelect;

export const insertPassengerRouteMetricSchema = createInsertSchema(passengerRouteMetricsTable)
  .omit({ id: true, importedAt: true });
export type InsertPassengerRouteMetric = z.infer<typeof insertPassengerRouteMetricSchema>;
export type PassengerRouteMetric = typeof passengerRouteMetricsTable.$inferSelect;