import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import {
  analyzePassengerRouteFamilies,
  analyzePassengerRouteSeries,
  passengerImportQuality,
} from "../lib/passenger-metrics-analysis";
import {
  previewRtaPassengerJourneysCsv,
  summarizeSourcePeriodConflicts,
  summarizePassengerMappingStatuses,
} from "../lib/passenger-metrics-import";
import {
  DuplicatePassengerSourceError,
  findPassengerMetricImportBySha256,
  getActiveRouteTargets,
  isPassengerMetricObjectReferenced,
  mappedPreviewRows,
  persistPassengerMetricRows,
} from "../lib/passenger-metrics-service";
import {
  createPassengerCsvUpload,
  deleteUnreferencedPassengerCsvObject,
  MAX_PASSENGER_CSV_BYTES,
  passengerImportCleanupFailureMessage,
  readPassengerCsvObject,
} from "../lib/passenger-metrics-storage";
import { pool } from "@workspace/db";

const usage = `Usage:
  node --experimental-strip-types artifacts/api-server/src/cli/import-passenger-metrics.mjs \\
    --file <csv-path> --passenger-journeys [--dry-run | --commit]

Dry-run is the default. --passenger-journeys is mandatory because this RTA
export's "trips" column is treated as passenger journeys, not vehicle trips.`;

type Arguments = {
  file: string;
  commit: boolean;
  passengerJourneys: boolean;
};

function parseArguments(args: string[]): Arguments {
  const fileFlag = args.indexOf("--file");
  const file = fileFlag >= 0 ? args[fileFlag + 1] : undefined;
  const commit = args.includes("--commit");
  const dryRun = args.includes("--dry-run");
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage);
    process.exit(0);
  }
  if (!file || file.startsWith("--")) throw new Error(`A CSV file is required.\n${usage}`);
  if (commit && dryRun) throw new Error("Choose either --dry-run or --commit, not both.");
  if (!args.includes("--passenger-journeys")) {
    throw new Error("The explicit --passenger-journeys semantic flag is required; the `trips` field will not be guessed.");
  }
  const knownFlags = new Set(["--file", "--commit", "--dry-run", "--passenger-journeys"]);
  if (args.some((argument, index) =>
    argument.startsWith("--") && !knownFlags.has(argument) ||
    argument === "--file" && (index + 1 >= args.length || args[index + 1]!.startsWith("--")))) {
    throw new Error(`Unsupported or incomplete CLI options.\n${usage}`);
  }
  return { file, commit, passengerJourneys: true };
}

