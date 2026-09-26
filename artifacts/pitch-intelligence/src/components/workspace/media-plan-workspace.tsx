import { useGetProjectMediaPlan } from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { MapPin, Bus, LayoutTemplate } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";

export function MediaPlanWorkspace({ projectId }: { projectId: string }) {
  const { data: mediaPlan, isLoading } = useGetProjectMediaPlan(projectId);

  if (isLoading) {
    return (
      <div className="flex-1 p-6 space-y-4 bg-white dark:bg-slate-950">
        <Skeleton className="h-12 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!mediaPlan) {
    return (
      <div className="flex-1 flex items-center justify-center bg-white dark:bg-slate-950">
        <div className="text-muted-foreground">Media plan not found.</div>
      </div>
    );
  }

  const allShelterSelections = [
    ...mediaPlan.shelterSelections,
    ...mediaPlan.rejectedShelterSelections,
  ];
  const inScopeShelterCount = mediaPlan.shelterSelections
    .filter((selection) => selection.campaignGeographyStatus === "IN_CAMPAIGN_GEOGRAPHY").length;

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-slate-50 dark:bg-slate-950 border rounded-lg overflow-hidden">
      <div className="border-b bg-white dark:bg-slate-900 px-6 py-4 flex items-center justify-between shrink-0">
        <h3 className="text-lg font-semibold flex items-center gap-2">
          <LayoutTemplate className="h-5 w-5 text-brand" />
          Project Media Plan
        </h3>
        <div className="flex gap-4">
          <Badge variant="secondary" className="px-3 py-1">
            {inScopeShelterCount} In-Scope Shelter Media Units
          </Badge>
          <Badge variant="secondary" className="px-3 py-1 bg-brand/10 text-brand border-brand/20">
            {mediaPlan.totalProposedBuses} Proposed Buses
          </Badge>
        </div>
      </div>

      <ScrollArea className="flex-1 p-6">
        <div className="space-y-8">
          <div>
            <h4 className="font-semibold mb-4 flex items-center gap-2">
              <Bus className="h-4 w-4 text-muted-foreground" />
              Bus Route Selections
            </h4>
            {mediaPlan.busPlan.selections.length === 0 ? (
              <div className="text-sm text-muted-foreground italic border rounded-lg p-4 bg-white dark:bg-slate-900">No bus routes proposed yet.</div>
            ) : (
              <div className="border rounded-lg bg-white dark:bg-slate-900 overflow-hidden">
                <Table>
                  <TableHeader className="bg-slate-50 dark:bg-slate-950">
                    <TableRow>
                      <TableHead className="w-[120px]">Route ID</TableHead>
                      <TableHead>Path</TableHead>
                      <TableHead>Depot</TableHead>
                      <TableHead className="w-[120px] text-right">Source Buses</TableHead>
                      <TableHead className="w-[120px] text-right">Proposed</TableHead>
                      <TableHead className="w-[120px]">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {mediaPlan.busPlan.selections.map((sel) => (
                      <TableRow key={sel.id}>
                        <TableCell className="font-medium">
                          {sel.routeId}
                          {!sel.isSourceActive && <span className="block text-xs text-amber-700">MISSING_FROM_SOURCE</span>}
                          {sel.requiresOverride && <span className="block text-xs text-amber-700">Review source count</span>}
                        </TableCell>
                        <TableCell className="text-sm">
                          <div>{sel.from || "Unknown"} &rarr; {sel.to || "Unknown"}</div>
                          {sel.via && <div className="text-xs text-muted-foreground truncate max-w-[200px]" title={sel.via}>Via: {sel.via}</div>}
                        </TableCell>
                        <TableCell className="text-sm">{sel.depot || "-"}</TableCell>
                        <TableCell className="text-right text-sm text-muted-foreground">{sel.sourceBusCount ?? "Not supplied"}</TableCell>
                        <TableCell className="text-right font-medium">
                          {sel.proposedQuantity}
                          {sel.status !== "REJECTED" &&
                            sel.campaignGeographyStatus !== "IN_CAMPAIGN_GEOGRAPHY" && (
                              <span className="block text-xs font-normal text-muted-foreground">not counted</span>
                            )}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col items-start gap-1">
                            <Badge variant="outline" className={
                              sel.status === 'PROPOSED' ? 'bg-blue-50 text-blue-700 border-blue-200' :
                              sel.status === 'SHORTLISTED' ? 'bg-amber-50 text-amber-700 border-amber-200' :
                              'bg-rose-50 text-rose-700 border-rose-200'
                            }>
                              {sel.status === "REJECTED" ? "REJECTED · not counted" : sel.status}
                            </Badge>
                            <Badge variant="outline" className="text-[10px]">
                              {sel.campaignGeographyStatus.replaceAll("_", " ")}
                            </Badge>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>

          <div>
            <h4 className="font-semibold mb-4 flex items-center gap-2">
              <MapPin className="h-4 w-4 text-muted-foreground" />
              Shelter & Unit Selections
            </h4>
            {allShelterSelections.length === 0 ? (
              <div className="text-sm text-muted-foreground italic border rounded-lg p-4 bg-white dark:bg-slate-900">No static/digital units selected yet.</div>
            ) : (
              <div className="border rounded-lg bg-white dark:bg-slate-900 overflow-hidden">
                <Table>
                  <TableHeader className="bg-slate-50 dark:bg-slate-950">
                    <TableRow>
                      <TableHead className="w-[150px]">Asset Code</TableHead>
                      <TableHead>Location</TableHead>
                       <TableHead>Selected Media Unit</TableHead>
                      <TableHead className="w-[120px]">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {allShelterSelections.map((sel) => (
                      <TableRow key={sel.selectionId}>
                        <TableCell className="font-medium text-sm">{sel.assetCode}</TableCell>
                        <TableCell className="text-sm">
                          <div className="truncate max-w-[300px]" title={sel.assetName || ""}>{sel.assetName || "-"}</div>
                          <div className="text-xs text-muted-foreground">{sel.area || "Area unknown"}</div>
                        </TableCell>
                         <TableCell className="text-sm">{sel.mediaUnitType ?? sel.mediaFormat ?? sel.assetType}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className={
                            sel.status === 'selected' ? 'bg-green-50 text-green-700 border-green-200' :
                            sel.status === 'shortlist' ? 'bg-amber-50 text-amber-700 border-amber-200' :
                            'bg-rose-50 text-rose-700 border-rose-200'
                          }>
                            {sel.status === "rejected" ? "REJECTED · not counted" : sel.status}
                          </Badge>
                          <Badge variant="outline" className="ml-1 text-[10px]">
                            {sel.campaignGeographyStatus.replaceAll("_", " ")}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
