import { useState, useRef, useMemo } from "react";
import { useParams } from "wouter";
import {
  useGetInventoryQualitySummary,
  useListInventoryImports,
  usePreviewInventoryImport,
  useCommitInventoryImport,
  useGetInventorySyncStatus,
  useRunInventorySync,
  useListInventorySyncHistory,
  useGetInventorySourceHealth,
  useGetShelterSyncConflicts,
  useGetBusRoutesHealth,
  getListInventoryImportsQueryKey,
  getGetInventoryQualitySummaryQueryKey,
  getListInventoryAssetsQueryKey,
  getGetInventorySyncStatusQueryKey,
  getGetInventorySourceHealthQueryKey,
  getListInventorySyncHistoryQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { UploadCloud, CheckCircle2, AlertTriangle, FileSpreadsheet, MapPin, ImageIcon, CalendarX2, X, RefreshCw, Database, Activity, History, ServerCrash, LayoutList } from "lucide-react";
import Papa from "papaparse";
// @ts-ignore
import * as XLSX from "xlsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { AssetWorkspace } from "@/components/workspace/asset-workspace";
import { BusRoutesWorkspace } from "@/components/workspace/bus-routes-workspace";
import { MediaPlanWorkspace } from "@/components/workspace/media-plan-workspace";
import { NetworkPlanning } from "@/components/workspace/network-planning";

export function InventoryTab() {
  const { id: projectId } = useParams();
  const { data: qualitySummary, isLoading: isLoadingQuality } = useGetInventoryQualitySummary();
  const { data: imports, isLoading: isLoadingImports } = useListInventoryImports();
  const [importOpen, setImportOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [syncPanelOpen, setSyncPanelOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<string>(() => {
    const dataset = new URLSearchParams(window.location.search).get("dataset");
    return ["all-assets", "bus-shelters", "buses", "bus-routes", "media-plan", "brand-awareness"].includes(dataset ?? "")
      ? dataset! : "bus-shelters";
  });
  const changeTab = (tab: string) => {
    setActiveTab(tab);
    const url = new URL(window.location.href);
    url.searchParams.set("dataset", tab);
    window.history.replaceState(null, "", url);
  };

  return (
    <div className="h-[calc(100vh-140px)] flex flex-col -mx-4 -my-4 md:-mx-8 md:-my-8 bg-slate-50 dark:bg-slate-950">
      <div className="bg-white dark:bg-slate-900 px-4 py-3 border-b flex flex-col gap-2 shrink-0 min-w-0">
        <h2 className="text-lg font-semibold">Inventory &amp; Media Plan</h2>
        <div className="w-full overflow-x-auto">
          <Tabs value={activeTab} onValueChange={changeTab} className="w-max">
            <TabsList className="h-9 w-max">
              <TabsTrigger value="all-assets" className="text-xs px-3 md:px-4">All Assets</TabsTrigger>
              <TabsTrigger value="bus-shelters" className="text-xs px-3 md:px-4">Bus Shelters</TabsTrigger>
              <TabsTrigger value="buses" className="text-xs px-3 md:px-4">Buses</TabsTrigger>
              <TabsTrigger value="bus-routes" className="text-xs px-3 md:px-4">Bus Routes</TabsTrigger>
              {projectId && (
                <TabsTrigger value="media-plan" className="text-xs px-3 md:px-4 bg-brand/10 text-brand data-[state=active]:bg-brand data-[state=active]:text-brand-foreground">
                  Media Plan
                </TabsTrigger>
              )}
              {projectId && (
                <TabsTrigger value="brand-awareness" className="text-xs px-3 md:px-4">
                  Brand Awareness
                </TabsTrigger>
              )}
            </TabsList>
          </Tabs>
        </div>
          <div className="flex gap-2 items-center flex-wrap">
            <Button variant="outline" size="sm" onClick={() => setSyncPanelOpen(true)} className="gap-2 border-brand text-brand hover:bg-brand/10">
              <RefreshCw className="h-4 w-4" /> Source Sync
            </Button>
            <Button variant="outline" size="sm" onClick={() => setStatsOpen(!statsOpen)}>
              {statsOpen ? "Hide Quality & History" : "Quality & History"}
            </Button>
            <Button size="sm" onClick={() => setImportOpen(true)} className="gap-2 bg-slate-800 hover:bg-slate-700 text-white dark:bg-slate-700 dark:hover:bg-slate-600">
              <UploadCloud className="h-4 w-4" /> Import CSV
            </Button>
          </div>
      </div>

      {statsOpen && (
        <div className="p-4 bg-slate-100 dark:bg-slate-800/50 border-b shrink-0 space-y-4">
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
            <QualityCard title="Total Assets" value={qualitySummary?.totalAssets} icon={FileSpreadsheet} isLoading={isLoadingQuality} />
            <QualityCard title="Complete" value={qualitySummary?.complete} icon={CheckCircle2} isLoading={isLoadingQuality} intent="success" />
            <QualityCard title="Missing Location" value={qualitySummary?.missingCoordinates} icon={MapPin} isLoading={isLoadingQuality} intent="warning" />
            <QualityCard title="Missing Photo" value={qualitySummary?.missingPhoto} icon={ImageIcon} isLoading={isLoadingQuality} intent="warning" />
            <QualityCard title="Missing Availability" value={qualitySummary?.missingAvailability} icon={CalendarX2} isLoading={isLoadingQuality} intent="warning" />
          </div>

          <Card>
            <CardHeader className="py-3 px-4">
              <CardTitle className="text-sm">Recent Imports</CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              {isLoadingImports ? (
                <Skeleton className="h-10 w-full" />
              ) : !imports || imports.length === 0 ? (
                <div className="text-sm text-muted-foreground text-center py-4">No imports yet.</div>
              ) : (
                <div className="max-h-[150px] overflow-y-auto border rounded">
                  <Table>
                    <TableHeader className="bg-slate-50 dark:bg-slate-900 sticky top-0">
                      <TableRow>
                        <TableHead className="py-2 h-auto text-xs">Date</TableHead>
                        <TableHead className="py-2 h-auto text-xs">File</TableHead>
                        <TableHead className="py-2 h-auto text-xs">Status</TableHead>
                        <TableHead className="py-2 h-auto text-xs text-right">Added</TableHead>
                        <TableHead className="py-2 h-auto text-xs text-right">Updated</TableHead>
                        <TableHead className="py-2 h-auto text-xs text-right">Skipped</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {imports.map((imp) => (
                        <TableRow key={imp.id}>
                          <TableCell className="py-2 text-xs">{format(new Date(imp.createdAt), "MMM d, HH:mm")}</TableCell>
                          <TableCell className="py-2 text-xs font-medium">{imp.fileName || "Unknown"}</TableCell>
                          <TableCell className="py-2">
                            <Badge variant={imp.status === 'committed' ? 'default' : 'secondary'} className="text-[10px] px-1 py-0 h-4">
                              {imp.status}
                            </Badge>
                          </TableCell>
                          <TableCell className="py-2 text-xs text-right text-green-600">{imp.addedCount}</TableCell>
                          <TableCell className="py-2 text-xs text-right text-blue-600">{imp.updatedCount}</TableCell>
                          <TableCell className="py-2 text-xs text-right text-muted-foreground">{imp.skippedCount}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {activeTab === "all-assets" && (
        <AssetWorkspace projectId={projectId} defaultView="list" />
      )}

      {activeTab === "bus-shelters" && (
        <AssetWorkspace projectId={projectId} defaultView="list" baseFilters={{ sourceFamily: "BUS_SHELTER" }} />
      )}
      
      {activeTab === "buses" && (
        <AssetWorkspace projectId={projectId} defaultView="list" baseFilters={{ sourceFamily: "BUS" }} showBusesEmptyState />
      )}
      
      {activeTab === "bus-routes" && (
        <BusRoutesWorkspace projectId={projectId} />
      )}

      {activeTab === "media-plan" && projectId && (
        <MediaPlanWorkspace projectId={projectId} />
      )}

      {activeTab === "brand-awareness" && projectId && (
        <NetworkPlanning projectId={projectId} />
      )}

      <ImportDialog open={importOpen} onOpenChange={setImportOpen} />
      <SourceSyncDialog open={syncPanelOpen} onOpenChange={setSyncPanelOpen} />
    </div>
  );
}

function QualityCard({ title, value, icon: Icon, isLoading, intent = "default" }: { title: string, value?: number, icon: any, isLoading: boolean, intent?: "default" | "success" | "warning" | "danger" }) {
  const iconColor = {
    default: "text-brand",
    success: "text-green-500",
    warning: "text-amber-500",
    danger: "text-destructive"
  }[intent];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0 px-4 pt-4">
        <CardTitle className="text-xs font-medium text-muted-foreground">{title}</CardTitle>
        <Icon className={`h-4 w-4 ${iconColor}`} />
      </CardHeader>
      <CardContent className="px-4 pb-4">
        {isLoading ? (
          <Skeleton className="h-6 w-16" />
        ) : (
          <div className="text-xl font-bold">{value || 0}</div>
        )}
      </CardContent>
    </Card>
  );
}

function ImportDialog({ open, onOpenChange }: { open: boolean, onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<"upload" | "mapping" | "preview">("upload");
  const [file, setFile] = useState<File | null>(null);
  const [rawData, setRawData] = useState<any[]>([]);
  const [headers, setHeaders] = useState<string[]>([]);

  // mapping is { systemField: sourceHeader }
  const [mapping, setMapping] = useState<Record<string, string>>({});

  const previewMutation = usePreviewInventoryImport();
  const commitMutation = useCommitInventoryImport();

  const [previewData, setPreviewData] = useState<any>(null);
  const [decisions, setDecisions] = useState<Record<number, "add" | "update" | "skip">>({});

  const [confirmOpen, setConfirmOpen] = useState(false);

  const EXPECTED_FIELDS = [
    "assetCode", "assetType", "assetSubtype", "assetName", "area", "road", "direction",
    "emirate", "availability", "latitude", "longitude", "photoPath", "mapUrl", "rate",
    "displayTechnology", "client", "campaign", "routes", "depot", "nearbyPois", "audienceTags", "internalNotes", "startDate", "endDate", "mediaFormat", "dimensions",
    "bookingStatus", "trafficVisibility", "tags"
  ];

  const reset = () => {
    setStep("upload");
    setFile(null);
    setRawData([]);
    setHeaders([]);
    setMapping({});
    setPreviewData(null);
    setDecisions({});
    setConfirmOpen(false);
  };

  const handleOpenChange = (o: boolean) => {
    if (!o) reset();
    onOpenChange(o);
  };

  const processFile = (file: File) => {
    setFile(file);
    if (file.name.endsWith(".csv")) {
      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        complete: (results) => {
          if (results.meta.fields) {
            if (results.data.length === 0) {
              toast({ title: "Error", description: "CSV file is empty", variant: "destructive" });
              return;
            }
            setHeaders(results.meta.fields);
            setRawData(results.data);
            autoMapHeaders(results.meta.fields);
            setStep("mapping");
          }
        },
        error: (err) => {
          toast({ title: "Error parsing CSV", description: err.message, variant: "destructive" });
        }
      });
    } else if (file.name.endsWith(".xlsx") || file.name.endsWith(".xls")) {
      const reader = new FileReader();
      reader.onload = (e) => {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: "array" });
        const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
        const json = XLSX.utils.sheet_to_json(firstSheet, { defval: "" });
        if (json.length > 0) {
          const hdrs = Object.keys(json[0] as object);
          setHeaders(hdrs);
          setRawData(json);
          autoMapHeaders(hdrs);
          setStep("mapping");
        } else {
          toast({ title: "Error", description: "Spreadsheet is empty", variant: "destructive" });
        }
      };
      reader.readAsArrayBuffer(file);
    } else {
      toast({ title: "Unsupported file", description: "Please upload a CSV or XLSX file.", variant: "destructive" });
    }
  };

  const autoMapHeaders = (hdrs: string[]) => {
    const newMap: Record<string, string> = {};
    const aliases: Record<string, string> = {
      id: "assetCode", assetid: "assetCode", code: "assetCode",
      type: "assetType", status: "availability",
      lat: "latitude", lon: "longitude", lng: "longitude",
      street: "road", route: "routes", busroute: "routes",
      poi: "nearbyPois", pois: "nearbyPois", photo: "photoPath",
    };
    hdrs.forEach(h => {
      const normalized = h.toLowerCase().replace(/[^a-z0-9]/g, "");
      const match = EXPECTED_FIELDS.find(ef => ef.toLowerCase() === normalized) ?? aliases[normalized];
      if (match && !newMap[match]) newMap[match] = h;
    });
    setMapping(newMap);
  };

  const handlePreview = () => {
    if (!mapping.assetCode || !mapping.assetType) {
      toast({ title: "Mapping Required", description: "Map both Asset ID (assetCode) and Asset type (assetType).", variant: "destructive" });
      return;
    }

    previewMutation.mutate({
      data: {
        fileName: file?.name,
        mapping,
        rows: rawData
      }
    }, {
      onSuccess: (data) => {
        setPreviewData(data);
        const newDecisions: Record<number, "add" | "update" | "skip"> = {};
        data.rows.forEach(r => {
          // Never auto-commit updates: default to SKIP
          newDecisions[r.rowIndex] = r.suggestedAction === "update" ? "skip" : r.suggestedAction;
        });
        setDecisions(newDecisions);
        setStep("preview");
      },
      onError: (err: any) => {
        toast({ title: "Preview Failed", description: err.message, variant: "destructive" });
      }
    });
  };

  const requestCommit = () => {
    if (!previewData?.confirmable) return;
    setConfirmOpen(true);
  };

  const handleCommit = () => {
    const decisionArray = Object.entries(decisions).map(([rowIndex, action]) => ({
      rowIndex: parseInt(rowIndex, 10),
      action
    }));

    commitMutation.mutate({
      data: {
        fileName: file?.name,
        mapping,
        rows: rawData,
        decisions: decisionArray
      }
    }, {
      onSuccess: (result: any) => {
        const added = result?.addedCount || 0;
        const updated = result?.updatedCount || 0;
        toast({ title: "Import Successful", description: `Added ${added}, Updated ${updated} assets.` });

        queryClient.invalidateQueries({ queryKey: getListInventoryImportsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetInventoryQualitySummaryQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListInventoryAssetsQueryKey() });

        setConfirmOpen(false);
        handleOpenChange(false);
      },
      onError: (err: any) => {
        toast({ title: "Import Failed", description: err.message, variant: "destructive" });
        setConfirmOpen(false);
      }
    });
  };

  // Helper to change mapping { systemField: sourceHeader }
  const handleMapChange = (hdr: string, systemField: string) => {
    setMapping(prev => {
      const newMap = { ...prev };
      // Remove any existing systemField mapping for this header
      Object.keys(newMap).forEach(k => { if (newMap[k] === hdr) delete newMap[k]; });
      if (systemField !== "ignore") newMap[systemField] = hdr;
      return newMap;
    });
  };

  // Find system field for header
  const getMappedFieldForHeader = (hdr: string) => {
    return Object.keys(mapping).find(k => mapping[k] === hdr) || "ignore";
  };

  // Counts based on current decisions
  const counts = useMemo(() => {
    const c = { add: 0, update: 0, skip: 0 };
    Object.values(decisions).forEach(d => { c[d]++; });
    return c;
  }, [decisions]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Import Inventory Assets</DialogTitle>
          <DialogDescription>
            {step === "upload" && "Upload a CSV or XLSX file containing asset data."}
            {step === "mapping" && "Map your file columns to the system fields."}
            {step === "preview" && "Review changes before committing to the database. Updates are skipped by default."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto min-h-0 py-4">
          {step === "upload" && (
            <div
              className="border-2 border-dashed rounded-xl p-12 text-center cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-900 transition-colors"
              onClick={() => fileInputRef.current?.click()}
            >
              <input
                type="file"
                ref={fileInputRef}
                className="hidden"
                accept=".csv,.xlsx,.xls"
                onChange={(e) => {
                  if (e.target.files && e.target.files[0]) processFile(e.target.files[0]);
                }}
              />
              <UploadCloud className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="font-semibold text-lg">Click to browse files</h3>
              <p className="text-sm text-muted-foreground mt-2">Supports CSV and Excel files (XLSX, XLS)</p>
            </div>
          )}

          {step === "mapping" && (
            <div className="space-y-4">
              <div className={`p-3 rounded-md text-sm ${mapping.assetCode && mapping.assetType ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-200" : "bg-amber-50 text-amber-800 dark:bg-amber-950/30 dark:text-amber-200"}`}>
                {mapping.assetCode && mapping.assetType
                  ? "Required columns mapped: Asset ID and Asset type."
                  : "Required: map both Asset ID (assetCode) and Asset type (assetType)."}
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-1/2">File Header</TableHead>
                    <TableHead className="w-1/2">System Field</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {headers.map((hdr) => (
                    <TableRow key={hdr}>
                      <TableCell className="font-medium text-sm">
                        {hdr}
                        <div className="text-xs font-normal text-muted-foreground truncate max-w-[280px]">
                          {rawData.slice(0, 3).map(row => String(row[hdr] ?? "").slice(0, 80))
                            .filter(Boolean).join(" · ") || "No values in first rows"}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Select
                          value={getMappedFieldForHeader(hdr)}
                          onValueChange={(val) => handleMapChange(hdr, val)}
                        >
                          <SelectTrigger className={getMappedFieldForHeader(hdr) === 'assetCode' ? 'border-brand' : ''}>
                            <SelectValue placeholder="Ignore" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="ignore">-- Ignore --</SelectItem>
                            {EXPECTED_FIELDS.sort().map(f => (
                              <SelectItem key={f} value={f}>
                                {f} {f === 'assetCode' ? '*' : ''}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {step === "preview" && previewData && (
            <div className="space-y-6">
              <div className="grid grid-cols-4 gap-4 text-center">
                <div className="p-4 bg-slate-50 dark:bg-slate-900 rounded-lg border">
                  <div className="text-2xl font-bold">{previewData.rowCount}</div>
                  <div className="text-sm text-muted-foreground">Total Rows</div>
                </div>
                <div className="p-4 bg-green-50 dark:bg-green-950/20 text-green-700 dark:text-green-400 rounded-lg border border-green-200 dark:border-green-900">
                  <div className="text-2xl font-bold">{counts.add}</div>
                  <div className="text-sm">To Add</div>
                </div>
                <div className="p-4 bg-blue-50 dark:bg-blue-950/20 text-blue-700 dark:text-blue-400 rounded-lg border border-blue-200 dark:border-blue-900">
                  <div className="text-2xl font-bold">{counts.update}</div>
                  <div className="text-sm">To Update</div>
                </div>
                <div className="p-4 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 rounded-lg border">
                  <div className="text-2xl font-bold">{counts.skip}</div>
                  <div className="text-sm">To Skip · {previewData.invalidCount} invalid</div>
                </div>
              </div>

              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-16">Row</TableHead>
                    <TableHead>Asset Code</TableHead>
                    <TableHead>Issues</TableHead>
                    <TableHead className="w-32 text-right">Decision</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {previewData.rows.map((row: any) => (
                    <TableRow key={row.rowIndex}>
                      <TableCell>{row.rowIndex + 1}</TableCell>
                      <TableCell className="font-medium text-sm">{row.assetCode || <span className="italic text-muted-foreground">Missing</span>}</TableCell>
                      <TableCell>
                        {row.issues && row.issues.length > 0 ? (
                          <div className="flex flex-col gap-1">
                            {row.issues.map((iss: string, i: number) => (
                              <span key={i} className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1">
                                <AlertTriangle className="h-3 w-3 shrink-0" /> {iss}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">None</span>
                        )}
                        {row.suggestedAction === "update" && (
                          <div className="text-xs text-blue-600 mt-1">Existing asset found. Defaulted to SKIP.</div>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <Select
                          value={decisions[row.rowIndex] || "skip"}
                          onValueChange={(val: any) => setDecisions(prev => ({ ...prev, [row.rowIndex]: val }))}
                        >
                          <SelectTrigger className={`w-full h-8 ${decisions[row.rowIndex] === 'update' ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/30' : ''}`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="add" disabled={row.suggestedAction !== "add"}>Add</SelectItem>
                            <SelectItem value="update" disabled={row.suggestedAction === "add" || row.issues?.length > 0}>Update</SelectItem>
                            <SelectItem value="skip">Skip</SelectItem>
                          </SelectContent>
                        </Select>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>

        <DialogFooter className="mt-4 pt-4 border-t">
          {step === "mapping" && (
            <>
              <Button variant="outline" onClick={() => setStep("upload")}>Back</Button>
              <Button onClick={handlePreview} disabled={previewMutation.isPending || !mapping.assetCode || !mapping.assetType}>
                {previewMutation.isPending ? "Analyzing..." : "Analyze File"}
              </Button>
            </>
          )}
          {step === "preview" && (
            <>
              <Button variant="outline" onClick={() => setStep("mapping")}>Back</Button>
              <Button onClick={requestCommit} disabled={commitMutation.isPending || !previewData?.confirmable || (counts.add === 0 && counts.update === 0)}>
                {commitMutation.isPending ? "Preparing..." : `Commit ${counts.add + counts.update} Records`}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm Inventory Import</AlertDialogTitle>
            <AlertDialogDescription>
              You are about to add <strong>{counts.add}</strong> new assets and update <strong>{counts.update}</strong> existing assets in the global database.
              {counts.update > 0 && " This action will overwrite existing fields for updated assets."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={commitMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleCommit} disabled={commitMutation.isPending} className="bg-brand text-brand-foreground hover:bg-brand/90">
              {commitMutation.isPending ? "Committing..." : "Yes, Commit Data"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </Dialog>
  );
}
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown, ChevronUp } from "lucide-react";

function SourceSyncDialog({ open, onOpenChange }: { open: boolean, onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: status, isLoading: isLoadingStatus } = useGetInventorySyncStatus({
    query: { enabled: open, queryKey: getGetInventorySyncStatusQueryKey() }
  });

  const { data: health, isLoading: isLoadingHealth } = useGetInventorySourceHealth({
    query: { enabled: open, queryKey: getGetInventorySourceHealthQueryKey() }
  });

  const { data: conflicts, isLoading: isLoadingConflicts } = useGetShelterSyncConflicts({
    query: { enabled: open, queryKey: ["shelterSyncConflicts"] }
  });

  const { data: busRoutesHealth, isLoading: isLoadingBusRoutesHealth } = useGetBusRoutesHealth({
    query: { enabled: open, queryKey: ["busRoutesHealth"] }
  });

  const { data: history, isLoading: isLoadingHistory } = useListInventorySyncHistory({
    query: { enabled: open, queryKey: getListInventorySyncHistoryQueryKey() }
  });

  const runSync = useRunInventorySync();

  const handleSync = () => {
    runSync.mutate(undefined, {
      onSuccess: (run) => {
        toast({
          title: run.duplicateCount ? "Sync completed with records needing review" : "Sync Complete",
          description: run.duplicateCount
            ? `${run.duplicateCount} conflicting shelter IDs were skipped. See Source Health and Sync History.`
            : `Added ${run.addedCount}, updated ${run.updatedCount}, unchanged ${run.unchangedCount}.`,
        });
        queryClient.invalidateQueries({ queryKey: getGetInventorySyncStatusQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetInventorySourceHealthQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListInventorySyncHistoryQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListInventoryAssetsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetInventoryQualitySummaryQueryKey() });
      },
      onError: (err: any) => {
        toast({ title: "Sync Failed", description: err.message || "Failed to run sync.", variant: "destructive" });
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col p-0 overflow-hidden">
        <div className="px-6 py-4 border-b shrink-0 flex items-center justify-between bg-slate-50/50 dark:bg-slate-900/50">
          <div>
            <DialogTitle className="text-lg flex items-center gap-2">
              <Database className="h-5 w-5 text-brand" />
              Source Integration
            </DialogTitle>
            <DialogDescription className="mt-1">
              Manage upstream inventory source connections and verify data quality.
            </DialogDescription>
          </div>

          {!isLoadingStatus && status && (
            <div className="flex items-center gap-4">
              <div className="flex flex-col items-end text-sm">
                <span className="text-muted-foreground text-xs">Connection State</span>
                {status.connectionStatus === 'connected' ? (
                  <span className="text-emerald-600 dark:text-emerald-400 font-medium flex items-center gap-1"><CheckCircle2 className="h-3 w-3"/> Connected</span>
                ) : status.connectionStatus === 'not_configured' ? (
                  <span className="text-slate-500 font-medium">Not Configured</span>
                ) : status.connectionStatus === 'error' ? (
                  <span className="text-destructive font-medium flex items-center gap-1"><ServerCrash className="h-3 w-3"/> Error</span>
                ) : (
                  <span className="text-amber-600 font-medium">Awaiting First Sync</span>
                )}
              </div>
              <Button
                onClick={handleSync}
                disabled={runSync.isPending || status.connectionStatus === 'not_configured'}
                className="bg-brand text-brand-foreground hover:bg-brand/90 gap-2"
              >
                <RefreshCw className={`h-4 w-4 ${runSync.isPending ? 'animate-spin' : ''}`} />
                {runSync.isPending ? 'Syncing...' : 'Sync Now'}
              </Button>
            </div>
          )}
        </div>

        {!isLoadingStatus && status && !status.configured && (
          <div className="bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-900/50 p-4 text-sm text-amber-800 dark:text-amber-200 shrink-0">
            <strong>Source Not Configured:</strong> The upstream inventory source integration has not been set up. Please ensure a Google Sheets account is connected and the SHELTER_MASTER_SHEET_ID is set in the workspace environment.
          </div>
        )}

        <div className="flex-1 overflow-y-auto min-h-0 bg-white dark:bg-slate-950">
          {isLoadingStatus ? (
            <div className="p-6 space-y-4">
              <Skeleton className="h-32 w-full" />
              <Skeleton className="h-64 w-full" />
            </div>
          ) : (
            <Tabs defaultValue="health" className="w-full flex flex-col h-full">
            <div className="px-6 border-b shrink-0 bg-slate-50/30 dark:bg-slate-900/30">
              <TabsList className="h-12 bg-transparent">
                  <TabsTrigger value="health" className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-brand rounded-none h-12 px-4 gap-2">
                    <Activity className="h-4 w-4" /> Shelter Health
                  </TabsTrigger>
                  <TabsTrigger value="bus-routes-health" className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-brand rounded-none h-12 px-4 gap-2">
                    <MapPin className="h-4 w-4" /> Bus Routes Health
                  </TabsTrigger>
                  <TabsTrigger value="conflicts" className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-brand rounded-none h-12 px-4 gap-2">
                    <LayoutList className="h-4 w-4" /> Sync Conflicts
                  </TabsTrigger>
                  <TabsTrigger value="history" className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-brand rounded-none h-12 px-4 gap-2">
                    <History className="h-4 w-4" /> Sync History
                  </TabsTrigger>
                </TabsList>
              </div>

              <TabsContent value="health" className="flex-1 overflow-y-auto p-6 m-0 outline-none">
                {isLoadingHealth ? (
                  <div className="space-y-4"><Skeleton className="h-24 w-full" /><Skeleton className="h-48 w-full" /></div>
                ) : health ? (
                  <div className="space-y-6">
                    <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                      <div className="p-4 border rounded-lg bg-white dark:bg-slate-900">
                        <div className="text-xs font-medium text-muted-foreground mb-1">Active Records</div>
                        <div className="text-2xl font-bold">{health.activeSourceRecords}</div>
                        <div className="text-[10px] text-muted-foreground mt-1">
                          Source rows: {health.sourceRows}
                          {health.importedRecords > 0 && <span className="ml-1 text-blue-600">({health.importedRecords} imported)</span>}
                        </div>
                      </div>
                      <div className="p-4 border rounded-lg bg-emerald-50 dark:bg-emerald-950/20 text-emerald-800 dark:text-emerald-400">
                        <div className="text-xs font-medium mb-1 opacity-80">New Assets</div>
                        <div className="text-2xl font-bold">+{health.newAssets}</div>
                      </div>
                      <div className="p-4 border rounded-lg bg-blue-50 dark:bg-blue-950/20 text-blue-800 dark:text-blue-400">
                        <div className="text-xs font-medium mb-1 opacity-80">Changed Assets</div>
                        <div className="text-2xl font-bold">~{health.changedAssets}</div>
                      </div>
                      <div className="p-4 border rounded-lg bg-rose-50 dark:bg-rose-950/20 text-rose-800 dark:text-rose-400">
                        <div className="text-xs font-medium mb-1 opacity-80">Removed</div>
                        <div className="text-2xl font-bold">-{health.removedRecords}</div>
                      </div>
                      <div className="p-4 border rounded-lg bg-amber-50 dark:bg-amber-950/20 text-amber-800 dark:text-amber-400">
                        <div className="text-xs font-medium mb-1 opacity-80">Missing</div>
                        <div className="text-2xl font-bold">-{health.missingFromSource}</div>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div className="border rounded-lg p-4 bg-white dark:bg-slate-900">
                        <h4 className="text-sm font-semibold mb-4 flex items-center gap-2">
                          <AlertTriangle className="h-4 w-4 text-amber-500" />
                          Data Quality Flags
                        </h4>
                        <div className="space-y-3">
                          <div className="flex justify-between items-center text-sm">
                            <span className="text-muted-foreground">Invalid Coordinates</span>
                            <span className="font-medium text-amber-600">{health.invalidCoordinates}</span>
                          </div>
                          <div className="flex justify-between items-center text-sm">
                            <span className="text-muted-foreground">Missing Media Type</span>
                            <span className="font-medium text-amber-600">{health.missingMediaType}</span>
                          </div>
                          <div className="flex justify-between items-center text-sm">
                            <span className="text-muted-foreground">Duplicate Source Keys</span>
                            <span className="font-medium text-destructive">{health.duplicateSourceKeys}</span>
                          </div>
                        </div>
                      </div>

                      <div className="border rounded-lg p-4 bg-white dark:bg-slate-900">
                        <h4 className="text-sm font-semibold mb-4">Configuration Breakdown</h4>
                        <div className="space-y-3">
                          <div className="flex justify-between items-center text-sm">
                            <span className="text-muted-foreground">Single Configurations</span>
                            <span className="font-medium">{health.singleCount}</span>
                          </div>
                          <div className="flex justify-between items-center text-sm">
                            <span className="text-muted-foreground">Double Configurations</span>
                            <span className="font-medium">{health.doubleCount}</span>
                          </div>
                          <div className="mt-4 pt-4 border-t">
                            <h5 className="text-xs font-medium text-muted-foreground mb-3">Type Distribution</h5>
                            {Object.entries(health.typeDistribution || {}).map(([type, count]) => (
                              <div key={type} className="flex justify-between items-center text-sm mb-1">
                                <span>{type}</span>
                                <span className="font-medium">{count as number}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="text-center py-12 text-muted-foreground">Health data unavailable.</div>
                )}
              </TabsContent>

              <TabsContent value="bus-routes-health" className="flex-1 overflow-y-auto p-6 m-0 outline-none">
                {isLoadingBusRoutesHealth ? (
                  <div className="space-y-4"><Skeleton className="h-24 w-full" /><Skeleton className="h-48 w-full" /></div>
                ) : busRoutesHealth ? (
                  <div className="space-y-6">
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                      <div className="p-4 border rounded-lg bg-white dark:bg-slate-900">
                        <div className="text-xs font-medium text-muted-foreground mb-1">Valid Source Rows</div>
                        <div className="text-2xl font-bold">{busRoutesHealth.validSourceRows}</div>
                      </div>
                      <div className="p-4 border rounded-lg bg-emerald-50 dark:bg-emerald-950/20 text-emerald-800 dark:text-emerald-400">
                        <div className="text-xs font-medium mb-1 opacity-80">Distinct Routes</div>
                        <div className="text-2xl font-bold">{busRoutesHealth.distinctRouteIds}</div>
                      </div>
                      <div className="p-4 border rounded-lg bg-amber-50 dark:bg-amber-950/20 text-amber-800 dark:text-amber-400">
                        <div className="text-xs font-medium mb-1 opacity-80">Duplicate IDs</div>
                        <div className="text-2xl font-bold">{busRoutesHealth.duplicateRouteIds}</div>
                      </div>
                      <div className="p-4 border rounded-lg bg-blue-50 dark:bg-blue-950/20 text-blue-800 dark:text-blue-400">
                         <div className="text-xs font-medium mb-1 opacity-80">Routes Missing from Source</div>
                        <div className="text-2xl font-bold">{busRoutesHealth.missingFromSourceRoutes}</div>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div className="border rounded-lg p-4 bg-white dark:bg-slate-900">
                        <h4 className="text-sm font-semibold mb-4 flex items-center gap-2">
                          <AlertTriangle className="h-4 w-4 text-amber-500" />
                          Missing Data Quality Flags
                        </h4>
                        <div className="space-y-3">
                          <div className="flex justify-between items-center text-sm">
                            <span className="text-muted-foreground">Missing 'From'</span>
                            <span className="font-medium text-amber-600">{busRoutesHealth.missingFromCount}</span>
                          </div>
                          <div className="flex justify-between items-center text-sm">
                            <span className="text-muted-foreground">Missing 'To'</span>
                            <span className="font-medium text-amber-600">{busRoutesHealth.missingToCount}</span>
                          </div>
                          <div className="flex justify-between items-center text-sm">
                            <span className="text-muted-foreground">Missing 'Via'</span>
                            <span className="font-medium text-amber-600">{busRoutesHealth.missingViaCount}</span>
                          </div>
                          <div className="flex justify-between items-center text-sm">
                            <span className="text-muted-foreground">Missing Depot</span>
                            <span className="font-medium text-amber-600">{busRoutesHealth.missingDepotCount}</span>
                          </div>
                          <div className="flex justify-between items-center text-sm">
                            <span className="text-muted-foreground">Missing Source Count</span>
                            <span className="font-medium text-amber-600">{busRoutesHealth.missingSourceBusCount}</span>
                          </div>
                        </div>
                      </div>

                      <div className="border rounded-lg p-4 bg-white dark:bg-slate-900">
                        <h4 className="text-sm font-semibold mb-4">Last Sync Status</h4>
                        <div className="flex justify-between items-center text-sm mb-3">
                          <span className="text-muted-foreground">Last successful sync</span>
                          <span className="font-medium">{busRoutesHealth.lastSuccessfulSyncAt
                            ? format(new Date(busRoutesHealth.lastSuccessfulSyncAt), "MMM d, yyyy HH:mm")
                            : "None yet"}</span>
                        </div>
                        {busRoutesHealth.lastSync ? (
                          <div className="space-y-3">
                            <div className="flex justify-between items-center text-sm">
                              <span className="text-muted-foreground">Status</span>
                              <span className="font-medium">{busRoutesHealth.lastSync.status}</span>
                            </div>
                            <div className="flex justify-between items-center text-sm">
                              <span className="text-muted-foreground">Started At</span>
                              <span className="font-medium">{format(new Date(busRoutesHealth.lastSync.startedAt), "MMM d, yyyy HH:mm")}</span>
                            </div>
                            <div className="flex justify-between items-center text-sm">
                              <span className="text-muted-foreground">Added</span>
                              <span className="font-medium text-emerald-600">+{busRoutesHealth.lastSync.addedCount}</span>
                            </div>
                            <div className="flex justify-between items-center text-sm">
                              <span className="text-muted-foreground">Updated</span>
                              <span className="font-medium text-blue-600">~{busRoutesHealth.lastSync.updatedCount}</span>
                            </div>
                             <div className="flex justify-between items-center text-sm">
                               <span className="text-muted-foreground">Unchanged</span>
                               <span className="font-medium">{busRoutesHealth.lastSync.unchangedCount}</span>
                             </div>
                             <div className="flex justify-between items-center text-sm">
                               <span className="text-muted-foreground">Missing source rows</span>
                               <span className="font-medium text-amber-600">{busRoutesHealth.lastSync.inactiveCount}</span>
                             </div>
                          </div>
                        ) : (
                          <div className="text-sm text-muted-foreground">No sync history available.</div>
                        )}
                      </div>
                    </div>
                    {busRoutesHealth.inactiveRoutes.length > 0 && (
                      <div className="border rounded-lg p-4 bg-white dark:bg-slate-900">
                        <h4 className="text-sm font-semibold mb-3">MISSING_FROM_SOURCE routes · review required</h4>
                        <div className="flex flex-wrap gap-2">
                          {busRoutesHealth.inactiveRoutes.map((route) => (
                            <Badge key={route.routeId} variant="outline">{route.routeId}</Badge>
                          ))}
                        </div>
                      </div>
                    )}
                    {busRoutesHealth.selectedMissingVariants.length > 0 && (
                      <div className="border border-amber-300 rounded-lg p-4 bg-amber-50 dark:bg-amber-950/20">
                        <h4 className="text-sm font-semibold mb-2">Pitch selections on missing source rows</h4>
                        <p className="text-xs text-muted-foreground mb-3">Selections are retained for review, not silently removed or reassigned to another depot or route row.</p>
                        <div className="space-y-2">
                          {busRoutesHealth.selectedMissingVariants.map((selection) => (
                            <div key={selection.selectionId} className="text-sm border rounded bg-white dark:bg-slate-900 p-3">
                              <span className="font-medium">Route {selection.routeId}</span> · {selection.depot ?? "Depot unknown"} · {selection.sourceSheet} row {selection.sourceRow}
                              <span className="block text-xs text-muted-foreground">Project {selection.projectId} · {selection.proposedQuantity} proposed buses · {selection.selectionStatus} · {selection.healthStatus}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-center py-12 text-muted-foreground">Bus Routes health data unavailable.</div>
                )}
              </TabsContent>

              <TabsContent value="conflicts" className="flex-1 overflow-y-auto p-6 m-0 outline-none">
                {isLoadingConflicts ? (
                  <div className="space-y-4"><Skeleton className="h-32 w-full" /><Skeleton className="h-32 w-full" /></div>
                ) : conflicts && conflicts.length > 0 ? (
                  <div className="space-y-6">
                    <div className="bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900 rounded-lg p-4 text-sm text-amber-800 dark:text-amber-300 flex items-start gap-3">
                      <AlertTriangle className="h-5 w-5 mt-0.5 shrink-0" />
                      <div>
                        <strong className="block mb-1">Duplicate Shelter IDs Detected</strong>
                        These records have the same Shelter ID but conflicting data fields. They have been quarantined and skipped during sync. In the future, you will be able to review and resolve these conflicts manually.
                      </div>
                    </div>
                    {conflicts.map((conflict, i) => (
                      <Card key={i} className="overflow-hidden border-destructive/20">
                        <div className="bg-slate-50 dark:bg-slate-900 px-4 py-3 border-b flex justify-between items-center">
                          <div className="font-medium flex items-center gap-2">
                            <span className="text-muted-foreground font-normal">Sheet:</span> {conflict.sheet}
                            <span className="text-muted-foreground font-normal ml-2">Shelter ID:</span> <Badge variant="outline">{conflict.shelterNumber}</Badge>
                          </div>
                          <Badge variant="secondary" className="bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-400">Needs Review</Badge>
                        </div>
                        <div className="p-0 overflow-x-auto">
                          <Table>
                            <TableHeader>
                              <TableRow className="bg-slate-50/50 dark:bg-slate-900/50">
                                <TableHead className="w-[150px] border-r">Field</TableHead>
                                {conflict.rows.map(row => (
                                  <TableHead key={row.sourceRow}>Row {row.sourceRow}</TableHead>
                                ))}
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {[
                                { label: "Stop Name", key: "stopName" as keyof typeof conflict.rows[0] },
                                { label: "Area", key: "area" as keyof typeof conflict.rows[0] },
                                { label: "Coordinates", key: "coordinates" as keyof typeof conflict.rows[0] },
                                { label: "Type", key: "type" as keyof typeof conflict.rows[0] },
                                { label: "Accountability", key: "accountability" as keyof typeof conflict.rows[0] },
                                { label: "Removal Status", key: "removalStatus" as keyof typeof conflict.rows[0] },
                                { label: "Client", key: "client" as keyof typeof conflict.rows[0] },
                                { label: "Remarks", key: "remarks" as keyof typeof conflict.rows[0] },
                              ].map((field) => {
                                // Check if values differ to highlight
                                const isDifferent = conflict.rows.some(r => r[field.key] !== conflict.rows[0][field.key]);
                                return (
                                  <TableRow key={field.key} className="hover:bg-transparent">
                                    <TableCell className="font-medium border-r bg-slate-50/50 dark:bg-slate-900/50">
                                      {field.label}
                                    </TableCell>
                                    {conflict.rows.map(row => (
                                      <TableCell key={row.sourceRow} className={`text-xs ${isDifferent ? 'bg-amber-50/50 dark:bg-amber-950/20' : ''}`}>
                                        <div className={`max-w-[300px] ${field.key === 'remarks' ? 'truncate' : ''}`} title={String(row[field.key] || "")}>
                                          {row[field.key] || "-"}
                                        </div>
                                      </TableCell>
                                    ))}
                                  </TableRow>
                                );
                              })}
                            </TableBody>
                          </Table>
                        </div>
                        <div className="bg-slate-50 dark:bg-slate-900 px-4 py-3 border-t flex gap-2 justify-end">
                          {conflict.rows.map(row => (
                            <Button key={row.sourceRow} variant="outline" size="sm" disabled className="h-8 text-xs">Keep Row {row.sourceRow}</Button>
                          ))}
                          <Button variant="outline" size="sm" disabled className="h-8 text-xs">Merge Fields</Button>
                          <Button variant="secondary" size="sm" disabled className="h-8 text-xs">Leave Unresolved</Button>
                        </div>
                      </Card>
                    ))}
                  </div>
                ) : (
                  <div className="text-center py-12 text-muted-foreground flex flex-col items-center">
                    <CheckCircle2 className="h-12 w-12 text-emerald-500 mb-4 opacity-50" />
                    <p className="text-foreground font-medium mb-1">No sync conflicts</p>
                    <p className="text-sm">All source rows have been successfully processed.</p>
                  </div>
                )}
              </TabsContent>

              <TabsContent value="history" className="flex-1 overflow-y-auto p-0 m-0 outline-none">
                {isLoadingHistory ? (
                  <div className="p-6"><Skeleton className="h-64 w-full" /></div>
                ) : history && history.length > 0 ? (
                  <Table>
                    <TableHeader className="bg-slate-50 dark:bg-slate-900 sticky top-0">
                      <TableRow>
                        <TableHead className="w-[180px]">Date</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Added</TableHead>
                        <TableHead className="text-right">Updated</TableHead>
                        <TableHead className="text-right">Unchanged</TableHead>
                        <TableHead className="text-right">Review</TableHead>
                        <TableHead className="text-right">Missing</TableHead>
                        <TableHead className="text-right">Removed</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {history.map((run) => (
                        <Collapsible key={run.id} asChild>
                          <>
                            <TableRow className="cursor-pointer group hover:bg-slate-50 dark:hover:bg-slate-900/50">
                              <TableCell className="font-medium text-xs">
                                <div className="flex items-center gap-2">
                                  <CollapsibleTrigger asChild>
                                    <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0 p-0">
                                      <ChevronDown className="h-4 w-4 text-muted-foreground group-data-[state=open]:rotate-180 transition-transform" />
                                    </Button>
                                  </CollapsibleTrigger>
                                  {format(new Date(run.startedAt), "MMM d, yyyy HH:mm")}
                                </div>
                              </TableCell>
                              <TableCell>
                                <Badge variant="outline" className={`text-[10px] ${
                                  run.status === 'SUCCESS' ? 'text-emerald-600 border-emerald-200 bg-emerald-50 dark:bg-emerald-950/20' :
                                  run.status === 'FAILED' ? 'text-destructive border-destructive/20 bg-destructive/10' :
                                  'text-amber-600 border-amber-200 bg-amber-50'
                                }`}>
                                  {run.status.toUpperCase()}
                                </Badge>
                              </TableCell>
                              <TableCell className="text-right text-emerald-600">{run.addedCount}</TableCell>
                              <TableCell className="text-right text-blue-600">{run.updatedCount}</TableCell>
                              <TableCell className="text-right text-muted-foreground">{run.unchangedCount}</TableCell>
                              <TableCell className="text-right text-amber-600">{run.reviewCount}</TableCell>
                              <TableCell className="text-right text-amber-600">{run.missingCount}</TableCell>
                              <TableCell className="text-right text-rose-600">{run.removedCount}</TableCell>
                            </TableRow>
                            <CollapsibleContent asChild>
                              <TableRow className="bg-slate-50/50 dark:bg-slate-900/50">
                                <TableCell colSpan={8} className="p-0 border-b-0">
                                  <div className="p-4 bg-slate-50 dark:bg-slate-950 border-t">
                                    <h5 className="text-xs font-semibold mb-2">Sync Details</h5>
                                    {run.changes && run.changes.length > 0 ? (
                                      <div className="max-h-[200px] overflow-y-auto bg-white dark:bg-slate-900 rounded-md border text-xs">
                                        <Table>
                                          <TableHeader className="bg-slate-100 dark:bg-slate-800">
                                            <TableRow className="hover:bg-transparent">
                                              <TableHead className="py-1 h-7">Source Key</TableHead>
                                              <TableHead className="py-1 h-7">Type</TableHead>
                                              <TableHead className="py-1 h-7">Changed Fields</TableHead>
                                            </TableRow>
                                          </TableHeader>
                                          <TableBody>
                                            {run.changes.map(change => (
                                              <TableRow key={change.id} className="hover:bg-transparent">
                                                <TableCell className="py-1">{change.sourceKey}</TableCell>
                                                <TableCell className="py-1 font-medium">{change.changeType}</TableCell>
                                                <TableCell className="py-1 text-muted-foreground font-mono">
                                                  {Object.keys(change.changedFields).join(", ") || "-"}
                                                </TableCell>
                                              </TableRow>
                                            ))}
                                          </TableBody>
                                        </Table>
                                      </div>
                                    ) : (
                                      <p className="text-xs text-muted-foreground">No field-level change logs recorded for this run.</p>
                                    )}
                                  </div>
                                </TableCell>
                              </TableRow>
                            </CollapsibleContent>
                          </>
                        </Collapsible>
                      ))}
                    </TableBody>
                  </Table>
                ) : (
                  <div className="text-center py-12 text-muted-foreground">No sync history available.</div>
                )}
              </TabsContent>
            </Tabs>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
