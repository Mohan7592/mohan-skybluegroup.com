import type { StoreCoverage, StoreCoverageLocation } from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";

export type CoverageRadius = 200 | 500 | 800 | 1000;
export const coverageRadii: CoverageRadius[] = [200, 500, 800, 1000];
export const radiusLabel = (radius: CoverageRadius) => radius === 1000 ? "1 km" : `${radius} m`;

export function StoreCoverageSummary({ coverage, radius, focused, onFocus, loading, error, onRetry }: {
  coverage?: StoreCoverage;
  radius: CoverageRadius;
  focused: StoreCoverageLocation | null;
  onFocus: (id: string) => void;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
}) {
  if (loading) return <section className="rounded-xl border bg-card p-5" aria-label="Loading store coverage"><Skeleton className="h-6 w-52" /><Skeleton className="mt-5 h-20 w-full" /><Skeleton className="mt-4 h-40 w-full" /></section>;
  if (error) return <section className="rounded-xl border bg-card p-5"><h3 className="font-semibold">Store coverage could not load</h3><p className="mt-2 text-sm text-muted-foreground">The map can still show approved places. Retry to see verified inventory proximity.</p><Button className="mt-4" variant="outline" onClick={onRetry}>Retry coverage</Button></section>;
  if (!coverage) return null;
  const band = coverage.aggregate.bands[String(radius) as keyof typeof coverage.aggregate.bands];
  const focusedBand = focused?.bands[String(radius) as keyof StoreCoverageLocation["bands"]];
  const nearby = focused?.nearbyShelters.filter(s => s.distanceMeters <= radius).sort((a, b) => a.distanceMeters - b.distanceMeters) || [];
  return <section className="overflow-hidden rounded-xl border bg-card shadow-sm" aria-label="Store coverage summary" data-testid="section-store-coverage">
    <div className="border-b px-5 py-4"><div className="text-[11px] font-bold uppercase tracking-widest text-brand">Inventory proximity / straight-line</div><h3 className="mt-1 text-lg font-semibold">Store Coverage Summary</h3><p className="mt-1 text-xs text-muted-foreground">Approved client locations only. Counts are proximity matches, not availability or audience estimates.</p></div>
    <div className="grid grid-cols-2 gap-px bg-border sm:grid-cols-3">
      {[
        ["Approved client locations", coverage.locations.length],
        [`Locations covered · ${radiusLabel(radius)}`, band.locationsCoveredCount],
        ["Unique matching shelters", band.uniqueShelterCount],
        ["Digital Top Panels", band.mediaUnitCounts.digitalTopPanels],
        ["Digital MUPIs", band.mediaUnitCounts.digitalMupis],
        ["Static media units", band.mediaUnitCounts.static],
      ].map(([label, value]) => <div key={label} className="bg-card px-4 py-4"><div className="text-2xl font-semibold tabular-nums text-foreground" data-testid={`value-coverage-${String(label).toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`}>{value}</div><div className="mt-1 text-xs leading-4 text-muted-foreground">{label}</div></div>)}
    </div>
    <div className="border-t px-5 py-4"><h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Locations covered by band</h4><div className="mt-3 grid grid-cols-4 gap-2">{coverageRadii.map(r => <div key={r} className={`rounded-lg border px-2 py-2 text-center ${r === radius ? "border-brand bg-brand/5" : ""}`}><div className="text-xs text-muted-foreground">{radiusLabel(r)}</div><div className="mt-1 font-semibold tabular-nums">{coverage.aggregate.bands[String(r) as keyof typeof coverage.aggregate.bands].locationsCoveredCount}<span className="font-normal text-muted-foreground"> / {coverage.locations.length}</span></div></div>)}</div></div>
    <div className="border-t px-5 py-4"><h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Client locations</h4>{coverage.locations.length ? <div className="mt-2 max-h-64 space-y-1 overflow-y-auto">{coverage.locations.map(location => {
      const local = location.bands[String(radius) as keyof StoreCoverageLocation["bands"]];
      return <button type="button" key={location.id} data-testid={`button-focus-store-${location.id}`} onClick={() => onFocus(location.id)} aria-pressed={focused?.id === location.id} className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-brand/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand ${focused?.id === location.id ? "bg-brand/10 text-brand" : ""}`}><span className="min-w-0 truncate font-medium">{location.name}</span><span className="shrink-0 text-xs tabular-nums text-muted-foreground">{local.shelterCount} shelters</span></button>;
    })}</div> : <p className="mt-3 text-sm text-muted-foreground">No approved client locations yet. Discover and approve a client place to see its nearby inventory.</p>}</div>
    {focused && <div className="border-t bg-brand/5 px-5 py-4" data-testid="section-focused-store-coverage"><h4 className="font-semibold">{focused.name}</h4><p className="mt-1 text-xs text-muted-foreground">{focused.address || focused.category} · {radiusLabel(radius)} straight-line band</p><div className="mt-3 flex flex-wrap gap-2 text-xs"><span className="rounded-md border bg-card px-2 py-1">{focusedBand?.shelterCount ?? 0} shelters</span><span className="rounded-md border bg-card px-2 py-1">{focusedBand?.mediaUnitCounts.digitalTopPanels ?? 0} digital top panels</span><span className="rounded-md border bg-card px-2 py-1">{focusedBand?.mediaUnitCounts.digitalMupis ?? 0} digital MUPIs</span><span className="rounded-md border bg-card px-2 py-1">{focusedBand?.mediaUnitCounts.static ?? 0} static units</span></div>
      {nearby.length ? <div className="mt-3 max-h-56 space-y-1 overflow-y-auto">{nearby.map(s => <div key={s.shelterId} className="flex justify-between gap-3 border-t border-border/60 py-2 text-xs"><span className="min-w-0"><strong>{s.assetCode}</strong> <span className="text-muted-foreground">{s.assetName}</span><span className="block break-all text-[10px] text-muted-foreground">ID {s.shelterId}</span></span><strong className="shrink-0 tabular-nums">{Math.round(s.distanceMeters)} m</strong></div>)}</div> : <p className="mt-3 text-xs text-muted-foreground">No matching shelters in this band.</p>}
    </div>}
    {coverage.limitations.length > 0 && <div className="border-t px-5 py-3 text-xs leading-5 text-muted-foreground">{coverage.limitations.join(" · ")}</div>}
  </section>;
}