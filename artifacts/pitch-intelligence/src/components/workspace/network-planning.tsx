import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  getGetNetworkRecommendationsQueryKey,
  getGetProjectWorkspaceQueryKey,
  useGetNetworkRecommendations,
  useGetProjectWorkspace,
  usePlanNetworkQuantity,
} from "@workspace/api-client-react";
import { Link } from "wouter";
import { AlertTriangle, Bus, MapPin, Route } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";

interface NetworkPlanningProps {
  projectId: string;
}

export function NetworkPlanning({ projectId }: NetworkPlanningProps) {
  const workspaceQuery = useGetProjectWorkspace(projectId, {
    query: {
      enabled: !!projectId,
      queryKey: getGetProjectWorkspaceQueryKey(projectId),
    },
  });
  const recommendationsQuery = useGetNetworkRecommendations(projectId, {
    query: {
      enabled: !!projectId,
      queryKey: getGetNetworkRecommendationsQueryKey(projectId),
    },
  });
  const planMutation = usePlanNetworkQuantity();
  const [quantity, setQuantity] = useState("");
  const [quantityError, setQuantityError] = useState("");
  const [previewProjectId, setPreviewProjectId] = useState<string | null>(null);
  const workspace = workspaceQuery.data;
  const customPreview = previewProjectId === projectId ? planMutation.data : undefined;
  const recommendation = customPreview ?? recommendationsQuery.data;
  const projectTarget = workspace?.project.targetQuantity;
  const preferredMedia = workspace?.project.preferredMedia;
  const displayedQuantity = quantity || "50";
  const routeRecommendations = recommendation?.recommendations ?? [];
  const passengerEvidenceStatus = recommendation?.routeLevelEvidence.status as string | undefined;
  const passengerSupportedVariants = recommendation?.passengerEvidenceCoverage.supportedRecommendedVariants ?? 0;
  const recommendedVariantCount = recommendation?.passengerEvidenceCoverage.recommendedVariants ?? 0;
  const variantsWithoutPassengerEvidence = routeRecommendations.filter(
    (route) => !route.evidenceSources.includes("PASSENGER_EVIDENCE"),
  );
  const nonPassengerEvidenceSources = new Set(
    variantsWithoutPassengerEvidence.flatMap((route) => route.evidenceSources),
  );
  const nonPassengerSupportBasis = [
    nonPassengerEvidenceSources.has("GEOGRAPHY_FROM_TO_VIA") ? "From/To/Via target-text overlap" : null,
    nonPassengerEvidenceSources.has("SOURCE_BUS_COUNT") ? "reported source bus-count context where available" : null,
  ].filter((basis): basis is string => basis !== null);
  const routeFamilyEvidence = recommendation?.routeFamilyPassengerEvidence ?? [];

  useEffect(() => {
    planMutation.reset();
    setPreviewProjectId(null);
    setQuantity("");
    setQuantityError("");
  }, [projectId]);

  const handlePlan = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const targetBuses = Number(quantity);
    if (!Number.isInteger(targetBuses) || targetBuses <= 0) {
      setQuantityError("Enter a positive whole number of buses.");
      return;
    }
    if (targetBuses > 10000) {
      setQuantityError("The target must be 10,000 buses or fewer.");
      return;
    }
    setQuantityError("");
    planMutation.mutate(
      { projectId, data: { targetBuses } },
      {
        onSuccess: () => {
          setPreviewProjectId(projectId);
          setQuantity(String(targetBuses));
        },
        onError: (error) => setQuantityError(error.message || "Could not plan this network quantity."),
      },
    );
  };

  return (
    <main className="flex-1 overflow-y-auto p-4 md:p-6">
      <div className="mx-auto max-w-6xl space-y-5">
        <header>
          <p className="text-xs font-semibold uppercase tracking-widest text-brand">Inventory · Network planning</p>
          <h1 className="mt-1 text-2xl font-semibold">Brand Awareness / Network</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
            Source-backed bus route recommendations help shape a proposed brand-awareness network. This is planning guidance only; it does not reserve or book vehicles.
          </p>
        </header>

        {workspaceQuery.isLoading ? (
          <Card><CardContent className="space-y-3 p-5"><Skeleton className="h-5 w-1/3" /><Skeleton className="h-4 w-2/3" /></CardContent></Card>
        ) : workspaceQuery.isError ? (
          <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm">
            Project objective and target details could not be loaded. {workspaceQuery.error instanceof Error ? workspaceQuery.error.message : "Try again later."}
          </div>
        ) : (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Project context</CardTitle>
              <CardDescription>Planning context comes from this project workspace.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 text-sm sm:grid-cols-3">
              <div><div className="text-xs text-muted-foreground">Objective</div><div className="mt-1 font-medium">{workspace?.project.pitchObjective || "Not specified"}</div></div>
              <div><div className="text-xs text-muted-foreground">Preferred media</div><div className="mt-1 font-medium">{preferredMedia === "bus" ? "Bus" : preferredMedia === "bus_shelter" ? "Bus shelter" : preferredMedia === "both" ? "Bus and bus shelter" : "Not specified"}</div></div>
              <div><div className="text-xs text-muted-foreground">Project target quantity</div><div className="mt-1 font-medium">{projectTarget && projectTarget > 0 ? `${projectTarget} buses` : "Not set · recommendations default to 50 buses"}</div></div>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><Bus className="h-4 w-4 text-brand" /> Plan network quantity</CardTitle>
            <CardDescription>Default recommendations load from the project network API. Set a custom target to request a quantity-specific preview.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handlePlan} className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="w-full max-w-xs space-y-2">
                <Label htmlFor="network-target">Target buses</Label>
                <Input
                  id="network-target"
                  data-testid="input-network-target"
                  type="number"
                  min="1"
                  max="10000"
                  step="1"
                  value={displayedQuantity}
                  onChange={(event) => {
                    setQuantity(event.target.value);
                    setQuantityError("");
                  }}
                  aria-invalid={!!quantityError}
                  aria-describedby={quantityError ? "network-target-error" : "network-target-help"}
                />
                <p id="network-target-help" className="text-xs text-muted-foreground">Enter a positive whole number (up to 10,000).</p>
              </div>
              <Button type="submit" data-testid="button-plan-network" disabled={planMutation.isPending || !quantity}>
                {planMutation.isPending ? "Planning…" : "Plan custom quantity"}
              </Button>
            </form>
            {quantityError && <p id="network-target-error" role="alert" className="mt-2 text-sm text-destructive">{quantityError}</p>}
            <p className="mt-3 text-xs text-muted-foreground">The custom quantity is a temporary preview only and is not saved. It is not a booking or confirmation of physical vehicle availability.</p>
          </CardContent>
        </Card>

        {preferredMedia === "bus_shelter" && (
          <div role="note" data-testid="notice-network-media-mismatch" className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
            <strong>Not in the selected media brief:</strong> this project prefers bus-shelter media. The route variants below are network-planning context only, not a recommended or preferred media choice for this brief.
          </div>
        )}

        {recommendationsQuery.isLoading ? (
          <div className="space-y-3" aria-label="Loading network recommendations"><Skeleton className="h-24 w-full" /><Skeleton className="h-40 w-full" /></div>
        ) : recommendationsQuery.isError && !planMutation.data ? (
          <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm">
            Network recommendations could not be loaded. {recommendationsQuery.error instanceof Error ? recommendationsQuery.error.message : "Try again later."}
          </div>
        ) : recommendation ? (
          <>
            <section aria-label="Network proposal summary" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Summary label="Target quantity" value={`${recommendation.targetBuses} buses`} icon={<Bus className="h-4 w-4" />} />
              <Summary label="Proposed total" value={`${recommendation.proposedTotal} buses`} icon={<Route className="h-4 w-4" />} />
              <Summary label="Shortfall" value={`${recommendation.shortfall} buses`} icon={<AlertTriangle className="h-4 w-4" />} />
              <Summary label="Project market · context only" value={recommendation.geography || "Not supplied"} icon={<MapPin className="h-4 w-4" />} />
            </section>
            <p className="text-xs text-muted-foreground" data-testid="status-network-geography-scope">
              Project market is context only; it does not confirm the routes’ operating geography.
            </p>
            {customPreview && (
              <div role="status" data-testid="status-custom-network-preview" className="rounded-md border border-brand/30 bg-brand/5 px-4 py-3 text-sm">
                <strong>Temporary custom-quantity preview</strong> — this result is not saved. On reload, default recommendations are recalculated from the project target quantity, or 50 buses if no target is set.
              </div>
            )}

            <Card data-testid="summary-passenger-evidence-coverage">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Passenger evidence coverage</CardTitle>
                <CardDescription>Coverage counts variants with passenger evidence specifically matched to that source variant.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                <p className="text-lg font-semibold" data-testid="status-passenger-coverage-count">
                  Passenger-supported recommended variants: {passengerSupportedVariants} of {recommendedVariantCount}
                </p>
                {recommendedVariantCount === 0 ? (
                  <p className="text-sm text-muted-foreground" data-testid="status-passenger-coverage-limits">
                    No recommended route variants were returned, so variant-level passenger coverage cannot be reported.
                  </p>
                ) : variantsWithoutPassengerEvidence.length > 0 ? (
                  <p className="text-sm leading-6 text-muted-foreground" data-testid="status-passenger-coverage-limits">
                    The remaining {variantsWithoutPassengerEvidence.length} recommended {variantsWithoutPassengerEvidence.length === 1 ? "variant has" : "variants have"} no variant-specific passenger evidence. Their individual planning basis is {nonPassengerSupportBasis.length ? nonPassengerSupportBasis.join(" and ") : "non-passenger planning context"}. Route-family-only passenger evidence is shown separately and does not support an individual variant.
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground" data-testid="status-passenger-coverage-limits">
                    All returned recommended variants have variant-specific passenger evidence. This does not establish advertising reach, impressions, or vehicle availability.
                  </p>
                )}
              </CardContent>
            </Card>

            {routeFamilyEvidence.length > 0 && (
              <Card data-testid="section-route-family-passenger-evidence">
                <CardHeader>
                  <CardTitle className="text-base">Route-family passenger evidence</CardTitle>
                  <CardDescription>
                    Each route-family metric is shown once. It is not variant-specific and is not used to rank individual source variants.
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-3 sm:grid-cols-2">
                  {routeFamilyEvidence.map(({ routeId, summary }) => (
                    <article key={routeId} data-testid={`card-route-family-passenger-${routeId}`} className="rounded-lg border bg-card p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h3 className="font-semibold">Route {routeId} · route family</h3>
                        <Badge variant="outline">Route-level only</Badge>
                      </div>
                      <p className="mt-3 text-sm">
                        {summary.latest
                          ? `${summary.latest.period}: ${summary.latest.passengerCount.toLocaleString()} passenger journeys`
                          : "No latest-period passenger total available."}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {summary.availablePeriods} distinct reported month(s)
                        {summary.firstPeriod && summary.lastPeriod ? ` · ${summary.firstPeriod}–${summary.lastPeriod}` : ""}.
                        This family-level figure is not copied to its variants.
                      </p>
                    </article>
                  ))}
                </CardContent>
              </Card>
            )}

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Route-level source variants</CardTitle>
                <CardDescription>Source bus counts are source context only; they are not a measure of fleet availability.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {!recommendation.recommendations.length ? (
                  <p className="rounded-md border border-dashed p-5 text-sm text-muted-foreground">No route variants were returned for this proposal.</p>
                ) : routeRecommendations.map((route) => (
                  <article key={route.sourceVariantId} data-testid={`card-network-route-${route.sourceVariantId}`} className="rounded-lg border bg-card p-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h3 className="font-semibold">Route {route.routeId}</h3>
                        <p className="mt-1 text-xs text-muted-foreground">From: {route.from || "Not supplied"} <span aria-hidden="true">→</span> To: {route.to || "Not supplied"}</p>
                        <p className="text-xs text-muted-foreground">Via: {route.via || "Not supplied"}</p>
                      </div>
                      <Badge variant={route.isRejected ? "destructive" : route.isActive ? "default" : "secondary"}>
                        {route.isRejected ? "Rejected source variant" : route.isActive ? "Active source variant" : "Inactive source variant"}
                      </Badge>
                    </div>
                    <dl className="mt-4 grid gap-3 border-t pt-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                      <div><dt className="text-xs text-muted-foreground">Proposed quantity</dt><dd className="font-medium">{route.proposedQuantity}</dd></div>
                      <div><dt className="text-xs text-muted-foreground">Source bus count · context only, not availability</dt><dd className="font-medium">{route.sourceBusCount ?? "Not supplied"}</dd></div>
                      <div><dt className="text-xs text-muted-foreground">Source row</dt><dd className="font-medium">{route.sourceSheet}, row {route.sourceRow}</dd></div>
                      <div><dt className="text-xs text-muted-foreground">Matched targets</dt><dd className="font-medium">{route.matchedTargets.length ? route.matchedTargets.join(", ") : "None supplied"}</dd></div>
                      <div><dt className="text-xs text-muted-foreground">Text-target overlap</dt><dd className="font-medium">{Math.round(route.targetOverlapRatio * 100)}% · suggestive only</dd></div>
                      <div><dt className="text-xs text-muted-foreground">Share of reported counts across target-matched candidates</dt><dd className="font-medium">{route.reportedSourceBusCountShare == null ? "Not available" : `${(route.reportedSourceBusCountShare * 100).toFixed(1)}%`}</dd></div>
                    </dl>
                    <div className="mt-3 border-t pt-3" data-testid={`evidence-sources-${route.sourceVariantId}`}>
                      <p className="mb-2 text-xs text-muted-foreground">Evidence basis</p>
                      <div className="flex flex-wrap gap-2">
                        {route.evidenceSources.map((source) => (
                          <Badge key={source} variant="outline">
                            {source === "PASSENGER_EVIDENCE"
                              ? "Passenger evidence · variant-specific"
                              : source === "GEOGRAPHY_FROM_TO_VIA"
                                ? "Geography · From/To/Via target text"
                                : source === "SOURCE_BUS_COUNT"
                                  ? "Source bus count · context only"
                                  : source}
                          </Badge>
                        ))}
                        {!route.evidenceSources.length && <span className="text-xs text-muted-foreground">No evidence sources reported.</span>}
                      </div>
                    </div>
                    {route.routeFamilyPassengerEvidence === "ROUTE_LEVEL_ONLY" && (
                      <p
                        role="note"
                        data-testid={`status-route-family-only-${route.sourceVariantId}`}
                        className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100"
                      >
                        Passenger evidence available at route level only — not variant-specific
                      </p>
                    )}
                    <p className="mt-3 text-sm text-muted-foreground">{route.rationale}</p>
                    <p className="mt-1 text-xs text-muted-foreground">Quantity basis: {route.quantityBasis}</p>
                    {route.routePassengerEvidence?.map((evidence) => (
                      <div key={`${evidence.source}:${evidence.sourceRow}:${evidence.period}`} className="mt-3 rounded-md border border-brand/20 bg-brand/5 p-3 text-sm" data-testid={`route-passenger-evidence-${route.routeId}`}>
                        <strong>Variant-specific passenger evidence · {evidence.period}:</strong>{" "}
                         {evidence.passengerCount.toLocaleString()} passenger journeys
                         {evidence.tripCount !== null && evidence.tripCount !== undefined && ` across ${evidence.tripCount.toLocaleString()} vehicle trips`}.
                        <p className="mt-1 text-xs text-muted-foreground">
                          Source: {evidence.source}{evidence.sourceRow ? `, row ${evidence.sourceRow}` : ""}{evidence.importedAt ? ` · imported ${new Date(evidence.importedAt).toLocaleString()}` : ""}.
                           Matched to this source route variant only. This is public-transit ridership, not ad impressions, reach, or proof of fleet availability.
                        </p>
                        {route.routePassengerSummary && (
                          <div className="mt-3 grid gap-2 border-t border-brand/20 pt-3 text-xs sm:grid-cols-2">
                             <p>Previous reported month: {route.routePassengerSummary.previous ? `${route.routePassengerSummary.previous.period} · ${route.routePassengerSummary.previous.passengerCount.toLocaleString()} passenger journeys` : "Not available"}</p>
                            <p>Available reporting range: {route.routePassengerSummary.firstPeriod && route.routePassengerSummary.lastPeriod ? `${route.routePassengerSummary.firstPeriod}–${route.routePassengerSummary.lastPeriod}` : "Not available"}</p>
                            <p>3-month average: {route.routePassengerSummary.threeMonthAverage == null ? "Not available" : `${route.routePassengerSummary.threeMonthAverage.toLocaleString(undefined, { maximumFractionDigits: 2 })} passenger journeys across ${route.routePassengerSummary.threeMonthPeriods} reported month(s)`}</p>
                            <p>6-month average: {route.routePassengerSummary.sixMonthAverage == null ? "Not available" : `${route.routePassengerSummary.sixMonthAverage.toLocaleString(undefined, { maximumFractionDigits: 2 })} passenger journeys across ${route.routePassengerSummary.sixMonthPeriods} reported month(s)`}</p>
                            <p>Available-period total: {route.routePassengerSummary.availableTotal == null ? "Not available" : route.routePassengerSummary.availableTotal.toLocaleString()} passenger journeys across {route.routePassengerSummary.availablePeriods} distinct month(s)</p>
                            <p>Passenger journeys per vehicle trip: {route.routePassengerSummary.latest?.passengersPerTrip == null ? "Not calculated (vehicle-trip count missing or zero)" : route.routePassengerSummary.latest.passengersPerTrip.toFixed(2)}</p>
                            <p>Same-month route percentile: {route.routePassengerSummary.passengerPercentile == null ? "Not available" : `${route.routePassengerSummary.passengerPercentile.toFixed(0)}th`}</p>
                            <p>Duplicate periods: {route.routePassengerSummary.duplicatePeriods} · Conflicting periods excluded: {route.routePassengerSummary.conflictingPeriods}</p>
                            <p>Reported activity status: {route.routePassengerSummary.activity.replaceAll("_", " ").toLocaleLowerCase()}</p>
                          </div>
                        )}
                      </div>
                    ))}
                  </article>
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="text-base">Evidence and limitations</CardTitle></CardHeader>
              <CardContent className="space-y-3 text-sm">
                <p className="rounded-md bg-muted/50 p-3" data-testid="status-rta-data">
                  {recommendation.routeLevelEvidence.provider}: {passengerSupportedVariants > 0
                    ? `variant-specific passenger journeys are available for ${passengerSupportedVariants} recommended variant(s).`
                    : routeFamilyEvidence.length > 0
                      ? "passenger journeys are available at route-family level only; they are not attributable to individual variants."
                      : passengerEvidenceStatus === "available"
                        ? "passenger journeys are available, but not specifically matched to a recommended variant."
                        : "no safely matched passenger-journey evidence is available for the proposed variants."} The source file was user-provided; external provenance has not been independently checked. No advertising reach or impressions are derived.
                  {recommendation.routeLevelEvidence.note ? ` ${recommendation.routeLevelEvidence.note}` : ""}
                </p>
                {recommendation.limitations.length > 0 ? (
                  <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                    {recommendation.limitations.map((limitation, index) => <li key={`${index}-${limitation}`}>{limitation}</li>)}
                  </ul>
                ) : <p className="text-muted-foreground">No additional limitations were supplied by the recommendation service.</p>}
                <p className="border-t pt-3 text-muted-foreground">
                  For store-led plans, use the <Link href={`/projects/${projectId}/locations`} className="font-medium text-brand underline underline-offset-2">Locations map</Link> to review approved-store proximity. This route panel does not duplicate that location analysis.
                </p>
                <p className="text-xs text-muted-foreground">Recommendations are proposals only. Review route selections and any required override through the existing Bus Routes controls; nothing here is auto-added, reserved, or booked.</p>
              </CardContent>
            </Card>
          </>
        ) : null}
      </div>
    </main>
  );
}

function Summary({ label, value, icon }: { label: string; value: string; icon: ReactNode }) {
  return (
    <Card data-testid={`summary-network-${label.toLowerCase().replaceAll(" ", "-")}`}>
      <CardContent className="flex items-start justify-between gap-3 p-4">
        <div><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 text-lg font-semibold">{value}</p></div>
        <span className="text-brand" aria-hidden="true">{icon}</span>
      </CardContent>
    </Card>
  );
}