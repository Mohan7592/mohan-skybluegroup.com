import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Papa from "papaparse";
import { AlertTriangle, FileSpreadsheet, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type ColumnMapping = {
  routeIdentifier: string;
  month: string;
  passengers: string;
  trips: string;
  routeVariant: string;
};
type MetricStatus = "MATCHED" | "AMBIGUOUS" | "UNMATCHED";
type PreviewRow = {
  sourceRouteIdentifier: string;
  sourceVariantIdentifier: string | null;
  month: string;
  passengerCount: number;
  tripCount: number | null;
  sourceRow: number;
  mappingStatus: MetricStatus;
  matchedRouteId: string | null;
  routeCandidates: Array<{
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
  }>;
  error: string | null;
};
type PreviewResponse = {
  sourceFile: string;
  sourceObjectPath: string;
  headers: string[];
  rows: PreviewRow[];
  summary: { MATCHED: number; AMBIGUOUS: number; UNMATCHED: number; INVALID: number };
  quality: {
    validRows: number;
    matchedRows: number;
    ambiguousRows: number;
    unmatchedRows: number;
    periods: { count: number; first: string | null; last: string | null };
    exampleMappings: Array<{
      sourceRow: number;
      sourceRouteIdentifier: string;
      status: string;
      candidates: Array<{ routeId: string; sourceSheet: string | null; sourceRow: number | null }>;
    }>;
  };
};
type ManualChoice = { routeId: string; note: string };
type StoredMetric = {
  id: string;
  sourceRouteIdentifier: string;
  routeId: string | null;
  mappingStatus: MetricStatus;
  sourceVariantId: string | null;
  sourceVariantIdentifier: string | null;
  sourceValues: Record<string, string>;
  routeCandidates: PreviewRow["routeCandidates"];
  mappingNote: string | null;
  month: string;
  passengerCount: number;
  tripCount: number | null;
  sourceFile: string;
  sourceRow: number;
};
type StoredImport = {
  id: string;
  sourceFile: string;
  sourceRowCount: number;
  importedAt: string;
  summary: { MATCHED: number; AMBIGUOUS: number; UNMATCHED: number };
};

const emptyMapping: ColumnMapping = { routeIdentifier: "", month: "", passengers: "", trips: "", routeVariant: "" };
const columnName = (value: string) => value.toLocaleLowerCase().replace(/[^a-z0-9]/g, "");
const findColumn = (headers: string[], expression: RegExp) => headers.find((header) => expression.test(columnName(header))) ?? "";

async function deleteTemporaryPassengerUpload(objectPath: string): Promise<void> {
  if (!objectPath) return;
  const response = await fetch("/api/inventory/passenger-metrics/uploads", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ objectPath }),
  });
  if (!response.ok && response.status !== 409) {
    const result = await response.json() as { error?: string };
    throw new Error(result.error || "Could not remove the temporary source upload.");
  }
}

function validateHeaders(headers: string[]): string | null {
  if (headers.length > 100) return "This CSV has more than 100 columns and cannot be imported safely.";
  if (new Set(headers.map(columnName)).size !== headers.length) return "This CSV has duplicate column headings; it cannot be imported safely.";
  if (headers.map(columnName).some((header) =>
    /employee|personnel|swipe|access|card|badge|user|person|staff|driver|operator|event|login|logout|clock|checkin|checkout|journey|mobiledevice|signedin|signedout|permissionreason|dooraddress|email|phone|contact|passport|nationalid|latitude|longitude|gps|device|remarks|reason/.test(header) ||
    /(?:^|route)name$/.test(header) ||
    /^(?:name|address|mobile)$/.test(header) ||
    (/id/.test(header) && !/route|trip|variant|service|identity/.test(header)))) {
    return "This file appears to contain personnel or access-event data. Only route-wise passenger ridership CSV files are accepted.";
  }
  const normalized = headers.map(columnName);
  const hasRoute = normalized.some((header) => header.includes("route") || header === "line" || header.startsWith("serviceid"));
  const hasMonth = normalized.some((header) => /month|period/.test(header));
  const hasPassengers = normalized.some((header) => /passenger|ridership|pax/.test(header));
  if (!hasRoute || !hasMonth || !hasPassengers) {
    return "This file does not have recognizable route, reporting month/period and passenger/ridership columns.";
  }
  return null;
}

