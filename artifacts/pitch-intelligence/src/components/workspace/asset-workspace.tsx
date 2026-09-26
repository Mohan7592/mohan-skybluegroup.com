import { useState, useMemo, useRef, useEffect } from "react";
import {
  useListInventoryAssets,
  useListProjectInventorySelections,
  useSetProjectInventorySelection,
  useRemoveProjectInventorySelection,
  useSetProjectInventoryUnitSelection,
  useRemoveProjectInventoryUnitSelection,
  getListProjectInventorySelectionsQueryKey,
  listInventoryAssets,
  getListInventoryAssetsQueryKey
} from "@workspace/api-client-react";
import { useQueryClient, useInfiniteQuery } from "@tanstack/react-query";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Label } from "@/components/ui/label";
import {
  Map as MapIcon, List, LayoutTemplate, Search, Filter,
  X, Check, XCircle, Clock, EyeOff, ImageIcon, ExternalLink, RefreshCw, MapPin, SlidersHorizontal
} from "lucide-react";
import { MapContainer, TileLayer, Marker, Popup, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";

delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png",
  iconUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png",
  shadowUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png",
});

const createStatusIcon = (color: string) => {
  return new L.DivIcon({
    className: "custom-div-icon",
    html: `<div style="background-color: ${color}; width: 14px; height: 14px; border-radius: 50%; border: 2px solid white; box-shadow: 0 0 4px rgba(0,0,0,0.4);"></div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7]
  });
};

const ICONS = {
  available: createStatusIcon("#10b981"),
  occupied: createStatusIcon("#f43f5e"),
  reserved: createStatusIcon("#f59e0b"),
  maintenance: createStatusIcon("#8b5cf6"),
  inactive: createStatusIcon("#64748b"),
  unknown: createStatusIcon("#94a3b8"),
};

interface AssetWorkspaceProps {
  projectId?: string;
  defaultView?: "split" | "list" | "map";
  baseFilters?: Record<string, string>;
  showBusesEmptyState?: boolean;
}

// Reusable Map Provider Abstraction
function BaseMap({ center, children }: { center: [number, number], children: React.ReactNode }) {
  // Can be configured to swap TileLayer to Google/Mapbox later without touching business logic
  return (
    <MapContainer center={center} zoom={11} className="h-full w-full">
      <TileLayer
        url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
        attribution='&copy; OpenStreetMap &copy; CARTO'
      />
      {children}
    </MapContainer>
  );
}

export function AssetWorkspace({ projectId, defaultView = "split", baseFilters, showBusesEmptyState }: AssetWorkspaceProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [viewMode, setViewMode] = useState<"split" | "list" | "map">(defaultView);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);

  // Filters
  const [search, setSearch] = useState("");
  const [assetType, setAssetType] = useState<string>("all");
  const [availability, setAvailability] = useState<string>("all");
  const [area, setArea] = useState<string>("");
  const [road, setRoad] = useState<string>("");
  const [route, setRoute] = useState<string>("");
  const [client, setClient] = useState<string>("");
  const [bookingStatus, setBookingStatus] = useState<string>("");
  const [displayTechnology, setDisplayTechnology] = useState<string>("all");

  // Advanced filters
  const [sourceFamily, setSourceFamily] = useState<string>(baseFilters?.sourceFamily || "all");
  const [shelterConfiguration, setShelterConfiguration] = useState<string>("all");
  const [mediaUnit, setMediaUnit] = useState<string>("all");
  const [sourceMediaType, setSourceMediaType] = useState<string>("all");
  const [powerStatus, setPowerStatus] = useState<string>("");
  const [accountability, setAccountability] = useState<string>("");
  const [tentativeClient, setTentativeClient] = useState<string>("");
  const [lifecycleStatus, setLifecycleStatus] = useState<string>("ACTIVE");
  const [coordinateState, setCoordinateState] = useState<string>("all");

  const [showOnlySelected, setShowOnlySelected] = useState<boolean>(false);

  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [debouncedArea, setDebouncedArea] = useState("");
  const [debouncedRoad, setDebouncedRoad] = useState("");
  const [debouncedRoute, setDebouncedRoute] = useState("");
  const [debouncedClient, setDebouncedClient] = useState("");
  const [debouncedBookingStatus, setDebouncedBookingStatus] = useState("");
  const [debouncedPowerStatus, setDebouncedPowerStatus] = useState("");
  const [debouncedAccountability, setDebouncedAccountability] = useState("");
  const [debouncedTentativeClient, setDebouncedTentativeClient] = useState("");

  const [limit, setLimit] = useState(200);

  const timeoutRef = useRef<NodeJS.Timeout | undefined>(undefined);

  useEffect(() => {
    clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      setDebouncedSearch(search);
      setDebouncedArea(area);
      setDebouncedRoad(road);
      setDebouncedRoute(route);
      setDebouncedClient(client);
      setDebouncedBookingStatus(bookingStatus);
      setDebouncedPowerStatus(powerStatus);
      setDebouncedAccountability(accountability);
      setDebouncedTentativeClient(tentativeClient);
    }, 500);
    return () => clearTimeout(timeoutRef.current);
  }, [search, area, road, route, client, bookingStatus, powerStatus, accountability, tentativeClient]);

  // Reset selected asset on project switch
  useEffect(() => {
    setSelectedAssetId(null);
  }, [projectId]);

  const queryParams: any = { limit: 200 };
  if (debouncedSearch) queryParams.search = debouncedSearch;
  if (assetType !== "all") queryParams.assetType = assetType;
  if (availability !== "all") queryParams.availability = availability;
  if (debouncedBookingStatus) queryParams.bookingStatus = debouncedBookingStatus;
  if (displayTechnology !== "all") queryParams.displayTechnology = displayTechnology as any;
  if (debouncedArea) queryParams.area = debouncedArea;
  if (debouncedRoad) queryParams.road = debouncedRoad;
  if (debouncedRoute) queryParams.route = debouncedRoute;
  if (debouncedClient) queryParams.client = debouncedClient;

  if (sourceFamily !== "all") queryParams.sourceFamily = sourceFamily;
  if (shelterConfiguration !== "all") queryParams.shelterConfiguration = shelterConfiguration;
  if (mediaUnit !== "all") queryParams.mediaUnit = mediaUnit;
  if (sourceMediaType !== "all") queryParams.sourceMediaType = sourceMediaType;
  if (debouncedPowerStatus) queryParams.powerStatus = debouncedPowerStatus;
  if (debouncedAccountability) queryParams.accountability = debouncedAccountability;
  if (debouncedTentativeClient) queryParams.tentativeClient = debouncedTentativeClient;
  if (lifecycleStatus !== "all") queryParams.lifecycleStatus = lifecycleStatus;
  if (coordinateState !== "all") queryParams.coordinateState = coordinateState;

  if (lifecycleStatus !== "ACTIVE") queryParams.includeInactive = true;

  const {
    data: infiniteData,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading: isLoadingAssets,
    isFetching
  } = useInfiniteQuery({
    queryKey: [...getListInventoryAssetsQueryKey(queryParams), "infinite"],
    queryFn: ({ pageParam = 0, signal }) =>
      listInventoryAssets({ ...queryParams, offset: pageParam }, { signal }),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => {
      const nextOffset = lastPage.offset + lastPage.limit;
      return nextOffset < lastPage.total ? nextOffset : undefined;
    }
  });

  const rawAssets = useMemo(() => {
    return infiniteData?.pages.flatMap(page => page.items) || [];
  }, [infiniteData]);

  const { data: selections = [] } = useListProjectInventorySelections(projectId || "", {
    query: { enabled: !!projectId, queryKey: getListProjectInventorySelectionsQueryKey(projectId || "") }
  });

  const selectionMap = useMemo(() => {
    const map: Record<string, any> = {};
    selections.forEach(s => {
      if (s.inventoryMediaUnitId) {
        map[s.inventoryMediaUnitId] = s;
      } else {
        map[s.inventoryAssetId] = s;
      }
    });
    return map;
  }, [selections]);

  const assets = useMemo(() => {
    if (projectId && showOnlySelected) {
      // Deduplicate selected assets (multiple units in same shelter shouldn't duplicate the shelter row)
      const uniqueAssets = new Map();
      selections
        .filter(s => s.status !== "rejected")
        .forEach(s => {
          if (s.asset?.isActive && !uniqueAssets.has(s.asset.id)) {
            uniqueAssets.set(s.asset.id, s.asset);
          }
        });
      return Array.from(uniqueAssets.values());
    }
    return rawAssets;
  }, [rawAssets, selections, projectId, showOnlySelected]);

  const total = showOnlySelected ? assets.length : (infiniteData?.pages[0]?.total || 0);

  const selectedAsset = assets.find(a => a.id === selectedAssetId) || rawAssets.find(a => a.id === selectedAssetId);

  const getStatusColor = (status: string) => {
    switch(status) {
      case 'shortlist': return 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-800';
      case 'selected': return 'bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-400 dark:border-green-800';
      case 'rejected': return 'bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-400 dark:border-red-800';
      default: return 'bg-slate-100 text-slate-800 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700';
    }
  };

  const getAvailabilityColor = (avail: string | null) => {
    const a = (avail || "").toLowerCase();
    if (a === "available") return "text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-900";
    if (a === "occupied") return "text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/30 border-rose-200 dark:border-rose-900";
    if (a === "reserved") return "text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-900";
    if (a === "maintenance") return "text-violet-600 dark:text-violet-400 bg-violet-50 dark:bg-violet-950/30 border-violet-200 dark:border-violet-900";
    if (a === "inactive") return "text-slate-600 dark:text-slate-400 bg-slate-100 dark:bg-slate-900 border-slate-300 dark:border-slate-700";
    return "text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-900 border-slate-200 dark:border-slate-800";
  };

  const getMarkerIcon = (asset: any) => {
    const avail = (asset.availability || "").toLowerCase();
    if (avail === "available") return ICONS.available;
    if (avail === "occupied") return ICONS.occupied;
    if (avail === "reserved") return ICONS.reserved;
    if (avail === "maintenance") return ICONS.maintenance;
    if (avail === "inactive") return ICONS.inactive;
    return ICONS.unknown;
  };

  const activeAssetsForMap = useMemo(() => {
    return assets.filter(a => a.isActive);
  }, [assets]);

  const mapCenter: [number, number] = useMemo(() => {
    const withCoords = activeAssetsForMap.filter(a => a.latitude && a.longitude);
    if (withCoords.length === 0) return [25.2048, 55.2708];
    return [withCoords[0].latitude!, withCoords[0].longitude!];
  }, [activeAssetsForMap]);

  // Extract unique types from current list to supplement required types
  const dynamicTypes = useMemo(() => {
    const req = ["Bus Shelter", "Bus", "Digital Shelter Screen", "MUPI", "Kiosk", "Other"];
    const found = new Set(assets.map(a => a.assetType).filter(Boolean));
    req.forEach(t => found.add(t));
    return Array.from(found).sort();
  }, [assets]);

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-slate-50 dark:bg-slate-950 border rounded-lg overflow-hidden">
      {/* Top Bar: Filters */}
      <div className="border-b bg-white dark:bg-slate-900 px-4 py-2 flex flex-col gap-2 shrink-0">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full sm:w-64 shrink-0">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search ID, Notes, Tags..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 h-9"
            />
          </div>

          <Select value={assetType} onValueChange={setAssetType}>
            <SelectTrigger className="w-[140px] h-9">
              <SelectValue placeholder="Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              {dynamicTypes.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
            </SelectContent>
          </Select>

          <Input
            placeholder="Area..."
            value={area}
            onChange={(e) => setArea(e.target.value)}
            className="w-[120px] h-9"
          />
          <Input
            placeholder="Road..."
            value={road}
            onChange={(e) => setRoad(e.target.value)}
            className="w-[120px] h-9"
          />
          <Input
            placeholder="Route..."
            value={route}
            onChange={(e) => setRoute(e.target.value)}
            className="w-[120px] h-9"
          />
          <Input
            placeholder="Client..."
            value={client}
            onChange={(e) => setClient(e.target.value)}
            className="w-[120px] h-9"
          />

          <Select value={availability} onValueChange={setAvailability}>
            <SelectTrigger className="w-[130px] h-9">
              <SelectValue placeholder="Availability" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any Avail.</SelectItem>
              <SelectItem value="Available">Available</SelectItem>
              <SelectItem value="Occupied">Occupied</SelectItem>
              <SelectItem value="Reserved">Reserved</SelectItem>
              <SelectItem value="Maintenance">Maintenance</SelectItem>
              <SelectItem value="Inactive">Inactive</SelectItem>
            </SelectContent>
          </Select>

          <Input
            placeholder="Booking Status..."
            value={bookingStatus}
            onChange={(e) => setBookingStatus(e.target.value)}
            className="w-[140px] h-9"
          />

          <Select value={displayTechnology} onValueChange={setDisplayTechnology}>
            <SelectTrigger className="w-[130px] h-9">
              <SelectValue placeholder="Technology" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any Tech</SelectItem>
              <SelectItem value="static">Static</SelectItem>
              <SelectItem value="digital">Digital</SelectItem>
            </SelectContent>
          </Select>

          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="h-9 gap-2">
                <SlidersHorizontal className="h-4 w-4" /> Filters
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-80 p-4" align="start">
              <div className="space-y-4">
                <h4 className="font-medium text-sm leading-none">Advanced Filters</h4>

                <div className="grid grid-cols-2 gap-4">
                  <div className="grid gap-2">
                    <Label className="text-xs">Source Family</Label>
                    <Select value={sourceFamily} onValueChange={setSourceFamily} disabled={!!baseFilters?.sourceFamily}>
                      <SelectTrigger className="h-8"><SelectValue placeholder="Any" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">Any</SelectItem>
                        <SelectItem value="BUS_SHELTER">Bus Shelters</SelectItem>
                        <SelectItem value="BUS">Buses</SelectItem>
                        <SelectItem value="FUTURE">Future Media</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-2">
                    <Label className="text-xs">Source Category</Label>
                    <Select value={sourceMediaType} onValueChange={setSourceMediaType}>
                      <SelectTrigger className="h-8"><SelectValue placeholder="Any" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">Any Category</SelectItem>
                        <SelectItem value="Standard">Standard</SelectItem>
                        <SelectItem value="Digital Bus Shelter">Digital Bus Shelter</SelectItem>
                        <SelectItem value="Digital Mupi">Digital Mupi</SelectItem>
                        <SelectItem value="Digital BS & Mupi">Digital BS & Mupi</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="grid gap-2">
                    <Label className="text-xs">Lifecycle Status</Label>
                    <Select value={lifecycleStatus} onValueChange={setLifecycleStatus}>
                      <SelectTrigger className="h-8"><SelectValue placeholder="Any" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All (Include Inactive)</SelectItem>
                        <SelectItem value="ACTIVE">Active Only</SelectItem>
                        <SelectItem value="REMOVED">Removed</SelectItem>
                        <SelectItem value="MISSING_FROM_SOURCE">Missing</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-2">
                    <Label className="text-xs">Coordinates</Label>
                    <Select value={coordinateState} onValueChange={setCoordinateState}>
                      <SelectTrigger className="h-8"><SelectValue placeholder="Any" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">Any State</SelectItem>
                        <SelectItem value="VALID">Valid</SelectItem>
                        <SelectItem value="MISSING_OR_INVALID_COORDINATES">Missing/Invalid</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="grid gap-2">
                    <Label className="text-xs">Shelter Config</Label>
                    <Select value={shelterConfiguration} onValueChange={setShelterConfiguration}>
                      <SelectTrigger className="h-8"><SelectValue placeholder="Any" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">Any</SelectItem>
                        <SelectItem value="SINGLE">Single</SelectItem>
                        <SelectItem value="DOUBLE">Double</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-2">
                    <Label className="text-xs">Media Unit Type</Label>
                    <Select value={mediaUnit} onValueChange={setMediaUnit}>
                      <SelectTrigger className="h-8"><SelectValue placeholder="Any" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">Any Unit</SelectItem>
                        <SelectItem value="STATIC_TOP_PANEL">Static Top Panel</SelectItem>
                        <SelectItem value="DIGITAL_TOP_PANEL">Digital Top Panel</SelectItem>
                        <SelectItem value="STATIC_MUPI">Static Mupi</SelectItem>
                        <SelectItem value="DIGITAL_MUPI">Digital Mupi</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="grid gap-2">
                  <Label className="text-xs">Power Status</Label>
                  <Input
                    value={powerStatus}
                    onChange={(e) => setPowerStatus(e.target.value)}
                    placeholder="e.g. Connected..."
                    className="h-8"
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="grid gap-2">
                    <Label className="text-xs">Tentative Client</Label>
                    <Input
                      value={tentativeClient}
                      onChange={(e) => setTentativeClient(e.target.value)}
                      placeholder="Client..."
                      className="h-8"
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label className="text-xs">Accountability</Label>
                    <Input
                      value={accountability}
                      onChange={(e) => setAccountability(e.target.value)}
                      placeholder="Account..."
                      className="h-8"
                    />
                  </div>
                </div>

                <div className="flex justify-end pt-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 text-xs"
                    onClick={() => {
                      setSourceFamily(baseFilters?.sourceFamily || "all");
                      setShelterConfiguration("all");
                      setMediaUnit("all");
                      setSourceMediaType("all");
                      setPowerStatus("");
                      setAccountability("");
                      setTentativeClient("");
                      setLifecycleStatus("ACTIVE");
                      setCoordinateState("all");
                    }}
                  >
                    Reset Advanced
                  </Button>
                </div>
              </div>
            </PopoverContent>
          </Popover>

          <div className="flex items-center gap-1 bg-slate-100 dark:bg-slate-800 p-1 rounded-md shrink-0 ml-auto">
            <Button
              variant={viewMode === "list" ? "secondary" : "ghost"}
              size="sm"
              className="h-7 px-2"
              onClick={() => setViewMode("list")}
              title="List View"
            >
              <List className="h-4 w-4" />
            </Button>
            <Button
              variant={viewMode === "split" ? "secondary" : "ghost"}
              size="sm"
              className="h-7 px-2"
              onClick={() => setViewMode("split")}
              title="Split View"
            >
              <LayoutTemplate className="h-4 w-4" />
            </Button>
            <Button
              variant={viewMode === "map" ? "secondary" : "ghost"}
              size="sm"
              className="h-7 px-2"
              onClick={() => setViewMode("map")}
              title="Map View"
            >
              <MapIcon className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>

      {/* Main Workspace Area */}
      <div className="flex-1 flex overflow-hidden relative">
        <ResizablePanelGroup direction="horizontal">

          {/* List Panel */}
          {viewMode !== "map" && (
            <ResizablePanel defaultSize={viewMode === "list" ? 100 : 40} minSize={20}>
              <div className="h-full flex flex-col bg-white dark:bg-slate-900 border-r">
                <div className="p-2 border-b bg-slate-50/50 dark:bg-slate-950/50 flex justify-between items-center text-xs font-medium text-muted-foreground shrink-0">
                  <span className="flex items-center gap-2">
                    {total} Assets Found
                    {isFetching && <RefreshCw className="h-3 w-3 animate-spin" />}
                  </span>

                  {projectId && selections.length > 0 && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setShowOnlySelected(!showOnlySelected)}
                      className={`h-6 text-[10px] px-2 ${showOnlySelected ? 'bg-brand/10 text-brand border-brand/20' : ''}`}
                    >
                      {selections.length} Selected
                    </Button>
                  )}
                </div>
                <ScrollArea className="flex-1">
                  {isLoadingAssets ? (
                    <div className="p-4 space-y-4">
                      {Array(5).fill(0).map((_,i) => <Skeleton key={i} className="h-16 w-full" />)}
                    </div>
                  ) : assets.length === 0 ? (
                    <div className="p-8 text-center text-muted-foreground flex flex-col items-center">
                      <Filter className="h-8 w-8 mx-auto mb-3 opacity-20" />
                      {showBusesEmptyState && Object.keys(queryParams).length <= 4 ? (
                        <>
                          <p className="text-foreground font-medium mb-1">No bus inventory found.</p>
                          <p className="text-sm">Bus vehicles are not currently synced automatically. Please import them manually.</p>
                        </>
                      ) : showOnlySelected || lifecycleStatus !== "ACTIVE" ||
                        Object.keys(queryParams).some((key) => !["limit", "offset", "lifecycleStatus", "sourceFamily"].includes(key)) ? (
                        <p>No assets match filters.</p>
                      ) : (
                        <p>No inventory assets found.</p>
                      )}
                    </div>
                  ) : (
                    <div className="relative">
                      <Table>
                        <TableHeader className="sticky top-0 bg-white dark:bg-slate-900 z-10 shadow-sm">
                          <TableRow>
                            <TableHead className="w-[120px]">ID</TableHead>
                            <TableHead>Location</TableHead>
                            <TableHead className="w-[100px]">Avail.</TableHead>
                            {projectId && <TableHead className="w-[100px]">Project</TableHead>}
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {assets.map(asset => {
                            const sel = selectionMap[asset.id];
                            return (
                              <TableRow
                                key={asset.id}
                                className={`cursor-pointer ${selectedAssetId === asset.id ? 'bg-slate-50 dark:bg-slate-800' : ''}`}
                                onClick={() => setSelectedAssetId(asset.id)}
                              >
                                <TableCell className="font-medium text-xs">
                                  {asset.assetCode}
                                  {(asset.latitude == null || asset.longitude == null || asset.locationUnavailable) && (
                                    <div className="text-[10px] text-destructive flex items-center mt-1">
                                      <EyeOff className="h-3 w-3 mr-1" /> Location unavailable
                                    </div>
                                  )}
                                </TableCell>
                                <TableCell>
                                  <div className="text-sm truncate max-w-[150px]" title={asset.area || ''}>{asset.area}</div>
                                  <div className="text-xs text-muted-foreground truncate max-w-[150px]" title={asset.road || ''}>{asset.road}</div>
                                </TableCell>
                                <TableCell>
                                  {asset.availability ? (
                                    <Badge variant="outline" className={`text-[10px] px-1 py-0 h-4 ${getAvailabilityColor(asset.availability)}`}>
                                      {asset.availability}
                                    </Badge>
                                  ) : <span className="text-xs text-muted-foreground">-</span>}
                                </TableCell>
                                {projectId && (
                                  <TableCell>
                                    {sel ? (
                                      <Badge variant="outline" className={`text-[10px] ${getStatusColor(sel.status)}`}>
                                        {sel.status}
                                      </Badge>
                                    ) : <span className="text-xs text-muted-foreground">-</span>}
                                  </TableCell>
                                )}
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                      {hasNextPage && !showOnlySelected && (
                        <div className="p-4 text-center border-t">
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
                    </div>
                  )}
                </ScrollArea>
              </div>
            </ResizablePanel>
          )}

          {viewMode === "split" && <ResizableHandle withHandle />}

          {/* Map Panel */}
          {viewMode !== "list" && (
            <ResizablePanel defaultSize={viewMode === "map" ? 100 : 60}>
              <div className="h-full relative bg-slate-100 dark:bg-slate-800 z-0">
                <BaseMap center={mapCenter}>
                  <MapUpdater center={mapCenter} selectedId={selectedAssetId} assets={activeAssetsForMap} />
                  {activeAssetsForMap.map(asset => {
                    if (!asset.latitude || !asset.longitude || asset.locationUnavailable) return null;
                    return (
                      <Marker
                        key={asset.id}
                        position={[asset.latitude, asset.longitude]}
                        icon={getMarkerIcon(asset)}
                        eventHandlers={{
                          click: () => setSelectedAssetId(asset.id)
                        }}
                      >
                        <Popup className="custom-popup">
                          <div className="font-semibold">{asset.assetCode}</div>
                          <div className="text-xs text-muted-foreground">{asset.assetType}</div>
                          <div className="text-xs mt-1">{asset.area}</div>
                        </Popup>
                      </Marker>
                    );
                  })}
                </BaseMap>

                {/* Map Legend */}
                <div className="absolute bottom-4 left-4 bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm p-2 rounded-md shadow-md border text-xs flex flex-col gap-1 z-[400]">
                  <div className="font-semibold mb-1">Status Legend</div>
                  <div className="flex items-center gap-2"><div className="w-3 h-3 rounded-full bg-[#10b981] border border-white"></div> Available</div>
                  <div className="flex items-center gap-2"><div className="w-3 h-3 rounded-full bg-[#f43f5e] border border-white"></div> Occupied</div>
                  <div className="flex items-center gap-2"><div className="w-3 h-3 rounded-full bg-[#f59e0b] border border-white"></div> Reserved</div>
                  <div className="flex items-center gap-2"><div className="w-3 h-3 rounded-full bg-[#8b5cf6] border border-white"></div> Maintenance</div>
                  <div className="flex items-center gap-2"><div className="w-3 h-3 rounded-full bg-[#64748b] border border-white"></div> Inactive</div>
                  <div className="flex items-center gap-2"><div className="w-3 h-3 rounded-full bg-[#94a3b8] border border-white"></div> Unknown</div>
                </div>

                {/* Empty Map Message */}
                {activeAssetsForMap.length > 0 && activeAssetsForMap.filter(a => a.latitude != null && a.longitude != null).length === 0 && (
                  <div className="absolute inset-0 z-[500] flex items-center justify-center bg-black/5 backdrop-blur-[2px]">
                    <div className="bg-white dark:bg-slate-900 p-6 rounded-lg shadow-lg border text-center max-w-sm">
                      <MapPin className="h-10 w-10 mx-auto text-muted-foreground mb-3 opacity-50" />
                      <h3 className="font-semibold mb-1">No locations available</h3>
                      <p className="text-sm text-muted-foreground">The filtered active assets do not have coordinates to display on the map.</p>
                    </div>
                  </div>
                )}
              </div>
            </ResizablePanel>
          )}

        </ResizablePanelGroup>

        {/* Asset Detail Slide-out Panel */}
        {selectedAssetId && selectedAsset && (
          <div className="absolute right-0 top-0 bottom-0 w-full sm:w-[400px] bg-white dark:bg-slate-900 border-l shadow-2xl flex flex-col z-20 animate-in slide-in-from-right-8 duration-300">
            <div className="h-14 border-b flex items-center justify-between px-4 shrink-0">
              <div className="font-semibold flex items-center gap-2">
                {selectedAsset.assetCode}
                {projectId && selectionMap[selectedAsset.id] && (
                  <Badge variant="outline" className={getStatusColor(selectionMap[selectedAsset.id].status)}>
                    {selectionMap[selectedAsset.id].status}
                  </Badge>
                )}
              </div>
              <Button variant="ghost" size="icon" className="h-8 w-8 -mr-2" onClick={() => setSelectedAssetId(null)}>
                <X className="h-4 w-4" />
              </Button>
            </div>

            <ScrollArea className="flex-1">
              <div className="p-4 space-y-6">
                {/* Photo */}
                <div className="aspect-video bg-slate-100 dark:bg-slate-800 rounded-lg overflow-hidden relative flex items-center justify-center group">
                  {selectedAsset.photoPath ? (
                    <img src={selectedAsset.photoPath} alt={selectedAsset.assetCode} className="w-full h-full object-cover" />
                  ) : (
                    <div className="flex flex-col items-center text-muted-foreground opacity-50">
                      <ImageIcon className="h-10 w-10 mb-2" />
                      <span className="text-sm">No Photo Available</span>
                    </div>
                  )}
                  {(selectedAsset.latitude == null || selectedAsset.longitude == null || selectedAsset.locationUnavailable) && (
                    <div className="absolute top-2 right-2 bg-black/70 text-white text-[10px] px-2 py-1 rounded backdrop-blur-sm flex items-center gap-1">
                      <EyeOff className="h-3 w-3" /> Location unavailable
                    </div>
                  )}
                  {selectedAsset.mapUrl && (
                    <a
                      href={selectedAsset.mapUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="absolute bottom-2 right-2 bg-black/70 hover:bg-black text-white text-xs px-2 py-1 rounded backdrop-blur-sm flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <ExternalLink className="h-3 w-3" /> Map Link
                    </a>
                  )}
                </div>

                {/* Project Actions */}
                {projectId && (
                  <AssetProjectActions
                    projectId={projectId}
                    assetId={selectedAsset.id}
                    selection={selectionMap[selectedAsset.id]}
                  />
                )}
                {projectId && <Separator />}

                {/* Details */}
                <div className="space-y-4">
                  <div>
                    <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-2 tracking-wider">Location Info</h4>
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                      <dt className="text-muted-foreground">Area</dt>
                      <dd className="font-medium text-right">{selectedAsset.area || '-'}</dd>
                      {selectedAsset.areaNormalized && selectedAsset.areaNormalized !== selectedAsset.area && (
                        <>
                          <dt className="text-muted-foreground">Normalized area</dt>
                          <dd className="font-medium text-right">{selectedAsset.areaNormalized}</dd>
                        </>
                      )}
                      <dt className="text-muted-foreground">Road</dt>
                      <dd className="font-medium text-right">{selectedAsset.road || '-'}</dd>
                      {selectedAsset.roadNormalized && selectedAsset.roadNormalized !== selectedAsset.road && (
                        <>
                          <dt className="text-muted-foreground">Normalized road</dt>
                          <dd className="font-medium text-right">{selectedAsset.roadNormalized}</dd>
                        </>
                      )}
                      <dt className="text-muted-foreground">Direction</dt>
                      <dd className="font-medium text-right">{selectedAsset.direction || '-'}</dd>
                      <dt className="text-muted-foreground">Routes</dt>
                      <dd className="font-medium text-right">{selectedAsset.routes?.join(", ") || '-'}</dd>
                      <dt className="text-muted-foreground">Coordinates</dt>
                      <dd className="font-medium text-right">
                        {selectedAsset.latitude != null && selectedAsset.longitude != null
                          ? `${selectedAsset.latitude.toFixed(4)}, ${selectedAsset.longitude.toFixed(4)}`
                          : '-'}
                      </dd>
                    </dl>
                  </div>

                  <div>
                    <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-2 tracking-wider">Asset Specs</h4>
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                      <dt className="text-muted-foreground">Format</dt>
                      <dd className="font-medium text-right">{selectedAsset.assetType}</dd>
                      {selectedAsset.assetTypeOriginal && selectedAsset.assetTypeOriginal !== selectedAsset.assetType && (
                        <>
                          <dt className="text-muted-foreground">Imported type</dt>
                          <dd className="font-medium text-right">{selectedAsset.assetTypeOriginal}</dd>
                        </>
                      )}
                      <dt className="text-muted-foreground">Media</dt>
                      <dd className="font-medium text-right">{selectedAsset.mediaFormat || '-'}</dd>
                      <dt className="text-muted-foreground">Technology</dt>
                      <dd className="font-medium text-right capitalize">{selectedAsset.displayTechnology || '-'}</dd>
                      <dt className="text-muted-foreground">Dimensions</dt>
                      <dd className="font-medium text-right">{selectedAsset.dimensions || '-'}</dd>
                    </dl>
                  </div>

                  <div>
                    <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-2 tracking-wider">Status & Commercial</h4>
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                      <dt className="text-muted-foreground">Availability</dt>
                      <dd className="font-medium text-right">{selectedAsset.availability || '-'}</dd>
                      <dt className="text-muted-foreground">Client</dt>
                      <dd className="font-medium text-right">{selectedAsset.client || '-'}</dd>
                      <dt className="text-muted-foreground">Campaign</dt>
                      <dd className="font-medium text-right">{selectedAsset.campaign || '-'}</dd>
                      <dt className="text-muted-foreground">Rate</dt>
                      <dd className="font-medium text-right">{selectedAsset.rate || '-'}</dd>
                    </dl>
                  </div>

                  {selectedAsset.mediaUnits && selectedAsset.mediaUnits.length > 0 && (
                    <div>
                      <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-3 tracking-wider">Media Units ({selectedAsset.mediaUnits.length})</h4>
                      <div className="space-y-3">
                        {selectedAsset.mediaUnits.map((unit: any) => (
                          <div key={unit.id} className="border rounded-md p-3 bg-white dark:bg-slate-900 shadow-sm relative overflow-hidden">
                            {unit.lifecycleStatus === 'REMOVED' && (
                              <div className="absolute inset-0 bg-slate-50/80 dark:bg-slate-950/80 z-10 flex flex-col items-center justify-center backdrop-blur-[1px]">
                                <Badge variant="destructive" className="mb-2">REMOVED FROM SOURCE</Badge>
                              </div>
                            )}
                            <div className="flex justify-between items-start mb-2">
                              <div>
                                <div className="font-medium text-sm capitalize">{String(unit.unitType).replace(/_/g, ' ').toLowerCase()}</div>
                                <div className="text-xs text-muted-foreground capitalize">{String(unit.format).toLowerCase()} Format</div>
                              </div>
                              <Badge variant="outline" className={`text-[10px] ${
                                unit.availabilityStatus === 'AVAILABLE' ? 'border-emerald-200 text-emerald-700 bg-emerald-50' :
                                unit.availabilityStatus === 'OCCUPIED' ? 'border-rose-200 text-rose-700 bg-rose-50' :
                                'border-slate-200 text-slate-700 bg-slate-50'
                              }`}>
                                {unit.availabilityStatus}
                              </Badge>
                            </div>

                            <dl className="grid grid-cols-2 gap-x-2 gap-y-1 text-xs mb-3">
                              <dt className="text-muted-foreground">Client</dt>
                              <dd className="font-medium text-right truncate">{unit.currentClient || '-'}</dd>
                              <dt className="text-muted-foreground">Campaign Date</dt>
                              <dd className="font-medium text-right truncate">
                                {unit.campaignStart ? format(new Date(unit.campaignStart), "MMM d") : '-'}
                                {unit.campaignEnd ? ` - ${format(new Date(unit.campaignEnd), "MMM d")}` : ''}
                              </dd>
                            </dl>

                            {projectId && (
                              <div className="pt-2 border-t mt-2">
                                <MediaUnitProjectActions
                                  projectId={projectId}
                                  assetId={selectedAsset.id}
                                  unitId={unit.id}
                                  selection={selectionMap[unit.id]}
                                />
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {(selectedAsset.nearbyPois?.length > 0 || selectedAsset.internalNotes) && (
                    <div>
                      <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-2 tracking-wider">Notes & POIs</h4>
                      {selectedAsset.nearbyPois?.length > 0 && (
                        <div className="mb-2 text-sm">
                          <span className="text-muted-foreground mr-2">POIs:</span>
                          {selectedAsset.nearbyPois.join(", ")}
                        </div>
                      )}
                      {selectedAsset.internalNotes && (
                        <div className="text-sm bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 p-2 rounded text-amber-900 dark:text-amber-200">
                          {selectedAsset.internalNotes}
                        </div>
                      )}
                    </div>
                  )}

                  <div>
                    <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-2 tracking-wider">System</h4>
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                      <dt className="text-muted-foreground">Last Updated</dt>
                      <dd className="font-medium text-right text-muted-foreground">
                        {format(new Date(selectedAsset.updatedAt), "MMM d, yyyy HH:mm")}
                      </dd>
                      {selectedAsset.sourceImportBatchId && (
                        <>
                          <dt className="text-muted-foreground">Import batch</dt>
                          <dd className="font-medium text-right break-all">{selectedAsset.sourceImportBatchId}</dd>
                        </>
                      )}
                    </dl>
                  </div>

                  {selectedAsset.metadata && Object.keys(selectedAsset.metadata).length > 0 && (
                    <div>
                      <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-2 tracking-wider">Provenance / Meta</h4>
                      <div className="bg-slate-50 dark:bg-slate-950 p-3 rounded-md text-xs font-mono overflow-x-auto">
                        <pre>{JSON.stringify(selectedAsset.metadata, null, 2)}</pre>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </ScrollArea>
          </div>
        )}

      </div>
    </div>
  );
}

function MapUpdater({ center, selectedId, assets }: { center: [number, number], selectedId: string | null, assets: any[] }) {
  const map = useMap();
  useEffect(() => {
    if (selectedId) {
      const asset = assets.find(a => a.id === selectedId);
      if (asset && asset.latitude != null && asset.longitude != null) {
        map.setView([asset.latitude, asset.longitude], 14, { animate: true });
      }
    } else if (assets.length > 0) {
      const withCoords = assets.filter(a => a.latitude != null && a.longitude != null);
      if (withCoords.length > 0) {
        const bounds = L.latLngBounds(withCoords.map(a => [a.latitude!, a.longitude!]));
        map.fitBounds(bounds, { padding: [50, 50], animate: true });
      }
    }
  }, [selectedId, assets, map]);
  return null;
}

function AssetProjectActions({ projectId, assetId, selection }: { projectId: string, assetId: string, selection?: any }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const setSelection = useSetProjectInventorySelection();
  const removeSelection = useRemoveProjectInventorySelection();

  const [note, setNote] = useState(selection?.note || "");
  const [isEditingNote, setIsEditingNote] = useState(false);

  useEffect(() => {
    setNote(selection?.note || "");
    setIsEditingNote(false);
  }, [selection, assetId]);

  const handleSetStatus = (status: "shortlist" | "selected" | "rejected") => {
    setSelection.mutate({
      projectId,
      assetId,
      data: { status, note }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListProjectInventorySelectionsQueryKey(projectId) });
        toast({ title: "Status Updated", description: `Asset marked as ${status}.` });
      },
      onError: (err: any) => {
        toast({ title: "Error", description: err.message, variant: "destructive" });
      }
    });
  };

  const handleRemove = () => {
    removeSelection.mutate({ projectId, assetId }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListProjectInventorySelectionsQueryKey(projectId) });
        toast({ title: "Removed", description: "Asset removed from project selections." });
      },
      onError: (err: any) => {
        toast({ title: "Error", description: err.message, variant: "destructive" });
      }
    });
  };

  const handleSaveNote = () => {
    if (selection) {
      setSelection.mutate({
        projectId,
        assetId,
        data: { status: selection.status, note }
      }, {
        onSuccess: () => {
          setIsEditingNote(false);
          queryClient.invalidateQueries({ queryKey: getListProjectInventorySelectionsQueryKey(projectId) });
          toast({ title: "Note Saved" });
        },
        onError: (err: any) => {
          toast({ title: "Error", description: err.message, variant: "destructive" });
        }
      });
    }
  };

  return (
    <div className="space-y-4 bg-slate-50 dark:bg-slate-900 -mx-4 px-4 py-4 border-y">
      <div className="flex gap-2">
        <Button
          variant={selection?.status === 'shortlist' ? "default" : "outline"}
          size="sm"
          className="flex-1 bg-amber-500 hover:bg-amber-600 text-white border-none"
          onClick={() => handleSetStatus("shortlist")}
          disabled={setSelection.isPending}
        >
          <Clock className="h-3 w-3 mr-1" /> Shortlist
        </Button>
        <Button
          variant={selection?.status === 'selected' ? "default" : "outline"}
          size="sm"
          className="flex-1 bg-green-600 hover:bg-green-700 text-white border-none"
          onClick={() => handleSetStatus("selected")}
          disabled={setSelection.isPending}
        >
          <Check className="h-3 w-3 mr-1" /> Select
        </Button>
        <Button
          variant={selection?.status === 'rejected' ? "default" : "outline"}
          size="sm"
          className="flex-1 bg-red-500 hover:bg-red-600 text-white border-none"
          onClick={() => handleSetStatus("rejected")}
          disabled={setSelection.isPending}
        >
          <XCircle className="h-3 w-3 mr-1" /> Reject
        </Button>
      </div>

      {selection && (
        <div className="space-y-2 pt-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-muted-foreground uppercase">Project Note</span>
            {!isEditingNote && (
              <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => setIsEditingNote(true)}>
                Edit
              </Button>
            )}
          </div>
          {isEditingNote ? (
            <div className="space-y-2">
              <Textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Add a note about this location for the pitch..."
                className="text-sm min-h-[80px]"
              />
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => { setIsEditingNote(false); setNote(selection.note || ""); }}>Cancel</Button>
                <Button size="sm" onClick={handleSaveNote} disabled={setSelection.isPending}>Save</Button>
              </div>
            </div>
          ) : (
            <div className="text-sm bg-white dark:bg-slate-950 border rounded-md p-3 min-h-[60px] cursor-pointer" onClick={() => setIsEditingNote(true)}>
              {note || <span className="text-muted-foreground italic">No note added.</span>}
            </div>
          )}

          <div className="pt-2 flex justify-end">
            <Button variant="ghost" size="sm" className="text-destructive h-auto px-2 py-1 text-xs" onClick={handleRemove} disabled={removeSelection.isPending}>
              Remove from Project
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
function MediaUnitProjectActions({ projectId, assetId, unitId, selection }: { projectId: string, assetId: string, unitId: string, selection?: any }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const setSelection = useSetProjectInventoryUnitSelection();
  const removeSelection = useRemoveProjectInventoryUnitSelection();

  const handleSetStatus = (status: "shortlist" | "selected" | "rejected") => {
    setSelection.mutate({
      projectId,
      assetId,
      unitId,
      data: { status }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListProjectInventorySelectionsQueryKey(projectId) });
        toast({ title: "Unit Status Updated", description: `Media unit marked as ${status}.` });
      },
      onError: (err: any) => {
        toast({ title: "Error", description: err.message, variant: "destructive" });
      }
    });
  };

  const handleRemove = () => {
    removeSelection.mutate({ projectId, assetId, unitId }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListProjectInventorySelectionsQueryKey(projectId) });
        toast({ title: "Selection Removed" });
      }
    });
  };

  return (
    <div className="flex items-center gap-1 mt-2">
      {selection && (
        <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive opacity-50 hover:opacity-100 shrink-0" onClick={handleRemove} title="Remove Selection">
          <XCircle className="h-3 w-3" />
        </Button>
      )}
      <div className="flex-1 flex gap-1">
        <Button
          variant={selection?.status === 'shortlist' ? 'default' : 'outline'}
          size="sm"
          className={`flex-1 h-6 text-[10px] px-1 ${selection?.status === 'shortlist' ? 'bg-amber-500 hover:bg-amber-600' : ''}`}
          onClick={() => handleSetStatus('shortlist')}
        >
          <Clock className="h-3 w-3 mr-1" /> Shortlist
        </Button>
        <Button
          variant={selection?.status === 'selected' ? 'default' : 'outline'}
          size="sm"
          className={`flex-1 h-6 text-[10px] px-1 ${selection?.status === 'selected' ? 'bg-green-600 hover:bg-green-700' : ''}`}
          onClick={() => handleSetStatus('selected')}
        >
          <Check className="h-3 w-3 mr-1" /> Select
        </Button>
        <Button
          variant={selection?.status === 'rejected' ? 'default' : 'outline'}
          size="sm"
          className={`flex-1 h-6 text-[10px] px-1 ${selection?.status === 'rejected' ? 'bg-red-600 hover:bg-red-700' : ''}`}
          onClick={() => handleSetStatus('rejected')}
        >
          <X className="h-3 w-3 mr-1" /> Reject
        </Button>
      </div>
    </div>
  );
}
