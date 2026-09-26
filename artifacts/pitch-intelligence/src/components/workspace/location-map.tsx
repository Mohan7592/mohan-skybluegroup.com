import { Fragment, useEffect, useMemo, useState } from "react";
import { Circle, CircleMarker, MapContainer, Popup, TileLayer, useMap } from "react-leaflet";
import type { InventoryAsset, LocationRecommendation, ProjectInventorySelection, ProjectLocation } from "@workspace/api-client-react";
import { activeKinds, clientProximity, shelterMapLayers, validCoordinates, type PlanningLayer, type ShelterKind } from "@/lib/shelter-network";
import "leaflet/dist/leaflet.css";

export type LocationLayer = "CLIENT_APPROVED" | "CLIENT_CANDIDATE" | "COMPETITOR" | "POI" | ShelterKind | "recommended" | "shortlisted" | "selected" | "rejected";
export const locationLayers: { key: LocationLayer; label: string; color: string }[] = [
  { key: "CLIENT_APPROVED", label: "Approved client", color: "#1d4ed8" },
  { key: "CLIENT_CANDIDATE", label: "Client candidates", color: "#df7b18" },
  { key: "COMPETITOR", label: "Competitor", color: "#e05b47" },
  { key: "POI", label: "POI", color: "#b78b38" },
  { key: "shelters", label: "Standard Shelter", color: "#5797cc" },
  { key: "digitalShelters", label: "Digital Bus Shelter", color: "#087d90" },
  { key: "staticMupis", label: "Static MUPI", color: "#9974ae" },
  { key: "digitalMupis", label: "Digital MUPI", color: "#6347a3" },
  { key: "recommended", label: "Recommended", color: "#087f73" },
  { key: "shortlisted", label: "Shortlisted", color: "#d39a25" },
  { key: "selected", label: "Selected", color: "#2563eb" },
  { key: "rejected", label: "Rejected", color: "#be6259" },
];
export function validPosition(lat: number | null | undefined, lng: number | null | undefined): lat is number {
  return validCoordinates(lat, lng);
}
function FitMap({ points, focus }: { points: [number, number][]; focus: [number, number] | null }) {
  const map = useMap();
  const key = points.map(p => p.join(",")).join(";");
  useEffect(() => {
    if (focus) map.setView(focus, 15, { animate: true });
    else if (points.length) map.fitBounds(points, { padding: [42, 42], maxZoom: 13 });
    else map.setView([25.2048, 55.2708], 11);
    const timer = setTimeout(() => map.invalidateSize(), 80);
    return () => clearTimeout(timer);
  }, [map, key, focus?.[0], focus?.[1]]);
  return null;
}
const kindColor = (kind: LocationLayer) => locationLayers.find(x => x.key === kind)?.color || "#5797cc";
const kindLabel = (kind: ShelterKind) => locationLayers.find(x => x.key === kind)?.label || kind;
export function LocationMap({ locations, assets, proximityAssets, recommendations, selections, visible, focusedLocation, radius, mode, onInspect, onLocation }: {
  locations: ProjectLocation[];
  assets: InventoryAsset[];
  proximityAssets: InventoryAsset[];
  recommendations: LocationRecommendation[];
  selections: ProjectInventorySelection[];
  visible: Set<LocationLayer>;
  focusedLocation: ProjectLocation | null;
  radius: number;
  mode: "NETWORK" | "PROXIMITY";
  onInspect: (id: string) => void;
  onLocation: (id: string) => void;
}) {
  const [tileError, setTileError] = useState(false);
  const proximity = useMemo(() => focusedLocation ? clientProximity(focusedLocation, proximityAssets) : null, [focusedLocation, proximityAssets]);
  const recsByAsset = useMemo(() => {
    const map = new Map<string, LocationRecommendation[]>();
    recommendations.forEach(rec => { if (rec.inventoryAssetId) map.set(rec.inventoryAssetId, [...(map.get(rec.inventoryAssetId) || []), rec]); });
    return map;
  }, [recommendations]);
  const selectionByAsset = useMemo(() => {
    const map = new Map<string, ProjectInventorySelection[]>();
    selections.forEach(selection => map.set(selection.inventoryAssetId, [...(map.get(selection.inventoryAssetId) || []), selection]));
    return map;
  }, [selections]);
  const mappedLocations = locations.filter(l => l.reviewStatus !== "REJECTED" && visible.has(l.role === "CLIENT" ? l.reviewStatus === "APPROVED" ? "CLIENT_APPROVED" : "CLIENT_CANDIDATE" : l.role) && validCoordinates(l.latitude, l.longitude));
  const mappedAssets = assets.flatMap(asset => {
    const recs = recsByAsset.get(asset.id) || [];
    const saved = selectionByAsset.get(asset.id) || [];
    const planning: PlanningLayer[] = [
      ...saved.map(s => s.status === "selected" ? "selected" as const : s.status === "shortlist" ? "shortlisted" as const : "rejected" as const),
      ...recs.map(r => r.decision === "SHORTLISTED" ? "shortlisted" as const : r.decision === "REJECTED" ? "rejected" as const : "recommended" as const),
    ];
    const layers = shelterMapLayers(asset, visible, planning);
    return layers ? [{ asset, layers, recs }] : [];
  });
  // Bounds follow the actual network, never an off-city client or a radius filter.
  const bounds = useMemo(() => {
    const dubai = mappedAssets.filter(({ asset }) => asset.latitude! >= 24.8 && asset.latitude! <= 25.5 && asset.longitude! >= 54.8 && asset.longitude! <= 55.8);
    return (dubai.length ? dubai : mappedAssets).map(({ asset }) => [asset.latitude!, asset.longitude!] as [number, number]);
  }, [assets, visible, recsByAsset, selectionByAsset]);
  const focus = focusedLocation && validCoordinates(focusedLocation.latitude, focusedLocation.longitude) ? [focusedLocation.latitude!, focusedLocation.longitude!] as [number, number] : null;
  return <div className="relative h-full min-h-[330px] w-full bg-sky-50 dark:bg-slate-900">
    <MapContainer center={[25.2048, 55.2708]} zoom={11} className="h-full w-full" scrollWheelZoom={false}>
      <TileLayer url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>' eventHandlers={{ tileerror: () => setTileError(true), tileload: () => setTileError(false) }} />
      <FitMap points={bounds} focus={focus} />
      {mode === "PROXIMITY" && proximity && focus && <Circle center={focus} radius={radius} pathOptions={{ color: "#b78b38", weight: 1.5, fillOpacity: .06 }} />}
      {mappedAssets.map(({ asset, layers, recs }) => {
        const kinds = activeKinds(asset);
        const distance = proximity?.distances.get(asset.id);
        const dim = mode === "PROXIMITY" && proximity && (distance === undefined || distance > radius);
        const opacity = dim ? .3 : 1;
        const status = layers.overlays.find(layer => layer === "selected") || layers.overlays.find(layer => layer === "shortlisted") || layers.overlays[0];
        const center: [number, number] = [asset.latitude!, asset.longitude!];
        return <Fragment key={asset.id}>
          {layers.formats.map((kind, index) => <CircleMarker key={kind} center={center} radius={8 + (layers.formats.length - index - 1) * 4} interactive={false} pathOptions={{ color: kindColor(kind), weight: 3, opacity, fillOpacity: 0 }} />)}
          {status && <CircleMarker center={center} radius={12 + layers.formats.length * 4} interactive={false} pathOptions={{ color: kindColor(status), weight: 2.5, opacity, fillOpacity: 0, dashArray: "4 3" }} />}
          <CircleMarker center={center} radius={5} pathOptions={{ color: "#e6f5ff", weight: 1.5, fillColor: "#5797cc", fillOpacity: dim ? .32 : 1, opacity }}>
            <Popup><div className="min-w-[220px] text-slate-800"><strong>Shelter {asset.shelterNumber || asset.assetCode}</strong><div>{asset.area || "Area not supplied"} · {asset.stopName || "Stop name not supplied"}</div><div>{asset.shelterConfiguration || "Configuration not supplied"} · {kinds.filter(k => k === "shelters" || k === "digitalShelters").map(kindLabel).join(" / ") || "MUPI shelter"}</div><div className="mt-2 text-xs font-medium">{kinds.map(kindLabel).join(" · ")}</div><div className="mt-1 text-xs">Active units: {asset.mediaUnits?.filter(u => u.lifecycleStatus === "ACTIVE").map(u => `${u.format} ${u.unitType.replaceAll("_", " ")}`).join(", ")}</div>{focusedLocation && distance !== undefined && <div className="mt-2 border-t pt-2 text-xs">{Math.round(distance)} m straight-line from {focusedLocation.name}</div>}<div className="mt-1 text-xs">Planning: {status || "Not selected"}. Solid rings indicate enabled active formats; dashed ring indicates planning status. No availability or reach claim.</div>{recs.map(rec => <button key={rec.id} type="button" data-testid={`button-map-inspect-recommendation-${rec.id}`} className="mt-2 block text-xs font-semibold text-blue-700 underline" onClick={() => onInspect(rec.id)}>Inspect {rec.unitType?.replaceAll("_", " ") || "recommendation"}</button>)}</div></Popup>
          </CircleMarker>
        </Fragment>;
      })}
      {mappedLocations.map(location => {
        const metrics = clientProximity(location, proximityAssets);
        const geographyStatus = (location as ProjectLocation & { campaignGeographyStatus?: string | null }).campaignGeographyStatus;
        return <CircleMarker key={location.id} center={[location.latitude!, location.longitude!]} radius={focusedLocation?.id === location.id ? 12 : location.role === "CLIENT" ? 9 : 7} pathOptions={{ color: "#fff", weight: 3, fillColor: kindColor(location.role === "CLIENT" ? location.reviewStatus === "APPROVED" ? "CLIENT_APPROVED" : "CLIENT_CANDIDATE" : location.role), fillOpacity: 1 }} eventHandlers={{ click: () => onLocation(location.id) }}>
          <Popup><div className="min-w-[220px] text-slate-800"><strong>{location.name}</strong><div className="text-xs">{location.locationType?.replaceAll("_", " ") || location.category} · {location.reviewStatus}</div><div className="text-xs">Source: {location.provider || "User supplied"} · {location.evidenceStatus.replaceAll("_", " ")}</div>{geographyStatus === "OUTSIDE_CAMPAIGN_GEOGRAPHY" && <div className="mt-2 text-xs font-semibold text-amber-700">Outside campaign geography · excluded from proximity and approved coverage.</div>}{geographyStatus !== "IN_CAMPAIGN_GEOGRAPHY" && geographyStatus !== "OUTSIDE_CAMPAIGN_GEOGRAPHY" && <div className="mt-2 text-xs font-semibold text-amber-700">Campaign geography unverified · proximity withheld.</div>}{metrics && <div className="mt-2 border-t pt-2 text-xs">{metrics.preview && <strong className="block text-amber-700">Candidate preview · not approved coverage</strong>}<div>Nearest: {metrics.nearest ? `Shelter ${metrics.nearest.shelter.shelterNumber || metrics.nearest.shelter.assetCode} · ${Math.round(metrics.nearest.distance)} m` : "No active shelters"}</div><div>Unique shelters: 200 m {metrics.counts[200]} · 500 m {metrics.counts[500]} · 800 m {metrics.counts[800]} · 1 km {metrics.counts[1000]}</div></div>}<button type="button" data-testid={`button-map-focus-location-${location.id}`} className="mt-2 font-semibold text-blue-700 underline" onClick={() => onLocation(location.id)}>Focus location</button></div></Popup>
        </CircleMarker>;
      })}
    </MapContainer>
    {tileError && <div role="status" className="pointer-events-none absolute left-3 top-3 z-[400] rounded-md border bg-card/95 px-3 py-2 text-xs">Street tiles unavailable. Network coordinates remain visible.</div>}
    {!bounds.length && <div role="status" className="pointer-events-none absolute left-3 top-3 z-[400] rounded-md border bg-card/95 px-3 py-2 text-xs">No active shelters in the enabled format or planning layers.</div>}
  </div>;
}