async function requestJson<T>(
  path: string,
  mapping: ColumnMapping,
  payload: { sourceFile: string; objectPath: string; overrides?: Array<{ sourceRow: number; sourceVariantId: string; note: string }> },
): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...payload,
      mapping: {
        routeIdentifier: mapping.routeIdentifier,
        month: mapping.month,
        passengers: mapping.passengers,
        trips: mapping.trips || null,
        routeVariant: mapping.routeVariant || null,
      },
      overrides: payload.overrides ?? [],
    }),
  });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error || `CSV request failed (${response.status}).`);
  return result;
}

export function PassengerMetricsImport({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const importsQuery = useQuery({
    queryKey: ["passengerMetricImports"],
    queryFn: async () => {
      const response = await fetch("/api/inventory/passenger-metrics/imports");
      const result = await response.json() as StoredImport[] | { error?: string };
      if (!response.ok) throw new Error(!Array.isArray(result) && result.error ? result.error : "Passenger import history is unavailable.");
      return result as StoredImport[];
    },
    staleTime: 30_000,
  });
  const metricsQuery = useQuery({
    queryKey: ["passengerMetrics"],
    queryFn: async () => {
      const response = await fetch("/api/inventory/passenger-metrics?limit=500");
      const result = await response.json() as StoredMetric[] | { error?: string };
      if (!response.ok) throw new Error(!Array.isArray(result) && result.error ? result.error : "Passenger metric mapping is unavailable.");
      return result as StoredMetric[];
    },
    staleTime: 30_000,
  });
  const [file, setFile] = useState<File | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<ColumnMapping>(emptyMapping);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [uploadedObjectPath, setUploadedObjectPath] = useState("");
  const uploadedObjectPathRef = useRef("");
  const [manualChoices, setManualChoices] = useState<Record<number, ManualChoice>>({});
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [storedMappings, setStoredMappings] = useState<Record<string, ManualChoice>>({});
  const [updatingMetricId, setUpdatingMetricId] = useState("");
  const selectedManualChoices = useMemo(() => Object.entries(manualChoices)
    .filter(([, choice]) => choice.routeId && choice.note.trim().length >= 10)
    .map(([sourceRow, choice]) => ({
      sourceRow: Number(sourceRow),
      sourceVariantId: choice.routeId,
      note: choice.note,
    })), [manualChoices]);

  useEffect(() => { uploadedObjectPathRef.current = uploadedObjectPath; }, [uploadedObjectPath]);
  useEffect(() => () => {
    if (uploadedObjectPathRef.current) {
      void deleteTemporaryPassengerUpload(uploadedObjectPathRef.current).catch(() => {});
    }
  }, []);

  const removeTemporaryUpload = async (objectPath: string) => {
    await deleteTemporaryPassengerUpload(objectPath);
  };

  const chooseFile = (selected: File | undefined) => {
    if (uploadedObjectPath) void removeTemporaryUpload(uploadedObjectPath).catch((cause) =>
      setError(cause instanceof Error ? cause.message : "Could not remove the previous source upload."));
    setUploadedObjectPath("");
    uploadedObjectPathRef.current = "";
    setFile(null);
    setHeaders([]);
    setPreview(null);
    setManualChoices({});
    setMapping(emptyMapping);
    setError("");
    setStatus("");
    if (!selected) return;
    if (!/\.csv$/i.test(selected.name)) {
      setError("Only route-wise passenger CSV files are accepted. Excel workbooks are not read by this importer.");
      return;
    }
    if (selected.size <= 0 || selected.size > 20 * 1024 * 1024) {
      setError("Choose a non-empty CSV file no larger than 20 MB.");
      return;
    }
    Papa.parse<string[]>(selected, {
      preview: 1,
      header: false,
      skipEmptyLines: true,
      complete: (result) => {
        const firstRecord = result.data[0];
        if (!firstRecord) {
          setError("The CSV header could not be read.");
          return;
        }
        const parsedHeaders = firstRecord.map((header, index) =>
          (index === 0 ? header.replace(/^\uFEFF/, "") : header).trim());
        const headerError = validateHeaders(parsedHeaders);
        if (headerError) {
          setError(headerError);
          return;
        }
        setFile(selected);
        setHeaders(parsedHeaders);
        setMapping({
          routeIdentifier: findColumn(parsedHeaders, /^(route(id|no|number|code)?|line(id|no|number)?|serviceid)$/),
          month: findColumn(parsedHeaders, /(month|period)/),
          passengers: findColumn(parsedHeaders, /(passenger|ridership|pax)/),
          trips: findColumn(parsedHeaders, /^trips?(count|number)?$/),
          routeVariant: findColumn(parsedHeaders, /(variant|direction|sourceidentity)/),
        });
      },
      error: () => setError("The CSV header could not be read."),
    });
  };

  const previewImport = async () => {
    if (!file) return;
    setError("");
    setStatus("");
    setIsPreviewing(true);
    let newObjectPath = "";
    try {
      if (uploadedObjectPath) await removeTemporaryUpload(uploadedObjectPath);
      setUploadedObjectPath("");
      setPreview(null);
      const uploadResponse = await fetch("/api/inventory/passenger-metrics/upload-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: file.name, size: file.size, contentType: "text/csv" }),
      });
      const upload = await uploadResponse.json() as { uploadUrl?: string; objectPath?: string; error?: string };
      if (!uploadResponse.ok || !upload.uploadUrl || !upload.objectPath) {
        throw new Error(upload.error || "Private App Storage upload could not be prepared.");
      }
      newObjectPath = upload.objectPath;
      setUploadedObjectPath(upload.objectPath);
      uploadedObjectPathRef.current = upload.objectPath;
      const stored = await fetch(upload.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "text/csv" },
        body: file,
      });
      if (!stored.ok) {
        await removeTemporaryUpload(upload.objectPath);
        throw new Error("The source CSV could not be uploaded to private App Storage.");
      }
      const result = await requestJson<PreviewResponse>("/api/inventory/passenger-metrics/preview", mapping, {
        sourceFile: file.name,
        objectPath: upload.objectPath,
      });
      setPreview(result);
      setManualChoices({});
    } catch (cause) {
      if (newObjectPath) void removeTemporaryUpload(newObjectPath).catch(() => {});
      setUploadedObjectPath("");
      uploadedObjectPathRef.current = "";
      setError(cause instanceof Error ? cause.message : "Could not preview this passenger CSV.");
      setPreview(null);
    } finally {
      setIsPreviewing(false);
    }
  };

  const importRows = async () => {
    if (!file || !preview || !uploadedObjectPath) return;
    setError("");
    setStatus("");
    setIsImporting(true);
    try {
      const result = await requestJson<{
        rowCount: number;
        summary: { MATCHED: number; AMBIGUOUS: number; UNMATCHED: number };
      }>("/api/inventory/passenger-metrics/import", mapping, {
        sourceFile: file.name,
        objectPath: uploadedObjectPath,
        overrides: selectedManualChoices,
      });
      setStatus(`Imported ${result.rowCount} metric row(s): ${result.summary.MATCHED} matched, ${result.summary.AMBIGUOUS} ambiguous, ${result.summary.UNMATCHED} unmatched.`);
      setPreview(null);
      setManualChoices({});
      setUploadedObjectPath("");
      uploadedObjectPathRef.current = "";
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["getNetworkRecommendations", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["passengerMetricImports"] }),
        queryClient.invalidateQueries({ queryKey: ["passengerMetrics"] }),
      ]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not import this passenger CSV.");
    } finally {
      setIsImporting(false);
    }
  };

  const confirmStoredMapping = async (metricId: string) => {
    const choice = storedMappings[metricId];
    if (!choice?.routeId || choice.note.trim().length < 10) return;
    setError("");
    setUpdatingMetricId(metricId);
    try {
      const response = await fetch(`/api/inventory/passenger-metrics/${metricId}/mapping`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceVariantId: choice.routeId, note: choice.note }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "Could not update route mapping.");
      setStoredMappings((current) => { const next = { ...current }; delete next[metricId]; return next; });
      await Promise.all([
        metricsQuery.refetch(),
        queryClient.invalidateQueries({ queryKey: ["getNetworkRecommendations", projectId] }),
      ]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update route mapping.");
    } finally {
      setUpdatingMetricId("");
    }
  };

  const unresolvedMetrics = (metricsQuery.data ?? []).filter((metric) => metric.mappingStatus !== "MATCHED").slice(0, 30);

  return (
    <Card data-testid="passenger-metrics-import">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><FileSpreadsheet className="h-4 w-4 text-brand" /> Route-level passenger evidence</CardTitle>
        <CardDescription>
          Import a route-wise passenger ridership CSV. Route IDs are matched only by a unique exact normalized ID; uncertain rows stay visible as ambiguous or unmatched. Counts are not ad impressions or reach.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="passenger-csv-file">Passenger CSV file</Label>
          <Input
            id="passenger-csv-file"
            data-testid="input-passenger-csv"
            type="file"
            accept=".csv,text/csv"
            onChange={(event) => chooseFile(event.target.files?.[0])}
          />
          <p className="text-xs text-muted-foreground">CSV only, up to 20 MB. Once every row passes validation, the original file is uploaded directly to private App Storage and retained for audit; unchanged parsed source-row values and file/row provenance are stored with imported metrics. Rejected files are removed.</p>
        </div>
        {error && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">{error}</p>}
        {status && <p role="status" className="rounded-md border border-green-300 bg-green-50 p-3 text-sm text-green-950 dark:border-green-900 dark:bg-green-950/40 dark:text-green-100">{status}</p>}

        {file && headers.length > 0 && (
          <div className="space-y-3 rounded-md border p-4">
            <p className="text-sm font-medium">Auto-recognized column mapping (review before preview)</p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              {([
                ["routeIdentifier", "Route identifier"],
                ["month", "Reporting month / period"],
                ["passengers", "Passenger / ridership count"],
                ["trips", "Trips (optional)"],
                ["routeVariant", "Source route variant (optional)"],
              ] as const).map(([field, label]) => (
                <div className="space-y-1" key={field}>
                  <Label htmlFor={`passenger-column-${field}`}>{label}</Label>
                  <select
                    id={`passenger-column-${field}`}
                    className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                    value={mapping[field]}
                    onChange={(event) => {
                      if (uploadedObjectPath) void removeTemporaryUpload(uploadedObjectPath).catch((cause) =>
                        setError(cause instanceof Error ? cause.message : "Could not remove the previous source upload."));
                      setUploadedObjectPath("");
                      uploadedObjectPathRef.current = "";
                      setPreview(null);
                      setManualChoices({});
                      setMapping((current) => ({ ...current, [field]: event.target.value }));
                    }}
                  >
                    {field === "trips" && <option value="">No trips column</option>}
                    {field === "routeVariant" && <option value="">No source variant column</option>}
                    {headers.map((header) => <option key={header} value={header}>{header}</option>)}
                  </select>
                </div>
              ))}
            </div>
            <Button type="button" variant="outline" onClick={() => void previewImport()} disabled={isPreviewing || !mapping.routeIdentifier || !mapping.month || !mapping.passengers}>
              <Upload className="mr-2 h-4 w-4" />{isPreviewing ? "Checking source mapping…" : "Preview route mapping"}
            </Button>
          </div>
        )}

        {preview && (
          <div className="space-y-3" aria-live="polite">
            <div className="flex flex-wrap gap-2">
              <Badge>Exact matches: {preview.summary.MATCHED}</Badge>
              <Badge variant="secondary">Ambiguous: {preview.summary.AMBIGUOUS}</Badge>
              <Badge variant="outline">Unmatched: {preview.summary.UNMATCHED}</Badge>
              <Badge variant="destructive">Invalid: {preview.summary.INVALID}</Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              Showing up to 100 source rows. The source file is retained only if every metric row is valid. Multiple source variants for one route remain ambiguous unless a matching variant identity is supplied or explicitly reviewed.
            </p>
            <div className="max-h-[28rem] overflow-auto rounded-md border">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-muted">
                  <tr><th className="p-2">Source row</th><th className="p-2">Route ID</th><th className="p-2">Month</th><th className="p-2">Passengers</th><th className="p-2">Trips</th><th className="p-2">Mapping</th></tr>
                </thead>
                <tbody>
                  {preview.rows.slice(0, 100).map((row) => {
                    const choice = manualChoices[row.sourceRow];
                    const normalizedVariant = row.sourceVariantIdentifier?.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
                    const explicitVariantCandidates = row.routeCandidates.filter((candidate) => [
                      candidate.sourceVariantId ?? "",
                      candidate.sourceIdentity ?? "",
                      candidate.sourceSheet ?? "",
                      candidate.sourceRow == null ? "" : String(candidate.sourceRow),
                    ].some((value) => value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US") === normalizedVariant));
                    const requiresVariantIdentity = row.routeCandidates.some((candidate) =>
                      row.routeCandidates.filter((other) => other.routeId === candidate.routeId).length > 1);
                    return (
                      <tr key={row.sourceRow} className="border-t align-top">
                        <td className="p-2">{row.sourceRow}</td>
                        <td className="p-2">{row.sourceRouteIdentifier || "Blank"}</td>
                        <td className="p-2">{row.month || "Invalid"}</td>
                        <td className="p-2">{row.error ? "Invalid" : row.passengerCount.toLocaleString()}</td>
                        <td className="p-2">{row.tripCount === null ? "—" : row.tripCount.toLocaleString()}</td>
                        <td className="min-w-52 p-2">
                          {row.error ? <span className="text-destructive">{row.error}</span> :
                            row.mappingStatus === "MATCHED" ? `Exact → ${row.matchedRouteId}` :
                              <>
                                <div className="flex items-center gap-1 font-medium"><AlertTriangle className="h-3 w-3 text-amber-600" />{row.mappingStatus}</div>
                                {requiresVariantIdentity && explicitVariantCandidates.length !== 1 ? (
                                  <p className="mt-2 text-amber-700">The source row does not identify a specific route variant. Do not assign its ridership to a variant.</p>
                                ) : row.routeCandidates.length > 0 && (
                                  <div className="mt-2 space-y-2">
                                    <select
                                      className="h-9 w-full rounded border bg-background px-2"
                                      aria-label={`Possible existing route for source row ${row.sourceRow}`}
                                      value={choice?.routeId ?? ""}
                                      onChange={(event) => setManualChoices((current) => ({
                                        ...current,
                                        [row.sourceRow]: { routeId: event.target.value, note: current[row.sourceRow]?.note ?? "" },
                                      }))}
                                    >
                                      <option value="">Keep unresolved</option>
                                      {(requiresVariantIdentity ? explicitVariantCandidates : row.routeCandidates).map((candidate) => <option key={candidate.sourceVariantId ?? candidate.id} value={candidate.sourceVariantId ?? ""}>
                                        {candidate.routeId}{candidate.sourceSheet ? ` · ${candidate.sourceSheet}` : ""}{candidate.sourceRow ? ` row ${candidate.sourceRow}` : ""}{candidate.from || candidate.to ? ` · ${candidate.from ?? "?"} → ${candidate.to ?? "?"}` : ""}
                                      </option>)}
                                    </select>
                                    {choice?.routeId && (
                                      <Input
                                        aria-label={`Mapping note for source row ${row.sourceRow}`}
                                        placeholder="Explain why this route is the correct match"
                                        maxLength={500}
                                        value={choice.note}
                                        onChange={(event) => setManualChoices((current) => ({
                                          ...current,
                                          [row.sourceRow]: { routeId: choice.routeId, note: event.target.value },
                                        }))}
                                      />
                                    )}
                                    {choice?.routeId && choice.note.trim().length < 10 && <span className="text-amber-700">Add a 10-character mapping rationale to confirm.</span>}
                                  </div>
                                )}
                              </>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {preview.rows.length > 100 && <p className="text-xs text-muted-foreground">Showing the first 100 of {preview.rows.length.toLocaleString()} rows; all valid rows are included in the import.</p>}
            {Object.values(manualChoices).some((choice) => choice.routeId && choice.note.trim().length < 10) &&
              <p className="text-sm text-amber-700">Complete every chosen mapping note before import, or clear that route choice to leave the row unresolved.</p>}
            {selectedManualChoices.length > 50 && <p className="text-sm text-amber-700">Confirm at most 50 manual mappings per upload; import the remaining unresolved rows first and review them afterward.</p>}
            <Button type="button" onClick={() => void importRows()} disabled={isImporting || selectedManualChoices.length > 50 || !preview.rows.some((row) => !row.error)}>
              {isImporting ? "Importing source metrics…" : `Import ${preview.rows.filter((row) => !row.error).length} valid row(s)`}
            </Button>
            <Button type="button" variant="outline" onClick={() => {
              if (uploadedObjectPath) void removeTemporaryUpload(uploadedObjectPath).catch((cause) =>
                setError(cause instanceof Error ? cause.message : "Could not remove the temporary source upload."));
              setUploadedObjectPath("");
              uploadedObjectPathRef.current = "";
              setPreview(null);
              setManualChoices({});
            }}>Discard preview and source upload</Button>
          </div>
        )}

        <div className="space-y-3 border-t pt-4">
          <div>
            <h3 className="text-sm font-semibold">Imported source history and unresolved mappings</h3>
            <p className="mt-1 text-xs text-muted-foreground">Raw source files are not stored. Imported route metrics, file names, source rows, import times, and mapping decisions remain auditable.</p>
          </div>
          {importsQuery.isError && <p role="alert" className="text-sm text-destructive">{importsQuery.error instanceof Error ? importsQuery.error.message : "Import history could not be loaded."}</p>}
          {importsQuery.data?.length ? (
            <ul className="space-y-1 text-xs">
              {importsQuery.data.slice(0, 5).map((batch) => (
                <li key={batch.id} className="rounded border p-2">
                  {batch.sourceFile} · imported {new Date(batch.importedAt).toLocaleString()} · {batch.sourceRowCount} source row(s) · {batch.summary.MATCHED} matched / {batch.summary.AMBIGUOUS} ambiguous / {batch.summary.UNMATCHED} unmatched / {Math.max(0, batch.sourceRowCount - batch.summary.MATCHED - batch.summary.AMBIGUOUS - batch.summary.UNMATCHED)} invalid skipped
                </li>
              ))}
            </ul>
          ) : !importsQuery.isLoading ? <p className="text-xs text-muted-foreground">No RTA passenger metrics have been imported.</p> : null}
          {metricsQuery.isError && <p role="alert" className="text-sm text-destructive">{metricsQuery.error instanceof Error ? metricsQuery.error.message : "Passenger mapping data could not be loaded."}</p>}
          {metricsQuery.isLoading ? <p className="text-xs text-muted-foreground">Loading route mapping status…</p> :
            unresolvedMetrics.length > 0 ? (
              <div className="max-h-80 space-y-2 overflow-auto">
                {unresolvedMetrics.map((metric) => {
                  const choice = storedMappings[metric.id];
                  return (
                    <div key={metric.id} className="rounded border p-3 text-xs">
                      <div className="flex flex-wrap justify-between gap-2">
                        <strong>{metric.mappingStatus}: {metric.sourceRouteIdentifier}</strong>
                        <span>{metric.month} · {metric.passengerCount.toLocaleString()} passengers · {metric.sourceFile}, row {metric.sourceRow}</span>
                      </div>
                      <details className="mt-2">
                        <summary className="cursor-pointer text-muted-foreground">Original source row values</summary>
                        <dl className="mt-2 grid gap-1 sm:grid-cols-2">
                          {Object.entries(metric.sourceValues).map(([header, value]) => (
                            <div key={header} className="break-words"><dt className="inline font-medium">{header}: </dt><dd className="inline">{value || "—"}</dd></div>
                          ))}
                        </dl>
                      </details>
                      {metric.routeCandidates.length > 0 ? (() => {
                        const duplicateVariantRoute = metric.routeCandidates.some((candidate) =>
                          metric.routeCandidates.filter((other) => other.routeId === candidate.routeId).length > 1);
                        const normalizedVariant = metric.sourceVariantIdentifier?.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
                        const matchingCandidates = metric.routeCandidates.filter((candidate) => [
                          candidate.sourceVariantId ?? "",
                          candidate.sourceIdentity ?? "",
                          candidate.sourceSheet ?? "",
                          candidate.sourceRow == null ? "" : String(candidate.sourceRow),
                        ].some((value) => value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US") === normalizedVariant));
                        const allowedCandidates = duplicateVariantRoute ? matchingCandidates : metric.routeCandidates;
                        if (!allowedCandidates.length || (duplicateVariantRoute && matchingCandidates.length !== 1)) {
                          return <p className="mt-1 text-amber-700">Source row does not identify one specific route variant; this passenger record remains ambiguous and will not be attached to any variant.</p>;
                        }
                        return (
                        <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_2fr_auto]">
                          <select
                            className="h-9 rounded border bg-background px-2"
                            aria-label={`Candidate route for stored source row ${metric.sourceRow}`}
                            value={choice?.routeId ?? ""}
                            onChange={(event) => setStoredMappings((current) => ({
                              ...current,
                              [metric.id]: { routeId: event.target.value, note: current[metric.id]?.note ?? "" },
                            }))}
                          >
                            <option value="">Leave unmapped</option>
                            {allowedCandidates.map((candidate) => <option key={candidate.sourceVariantId ?? candidate.id} value={candidate.sourceVariantId ?? ""}>
                              {candidate.routeId}{candidate.sourceSheet ? ` · ${candidate.sourceSheet}` : ""}{candidate.sourceRow ? ` row ${candidate.sourceRow}` : ""}{candidate.from || candidate.to ? ` · ${candidate.from ?? "?"} → ${candidate.to ?? "?"}` : ""}
                            </option>)}
                          </select>
                          <Input
                            maxLength={500}
                            aria-label={`Stored mapping rationale for source row ${metric.sourceRow}`}
                            placeholder="Why is this existing route a correct match? (10+ characters)"
                            value={choice?.note ?? ""}
                            onChange={(event) => setStoredMappings((current) => ({
                              ...current,
                              [metric.id]: { routeId: choice?.routeId ?? "", note: event.target.value },
                            }))}
                          />
                          <Button type="button" size="sm" disabled={!choice?.routeId || choice.note.trim().length < 10 || updatingMetricId === metric.id} onClick={() => void confirmStoredMapping(metric.id)}>
                            {updatingMetricId === metric.id ? "Saving…" : "Confirm match"}
                          </Button>
                        </div>
                        );
                      })() : <p className="mt-1 text-muted-foreground">No existing bus-route candidate was safe to suggest. This row stays unmatched and does not affect recommendations.</p>}
                    </div>
                  );
                })}
              </div>
            ) : !metricsQuery.isLoading && <p className="text-xs text-muted-foreground">No unresolved passenger route mappings.</p>}
        </div>
      </CardContent>
    </Card>
  );
}