function exampleRows(rows: ReturnType<typeof previewRtaPassengerJourneysCsv>["rows"]) {
  const chosen = new Set<number>();
  const output = [];
  for (const status of ["CONFLICT", "ROUTE_LEVEL_ONLY", "UNMATCHED", "MATCHED_VARIANT", "INVALID"] as const) {
    const row = rows.find((candidate) => candidate.mappingStatus === status && !chosen.has(candidate.sourceRow));
    if (row) {
      chosen.add(row.sourceRow);
      output.push(row);
    }
  }
  for (const row of rows) {
    if (output.length >= 5) break;
    if (!chosen.has(row.sourceRow)) {
      chosen.add(row.sourceRow);
      output.push(row);
    }
  }
  return output.slice(0, 5).map((row) => ({
    sourceRow: row.sourceRow,
    sourceRouteIdentifier: row.sourceRouteIdentifier,
    normalizedMonth: row.month || null,
    passengerJourneys: row.error ? null : row.passengerCount,
    status: row.error ? "INVALID" : row.mappingStatus,
    matchedRouteId: row.matchedRouteId,
    candidateCount: row.routeCandidates.length,
    candidates: row.routeCandidates.slice(0, 4).map((candidate) => ({
      routeId: candidate.routeId,
      sourceSheet: candidate.sourceSheet ?? null,
      sourceRow: candidate.sourceRow ?? null,
      from: candidate.from ?? null,
      to: candidate.to ?? null,
    })),
    error: row.error,
  }));
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const filePath = resolve(options.file);
  const sourceFile = basename(filePath);
  if (!sourceFile || sourceFile.length > 240 || !/\.csv$/i.test(sourceFile)) {
    throw new Error("The source must be a CSV file with a name no longer than 240 characters.");
  }
  const rawBytes = new Uint8Array(await readFile(filePath));
  if (!rawBytes.byteLength || rawBytes.byteLength > MAX_PASSENGER_CSV_BYTES) {
    throw new Error("The CSV must be between 1 byte and 20 MiB.");
  }
  const rawSha256 = createHash("sha256").update(rawBytes).digest("hex");
  const existingImport = await findPassengerMetricImportBySha256(rawSha256);
  if (options.commit && existingImport) {
    throw new DuplicatePassengerSourceError(existingImport.id);
  }
  let csv: string;
  try {
    csv = new TextDecoder("utf-8", { fatal: true }).decode(rawBytes);
  } catch {
    throw new Error("The source CSV must contain valid UTF-8 text.");
  }

  const routes = await getActiveRouteTargets();
  const preview = previewRtaPassengerJourneysCsv(csv, sourceFile, routes, {
    passengerJourneys: options.passengerJourneys,
  });
  const rows = mappedPreviewRows(preview.rows, routes, {
    routeIdentifier: "route_identifier",
    month: "reporting_month",
    passengers: "passenger_count",
    trips: null,
    routeVariant: null,
  });
  const summary = summarizePassengerMappingStatuses(rows);
  const quality = passengerImportQuality(rows.filter((row) => !row.error));
  const conflicts = summarizeSourcePeriodConflicts(rows);
  const analysis = analyzePassengerRouteSeries(rows
    .filter((row) => !row.error && row.mappingStatus === "MATCHED_VARIANT" && row.matchedRouteId && row.sourceVariantId)
    .map((row) => ({
      routeId: row.matchedRouteId!,
      sourceVariantId: row.sourceVariantId!,
      mappingStatus: "MATCHED_VARIANT" as const,
      period: row.month,
      passengerCount: row.passengerCount,
      tripCount: null,
      sourceFile,
      sourceRow: row.sourceRow,
      importedAt: "dry-run",
    })));
  const familyAnalysis = analyzePassengerRouteFamilies(rows
    .filter((row) => !row.error && row.mappingStatus === "ROUTE_LEVEL_ONLY" && row.matchedRouteId)
    .map((row) => ({
      routeId: row.matchedRouteId!,
      mappingStatus: "ROUTE_LEVEL_ONLY" as const,
      period: row.month,
      passengerCount: row.passengerCount,
      tripCount: null,
      sourceFile,
      sourceRow: row.sourceRow,
      importedAt: "dry-run",
    })));
  const dryRunReport = {
    mode: options.commit ? "COMMIT_REQUESTED" : "DRY_RUN",
    source: {
      file: sourceFile,
      bytes: rawBytes.byteLength,
      sha256: rawSha256,
      rawObjectStored: !!existingImport,
      previouslyImported: !!existingImport,
      sourceStatus: "user-provided file; RTA provenance not independently verified",
    },
    interpretation: {
      declaredBy: "--passenger-journeys",
      tripsColumn: "passenger journeys",
      vehicleTripCount: null,
      passengersPerVehicleTrip: null,
      loadTimestampUse: "retained in original sourceValues for audit only; not used as reporting month or ordering",
      trendConflictHandling: "identical same-route/month rows are deduplicated only in derived series; conflicting values are excluded from series calculations, while all raw rows remain preserved",
      volumeCaveat: "route-level passenger journey counts are not unique people, audience reach, advertising impressions, or inventory availability",
      advertisingReach: null,
      advertisingImpressions: null,
    },
    sourceRows: preview.rows.length,
    columns: preview.headers,
    normalizedPeriodCoverage: quality.periods,
    missingMonths: quality.periods.missingMonths,
    periodCoverageLabel: quality.periods.rangeLabel,
    mapping: summary,
    invalidRowExamples: rows.filter((row) => row.error).slice(0, 5).map((row) => ({
      sourceRow: row.sourceRow,
      error: row.error,
    })),
    repeatedRouteMonths: conflicts.repeatedRouteMonths,
    conflictingRouteMonths: conflicts.conflictingRouteMonths,
    duplicateConflictExamples: conflicts.examples,
    matchedRouteVariantAnalysis: {
      series: analysis.length,
      seriesWithThreeMonthAverage: analysis.filter((series) => series.threeMonthAverage !== null).length,
      seriesWithSixMonthAverage: analysis.filter((series) => series.sixMonthAverage !== null).length,
      sumOfRouteLevelJourneyCountsAcrossResolvedPeriods: analysis.reduce((total, series) =>
        total + (series.availableTotal ?? 0), 0),
      duplicatePeriods: analysis.reduce((total, series) => total + series.duplicatePeriods, 0),
      conflictingPeriods: analysis.reduce((total, series) => total + series.conflictingPeriods, 0),
      threeMonthAverageRows: analysis.filter((series) => series.threeMonthAverage !== null)
        .slice(0, 10).map(({ routeId, sourceVariantId, lastPeriod, threeMonthAverage, threeMonthPeriods }) => ({
          routeId, sourceVariantId, lastPeriod, threeMonthAverage, threeMonthPeriods,
        })),
    },
    routeFamilyPassengerAnalysis: {
      familySeries: familyAnalysis.length,
      distinctFamilyPeriods: familyAnalysis.reduce((total, family) => total + family.availablePeriods, 0),
      conflictingPeriods: familyAnalysis.reduce((total, family) => total + family.conflictingPeriods, 0),
      series: familyAnalysis.map(({ routeId, latest, availablePeriods, duplicatePeriods, conflictingPeriods }) => ({
        routeId, latest, availablePeriods, duplicatePeriods, conflictingPeriods,
      })),
    },
    fiveRouteMappingExamples: exampleRows(rows),
  };

  if (summary.INVALID) {
    console.log(JSON.stringify({
      ...dryRunReport,
      commitBlocked: options.commit ? "Invalid source rows exist; no rows are committed, so none are silently dropped." : undefined,
      databaseRowsInserted: 0,
    }, null, 2));
    if (options.commit) throw new Error("Commit stopped because the source contains invalid rows. Correcting the source is required; partial import is not allowed.");
    return;
  }

  if (!options.commit) {
    console.log(JSON.stringify({ ...dryRunReport, databaseRowsInserted: 0 }, null, 2));
    return;
  }

  const upload = await createPassengerCsvUpload();
  let result: Awaited<ReturnType<typeof persistPassengerMetricRows>> | undefined;
  try {
    const putResponse = await fetch(upload.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "text/csv" },
      body: rawBytes,
      signal: AbortSignal.timeout(60_000),
    });
    if (!putResponse.ok) throw new Error(`Private App Storage rejected the raw CSV upload (HTTP ${putResponse.status}).`);
    const persistedSource = await readPassengerCsvObject(upload.objectPath);
    if (persistedSource.sha256 !== rawSha256 ||
        !Buffer.from(persistedSource.bytes).equals(Buffer.from(rawBytes))) {
      throw new Error("Private App Storage raw-byte verification failed; no metrics were committed.");
    }
    result = await persistPassengerMetricRows({
      rows,
      sourceFile,
      sourceObjectPath: upload.objectPath,
      sha256: rawSha256,
      auditMappingNote: "Explicit agent-run flag: the RTA export's `trips` value is interpreted as passenger journeys; vehicle-trip count is unavailable.",
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown import failure";
    try {
      await deleteUnreferencedPassengerCsvObject(upload.objectPath, isPassengerMetricObjectReferenced);
    } catch (cleanupError) {
      const cleanupReason = cleanupError instanceof Error ? cleanupError.message : "unknown cleanup failure";
      throw new Error(passengerImportCleanupFailureMessage(upload.objectPath, reason, cleanupReason));
    }
    throw error;
  }
  if (!result) throw new Error(`Passenger metric persistence returned no result for object ${upload.objectPath}.`);
  console.log(JSON.stringify({
    ...dryRunReport,
    mode: "COMMITTED",
    source: { ...dryRunReport.source, rawObjectStored: true, objectPath: upload.objectPath },
    databaseRowsInserted: result.rowCount,
    committedMapping: result.summary,
    batch: {
      id: result.importBatch.id,
      sourceRowCount: result.importBatch.sourceRowCount,
      sourceSha256: result.importBatch.sourceSha256,
      sourceObjectPath: result.importBatch.sourceObjectPath,
    },
    note: "Passenger journeys are route-level ridership only, not vehicle service trips, advertising impressions, audience reach, or availability.",
  }, null, 2));
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Passenger import failed.");
  process.exitCode = 1;
} finally {
  await pool.end();
}