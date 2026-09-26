import { useState, useRef, useEffect, useMemo } from "react";
import {
  listBusRoutes,
  useGetBusRoute,
  useGetBusRoutesStatus,
  useSyncBusRoutes,
  getListBusRoutesQueryKey,
  getGetBusRoutesStatusQueryKey,
  useGetProjectBusPlan,
  useAddProjectBusRoute,
  useUpdateProjectBusRoute,
  useRemoveProjectBusRoute,
  getGetProjectBusPlanQueryKey,
  getGetProjectMediaPlanQueryKey,
  getGetBusRoutesHealthQueryKey
} from "@workspace/api-client-react";
import { useQueryClient, useInfiniteQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Search, RefreshCw, AlertTriangle, FileSpreadsheet, MapIcon, Hash, CheckCircle2, ListFilter, AlignLeft, Filter, Plus, Pencil, X, Save, MessageSquare } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { format } from "date-fns";

interface BusRoutesWorkspaceProps {
  projectId?: string;
}

export function BusRoutesWorkspace({ projectId }: BusRoutesWorkspaceProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [search, setSearch] = useState("");
  const [depot, setDepot] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [debouncedDepot, setDebouncedDepot] = useState("");
  const timeoutRef = useRef<NodeJS.Timeout | undefined>(undefined);
  
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);

  useEffect(() => {
    clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      setDebouncedSearch(search.trim().replace(/^route\s+/i, ""));
      setDebouncedDepot(depot);
    }, 500);
    return () => clearTimeout(timeoutRef.current);
  }, [search, depot]);

  const { data: status, isLoading: isLoadingStatus } = useGetBusRoutesStatus({
    query: { queryKey: getGetBusRoutesStatusQueryKey() }
  });

  const queryParams = { 
    search: debouncedSearch || undefined, 
    depot: debouncedDepot || undefined, 
    limit: 200 
  };

  const {
    data: infiniteData,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading: isLoadingRoutes,
    isFetching
  } = useInfiniteQuery({
    queryKey: [...getListBusRoutesQueryKey(queryParams), "infinite"],
    queryFn: ({ pageParam = 0, signal }) =>
      listBusRoutes({ ...queryParams, offset: pageParam }, { signal }),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => {
      const nextOffset = lastPage.offset + lastPage.limit;
      return nextOffset < lastPage.total ? nextOffset : undefined;
    }
  });

  const routes = useMemo(() => {
    return infiniteData?.pages.flatMap(page => page.items) || [];
  }, [infiniteData]);

  const total = infiniteData?.pages[0]?.total || 0;

  const syncMutation = useSyncBusRoutes();

  const handleSync = () => {
    syncMutation.mutate(undefined, {
      onSuccess: () => {
        toast({ title: "Sync Complete", description: "Bus routes updated from source." });
        queryClient.invalidateQueries({ queryKey: getListBusRoutesQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetBusRoutesStatusQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetBusRoutesHealthQueryKey() });
        queryClient.invalidateQueries({ queryKey: ["getBusRoute"] });
        if (projectId) {
          queryClient.invalidateQueries({ queryKey: getGetProjectBusPlanQueryKey(projectId) });
          queryClient.invalidateQueries({ queryKey: getGetProjectMediaPlanQueryKey(projectId) });
        }
      },
      onError: (err: any) => {
        toast({ title: "Sync Failed", description: err.message, variant: "destructive" });
      }
    });
  };

  const { data: selectedRouteDetail, isLoading: isLoadingRouteDetail } = useGetBusRoute(selectedRouteId || "", {
    query: { enabled: !!selectedRouteId, queryKey: ["getBusRoute", selectedRouteId] }
  });

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-slate-50 dark:bg-slate-950 border rounded-lg overflow-hidden">
      {/* Top Bar */}
      <div className="border-b bg-white dark:bg-slate-900 px-4 py-2 flex flex-col gap-2 shrink-0">
        <div className="flex flex-col gap-2">
          <div className="flex w-full flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[180px]">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search route ID, locations, via..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9 h-9"
              />
            </div>
            <div className="relative flex-1 min-w-[150px]">
              <Filter className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Filter by Depot..."
                value={depot}
                onChange={(e) => setDepot(e.target.value)}
                className="pl-9 h-9"
              />
            </div>
          </div>
          
          <div className="flex w-full flex-wrap items-center justify-between gap-2">
            {status && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                {!status.configured ? (
                  <span className="text-amber-600 font-medium">Not Configured</span>
                ) : status.connected ? (
                  <span className="text-emerald-600 dark:text-emerald-400 font-medium flex items-center gap-1"><CheckCircle2 className="h-3 w-3" /> Connected</span>
                ) : (
                  <span className="text-destructive font-medium flex items-center gap-1"><AlertTriangle className="h-3 w-3" /> Error</span>
                )}
                
                {status.lastSuccessfulSyncAt && (
                   <span className="text-muted-foreground text-xs whitespace-nowrap">
                    Last successful sync: {format(new Date(status.lastSuccessfulSyncAt), "MMM d, HH:mm")}
                  </span>
                )}
              </div>
            )}
            
            <Button
              variant="outline"
              size="sm"
              onClick={handleSync}
              disabled={syncMutation.isPending || !status?.configured}
              className="gap-2 border-brand text-brand hover:bg-brand/10 h-9"
            >
              <RefreshCw className={`h-4 w-4 ${syncMutation.isPending ? 'animate-spin' : ''}`} />
              {syncMutation.isPending ? 'Syncing...' : 'Sync Routes'}
            </Button>
          </div>
        </div>
      </div>

      {!isLoadingStatus && status && !status.configured && (
        <div className="bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-900/50 p-4 text-sm text-amber-800 dark:text-amber-200 shrink-0">
          <strong>Source Not Configured:</strong> The Bus Routes upstream source is not configured. Please connect the service and provide the required tracking sheets.
        </div>
      )}

      {/* Main Content Split */}
      <div className="flex-1 flex overflow-hidden">
        <ResizablePanelGroup direction="horizontal">
          
          {/* List Panel */}
          <ResizablePanel defaultSize={50} minSize={30}>
            <div className="h-full flex flex-col bg-white dark:bg-slate-900 border-r">
              <div className="p-2 border-b bg-slate-50/50 dark:bg-slate-950/50 flex justify-between items-center text-xs font-medium text-muted-foreground shrink-0">
                <span className="flex items-center gap-2">
                  {total} Routes Found
                  {isFetching && <RefreshCw className="h-3 w-3 animate-spin" />}
                </span>
                {status?.activeRouteCount != null && (
                  <span className="text-brand">Source Active Routes: {status.activeRouteCount}</span>
                )}
              </div>
              
              <ScrollArea className="flex-1">
                {isLoadingRoutes ? (
                  <div className="p-4 space-y-4">
                    {Array(5).fill(0).map((_,i) => <Skeleton key={i} className="h-12 w-full" />)}
                  </div>
                ) : routes.length === 0 ? (
                  <div className="p-8 text-center text-muted-foreground">
                    <MapIcon className="h-8 w-8 mx-auto mb-3 opacity-20" />
                    <p>No bus routes found.</p>
                  </div>
                ) : (
                  <>
                    <Table>
                      <TableHeader className="sticky top-0 bg-white dark:bg-slate-900 z-10 shadow-sm">
                        <TableRow>
                          <TableHead className="w-[100px]">Route ID</TableHead>
                          <TableHead>Path / Location</TableHead>
                          <TableHead className="w-[120px] text-right">Source Rows</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {routes.map(route => (
                          <TableRow
                            key={route.id}
                            className={`cursor-pointer ${selectedRouteId === route.routeId ? 'bg-slate-50 dark:bg-slate-800' : ''}`}
                            onClick={() => setSelectedRouteId(route.routeId)}
                          >
                            <TableCell className="font-medium text-sm whitespace-nowrap">
                              {route.routeId}
                              {!route.isActive && <Badge variant="outline" className="ml-2 text-[10px] text-muted-foreground">Inactive</Badge>}
                            </TableCell>
                            <TableCell>
                              {route.variants[0] ? (
                                <div className="text-xs space-y-0.5">
                                  <div className="font-medium truncate max-w-[200px]" title={String(route.variants[0].rawData["Starting Station"] || "")}>
                                     {String(route.variants[0].rawData["Starting Station"] || "Unknown")} &rarr; {String(route.variants[0].rawData["Ending station"] || "Unknown")}
                                  </div>
                                  <div className="text-muted-foreground truncate max-w-[200px]" title={String(route.variants[0].rawData["Via"] || "")}>
                                     Via: {String(route.variants[0].rawData["Via"] || "-")}
                                  </div>
                                </div>
                              ) : (
                                <span className="text-xs text-muted-foreground">No route details</span>
                              )}
                            </TableCell>
                            <TableCell className="text-right text-sm">
                              <Badge variant="secondary">{route.sourceRowCount}</Badge>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                    {hasNextPage && (
                      <div className="p-4 flex justify-center">
                        <Button 
                          variant="outline" 
                          size="sm" 
                          onClick={() => fetchNextPage()} 
                          disabled={isFetchingNextPage}
                        >
                          {isFetchingNextPage ? "Loading..." : "Load More"}
                        </Button>
                      </div>
                    )}
                  </>
                )}
              </ScrollArea>
            </div>
          </ResizablePanel>

          <ResizableHandle withHandle />

          {/* Details Panel */}
          <ResizablePanel defaultSize={50} minSize={30}>
            <div className="h-full bg-slate-50 dark:bg-slate-950 flex flex-col overflow-hidden">
              {isLoadingRouteDetail ? (
                <div className="flex-1 p-6 space-y-4">
                  <Skeleton className="h-12 w-1/2" />
                  <Skeleton className="h-32 w-full" />
                </div>
              ) : selectedRouteDetail ? (
                <Tabs defaultValue="details" className="h-full flex flex-col">
                  <div className="border-b bg-white dark:bg-slate-900 px-6 pt-6 shrink-0">
                    <div className="flex items-start justify-between mb-4">
                      <div>
                        <div className="flex items-center gap-3 mb-2">
                          <h3 className="text-2xl font-bold flex items-center gap-2">
                            <MapIcon className="h-6 w-6 text-brand" /> 
                            Route {selectedRouteDetail.routeId}
                          </h3>
                          {!selectedRouteDetail.isActive && <Badge variant="secondary">Inactive</Badge>}
                          {status?.physicalVehicleSourceConfigured === false && (
                            <Badge variant="outline" className="text-amber-600 border-amber-200 bg-amber-50">Physical tracking unavailable</Badge>
                          )}
                        </div>
                        <p className="text-sm text-muted-foreground">
                          Derived from {selectedRouteDetail.sourceRowCount} source sheet {selectedRouteDetail.sourceRowCount === 1 ? 'row' : 'rows'}.
                        </p>
                      </div>
                    </div>
                    
                    <TabsList className="bg-transparent h-9 p-0 border-b-0">
                      <TabsTrigger value="details" className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-brand rounded-none h-9 px-4 gap-2">
                        <AlignLeft className="h-4 w-4" /> Route Details
                      </TabsTrigger>
                      <TabsTrigger value="sources" className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-brand rounded-none h-9 px-4 gap-2">
                        <ListFilter className="h-4 w-4" /> Source Discovery
                      </TabsTrigger>
                    </TabsList>
                  </div>
                  
                  <TabsContent value="details" className="flex-1 overflow-y-auto p-6 m-0 outline-none">
                    <div className="space-y-6">
                      {selectedRouteDetail.variants.map((variant) => (
                        <div key={variant.id} className="border rounded-lg bg-white dark:bg-slate-900 overflow-hidden shadow-sm">
                          <div className="bg-slate-50 dark:bg-slate-950 px-4 py-3 border-b flex items-center justify-between text-sm">
                            <div className="flex items-center gap-2 font-medium">
                              <FileSpreadsheet className="h-4 w-4 text-muted-foreground" />
                            {variant.sheetName}
                          </div>
                          <div className="text-xs text-muted-foreground flex items-center gap-1">
                            <Hash className="h-3 w-3" /> Row {variant.sourceRowNumber}
                          </div>
                        </div>
                        
                        <div className="p-4 grid gap-4 text-sm">
                          <div className="grid grid-cols-2 gap-4 pb-4 border-b">
                            <div>
                              <div className="text-xs text-muted-foreground mb-1">Starting Station</div>
                              <div className="font-medium">{String(variant.rawData["Starting Station"] || "-")}</div>
                            </div>
                            <div>
                              <div className="text-xs text-muted-foreground mb-1">Ending Station</div>
                              <div className="font-medium">{String(variant.rawData["Ending station"] || "-")}</div>
                            </div>
                          </div>
                          
                          <div>
                            <div className="text-xs text-muted-foreground mb-1">Via</div>
                            <div>{String(variant.rawData["Via"] || "-")}</div>
                          </div>
                          
                          <div>
                            <div className="text-xs text-muted-foreground mb-1">Full Routes</div>
                            <div className="text-muted-foreground">{String(variant.rawData["Full Routes"] || "-")}</div>
                          </div>
                          
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-4 border-t">
                            <div>
                              <div className="text-xs text-muted-foreground mb-1">Depot</div>
                              <div>{String(variant.rawData["Depot Name"] || "-")}</div>
                            </div>
                            <div>
                              <div className="text-xs text-muted-foreground mb-1">Bus Type</div>
                              <div>{String(variant.rawData["Bus Type"] || "-")}</div>
                            </div>
                            <div>
                              <div className="text-xs text-muted-foreground mb-1">Source Buses</div>
                              <div className="font-semibold text-brand">
                                {variant.allocatedBusCount ?? "Not supplied"}
                              </div>
                            </div>
                            <div>
                              <div className="text-xs text-muted-foreground mb-1">Last synced</div>
                              <div>{variant.lastSeenAt ? format(new Date(variant.lastSeenAt), "MMM d, yyyy HH:mm") : "Not yet synced"}</div>
                            </div>
                          </div>
                          
                           {Boolean(variant.rawData["Remarks"]) && (
                            <div className="pt-4 border-t">
                              <div className="text-xs text-muted-foreground mb-1">Remarks</div>
                              <div className="italic text-muted-foreground">{String(variant.rawData["Remarks"])}</div>
                            </div>
                          )}

                          {projectId && (
                            <div className="bg-slate-50 dark:bg-slate-900 border-t p-4 flex justify-between items-center">
                              <div className="text-sm">
                                <span className="font-medium">Pitch Planning</span>
                                <div className="text-xs text-muted-foreground">Select this specific route variant for the pitch.</div>
                              </div>
                              <ProjectBusPlanVariantActions 
                                projectId={projectId} 
                                routeId={selectedRouteDetail.id}
                                routeCode={selectedRouteDetail.routeId}
                                variant={variant}
                              />
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                    
                    {selectedRouteDetail.variants.length > 1 && (
                      <div className="bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900 rounded-lg p-4 text-sm text-amber-800 dark:text-amber-300 flex gap-3">
                        <AlertTriangle className="h-5 w-5 shrink-0" />
                        <div>
                          <strong>Duplicate Route IDs Detected:</strong> This route appears on {selectedRouteDetail.variants.length} different sheets or rows. Bus counts are tracked per source row, and are not physically summed to prevent inflation. Consult operations if merging is required.
                        </div>
                      </div>
                    )}
                  </div>
                </TabsContent>
                
                <TabsContent value="sources" className="flex-1 overflow-y-auto p-6 m-0 outline-none">
                  <div className="space-y-6">
                    <h4 className="text-sm font-semibold mb-4">Upstream Data Sources</h4>
                    
                    {status?.lastRun?.discoveredSheets ? (
                      <div className="space-y-4">
                        {status.lastRun.discoveredSheets.map((sheet, i) => (
                          <div key={i} className="border rounded-lg bg-white dark:bg-slate-900 p-4 text-sm">
                            <div className="flex items-center justify-between mb-2">
                              <div className="font-medium flex items-center gap-2">
                                <FileSpreadsheet className="h-4 w-4 text-brand" /> {sheet.name}
                              </div>
                              <Badge variant="outline" className={sheet.kind === 'route' ? 'text-blue-600 bg-blue-50 border-blue-200' : 'text-emerald-600 bg-emerald-50 border-emerald-200'}>
                                {sheet.kind}
                              </Badge>
                            </div>
                            <div className="text-muted-foreground mb-3">{sheet.dataRows} data rows discovered</div>
                            
                            {sheet.headers && sheet.headers.length > 0 && (
                              <div>
                                <div className="text-xs font-medium text-muted-foreground mb-1">Discovered Headers</div>
                                <div className="flex flex-wrap gap-1">
                                  {sheet.headers.map((h, j) => (
                                    <Badge key={j} variant="secondary" className="text-[10px] font-normal px-1.5 py-0">
                                      {h}
                                    </Badge>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-sm text-muted-foreground text-center py-8">
                        No discovered sheets information available.
                      </div>
                    )}
                  </div>
                </TabsContent>
              </Tabs>
              ) : (
                <div className="flex-1 flex items-center justify-center text-muted-foreground flex-col">
                  <MapIcon className="h-12 w-12 mb-4 opacity-20" />
                  <p>Select a bus route to view details.</p>
                </div>
              )}
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
}

export function ProjectBusPlanVariantActions({ projectId, routeId, routeCode, variant }: any) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const { data: busPlan } = useGetProjectBusPlan(projectId, {
    query: { enabled: !!projectId, queryKey: getGetProjectBusPlanQueryKey(projectId) }
  });
  
  const addMutation = useAddProjectBusRoute();
  const updateMutation = useUpdateProjectBusRoute();
  const removeMutation = useRemoveProjectBusRoute();
  
  const existingSelection = busPlan?.selections.find((s: any) => s.sourceVariantId === variant.id);
  
  const [open, setOpen] = useState(false);
  const [quantity, setQuantity] = useState<string>("1");
  const [status, setStatus] = useState("PROPOSED");
  const [note, setNote] = useState("");
  
  const [overrideRequired, setOverrideRequired] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
  
  useEffect(() => {
    if (open) {
      if (existingSelection) {
        setQuantity(String(existingSelection.proposedQuantity));
        setStatus(existingSelection.status);
        setNote(existingSelection.internalNote || "");
      } else {
        setQuantity("1");
        setStatus("PROPOSED");
        setNote("");
      }
      setOverrideRequired(false);
      setOverrideReason("");
    }
  }, [open, existingSelection]);

  const sourceCount: number | null = variant.allocatedBusCount ?? null;
  
  const handleSave = () => {
    const q = Number(quantity);
    if (!Number.isInteger(q) || q < 1) {
      toast({ title: "Error", description: "Quantity must be a positive whole number", variant: "destructive" });
      return;
    }
    
    if ((sourceCount === null || q > sourceCount) && !overrideRequired) {
      // First attempt triggers override check locally
      setOverrideRequired(true);
      return;
    }
    
    if (overrideRequired && !overrideReason.trim()) {
      toast({ title: "Reason Required", description: "You must provide a reason for exceeding source capacity.", variant: "destructive" });
      return;
    }
    
    const payload = {
      sourceVariantId: variant.id,
      proposedQuantity: q,
      status: status as any,
      internalNote: note || null,
      overrideSourceCount: overrideRequired,
      overrideReason: overrideReason || null
    };

    if (existingSelection) {
      updateMutation.mutate({ projectId, selectionId: existingSelection.id, data: payload }, {
        onSuccess: () => {
          toast({ title: "Updated", description: "Route selection updated." });
          queryClient.invalidateQueries({ queryKey: getGetProjectBusPlanQueryKey(projectId) });
          queryClient.invalidateQueries({ queryKey: getGetProjectMediaPlanQueryKey(projectId) });
          setOpen(false);
        },
        onError: (err: any) => {
          if (err.status === 409 && err.data?.requiresOverride) {
            setOverrideRequired(true);
          } else {
            toast({ title: "Error", description: err.message, variant: "destructive" });
          }
        }
      });
    } else {
      addMutation.mutate({ projectId, data: payload }, {
        onSuccess: () => {
          toast({ title: "Added", description: "Route added to pitch plan." });
          queryClient.invalidateQueries({ queryKey: getGetProjectBusPlanQueryKey(projectId) });
          queryClient.invalidateQueries({ queryKey: getGetProjectMediaPlanQueryKey(projectId) });
          setOpen(false);
        },
        onError: (err: any) => {
          if (err.status === 409 && err.data?.requiresOverride) {
            setOverrideRequired(true);
          } else {
            toast({ title: "Error", description: err.message, variant: "destructive" });
          }
        }
      });
    }
  };

  const handleRemove = () => {
    if (!existingSelection) return;
    removeMutation.mutate({ projectId, selectionId: existingSelection.id }, {
      onSuccess: () => {
        toast({ title: "Removed", description: "Route removed from pitch plan." });
        setOpen(false);
        queryClient.invalidateQueries({ queryKey: getGetProjectBusPlanQueryKey(projectId) });
        queryClient.invalidateQueries({ queryKey: getGetProjectMediaPlanQueryKey(projectId) });
      },
      onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" })
    });
  };

  if (!existingSelection) {
    return (
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button size="sm" className="gap-2 bg-brand hover:bg-brand/90 text-white"><Plus className="h-4 w-4" /> Add to Pitch</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Route {routeCode} to Pitch</DialogTitle>
            <DialogDescription>
              Propose buses on this route source row ({variant.sheetName}, Row {variant.sourceRowNumber}). No vehicles are reserved.
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 py-2">
            <div className="flex gap-4">
              <div className="flex-1 space-y-2">
                <Label>Proposed Quantity</Label>
                <Input type="number" min="1" value={quantity} onChange={e => setQuantity(e.target.value)} />
                 <p className="text-xs text-muted-foreground">Source buses: {sourceCount ?? "Not supplied"}</p>
              </div>
              <div className="flex-1 space-y-2">
                <Label>Status</Label>
                <Select value={status} onValueChange={setStatus}>
                  <SelectTrigger><SelectValue/></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="PROPOSED">Proposed</SelectItem>
                    <SelectItem value="SHORTLISTED">Shortlisted</SelectItem>
                    <SelectItem value="REJECTED">Rejected</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            
            <div className="space-y-2">
              <Label>Internal Note (Optional)</Label>
              <Input placeholder="Client context, booking notes..." value={note} onChange={e => setNote(e.target.value)} />
            </div>

            {overrideRequired && (
              <div className="bg-amber-50 dark:bg-amber-950/20 border border-amber-200 p-4 rounded-lg space-y-2">
                <div className="flex items-center gap-2 text-amber-800 dark:text-amber-400 font-medium text-sm">
                   <AlertTriangle className="h-4 w-4" /> Source Count Override
                </div>
                <p className="text-xs text-amber-800/80 dark:text-amber-400/80">
                   You are proposing {quantity} buses, but this source row records {sourceCount ?? "no"} buses. Please confirm the override and provide a reason. This does not reserve vehicles.
                </p>
                <Textarea 
                  placeholder="Reason for overriding source count..." 
                  value={overrideReason} 
                  onChange={e => setOverrideReason(e.target.value)} 
                  className="bg-white dark:bg-slate-950"
                />
              </div>
            )}
          </div>
          
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={addMutation.isPending}>
              {addMutation.isPending ? "Saving..." : "Add to Pitch"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  const statusColors: any = {
    PROPOSED: "bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-400",
    SHORTLISTED: "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-400",
    REJECTED: "bg-rose-100 text-rose-800 border-rose-200 dark:bg-rose-900/30 dark:text-rose-400"
  };

  return (
    <div className="flex items-center gap-3">
      <div className="flex flex-col items-end text-sm">
        <div className="flex items-center gap-2 font-medium">
          {existingSelection.proposedQuantity} Proposed Buses
          <Badge variant="outline" className={statusColors[existingSelection.status] || ""}>
            {existingSelection.status}
          </Badge>
        </div>
        {existingSelection.requiresOverride && (
          <span className="text-xs text-amber-700">Source count changed · review proposal</span>
        )}
        {existingSelection.internalNote && (
          <span className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
            <MessageSquare className="h-3 w-3" /> Note attached
          </span>
        )}
      </div>
      
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button variant="outline" size="sm"><Pencil className="h-4 w-4" /></Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Route {routeCode} Pitch Plan</DialogTitle>
          </DialogHeader>
          
          <div className="space-y-4 py-2">
            <div className="flex gap-4">
              <div className="flex-1 space-y-2">
                <Label>Proposed Quantity</Label>
                <Input type="number" min="1" value={quantity} onChange={e => setQuantity(e.target.value)} />
                 <p className="text-xs text-muted-foreground">Source buses: {sourceCount ?? "Not supplied"}</p>
              </div>
              <div className="flex-1 space-y-2">
                <Label>Status</Label>
                <Select value={status} onValueChange={setStatus}>
                  <SelectTrigger><SelectValue/></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="PROPOSED">Proposed</SelectItem>
                    <SelectItem value="SHORTLISTED">Shortlisted</SelectItem>
                    <SelectItem value="REJECTED">Rejected</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            
            <div className="space-y-2">
              <Label>Internal Note (Optional)</Label>
              <Input placeholder="Client context, booking notes..." value={note} onChange={e => setNote(e.target.value)} />
            </div>

            {overrideRequired && (
              <div className="bg-amber-50 dark:bg-amber-950/20 border border-amber-200 p-4 rounded-lg space-y-2">
                <div className="flex items-center gap-2 text-amber-800 dark:text-amber-400 font-medium text-sm">
                   <AlertTriangle className="h-4 w-4" /> Source Count Override
                </div>
                <p className="text-xs text-amber-800/80 dark:text-amber-400/80">
                   You are proposing {quantity} buses, but this source row records {sourceCount ?? "no"} buses. Please confirm the override and provide a reason. This does not reserve vehicles.
                </p>
                <Textarea 
                  placeholder="Reason for overriding source count..." 
                  value={overrideReason} 
                  onChange={e => setOverrideReason(e.target.value)} 
                  className="bg-white dark:bg-slate-950"
                />
              </div>
            )}
          </div>
          
          <DialogFooter className="flex justify-between w-full sm:justify-between">
            <Button variant="destructive" onClick={handleRemove} disabled={removeMutation.isPending}>
              Remove
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button onClick={handleSave} disabled={updateMutation.isPending}>
                {updateMutation.isPending ? "Saving..." : "Save Changes"}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
