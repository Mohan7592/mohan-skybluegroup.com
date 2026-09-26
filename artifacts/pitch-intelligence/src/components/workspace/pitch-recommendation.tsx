import { useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, ArrowUpRight, AlertCircle, Map, Database, Image, Presentation, Search, CheckCircle2, Pencil } from "lucide-react";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { ResearchStatusBanner } from "@/components/research-status";
import {
  getGetProjectIntelligenceQueryKey, getListProjectResearchRunsQueryKey,
  getGetProjectQueryKey, getGetProjectWorkspaceQueryKey, getGetNetworkRecommendationsQueryKey,
  getListProjectLocationsQueryKey, getGetStoreCoverageQueryKey,
  getGetProjectBusPlanQueryKey, getGetProjectMediaPlanQueryKey,
  useGetProjectIntelligence, useGetStoreCoverage, useGetNetworkRecommendations,
  useListProjectResearchRuns, useStartDeepResearch, useUpdateProject,
  type ProjectWorkspace, type IntelligenceClaim, type ResearchRunDetails, type CampaignIntelligence,
  type PitchProject
} from "@workspace/api-client-react";

const objectives = ["Store / Branch Footfall", "Product Launch", "Brand Awareness", "Seasonal Campaign", "Specific Area Coverage", "Competitor Response", "General OOH Proposal"] as const;
const campaignGeographies = ["DUBAI", "ABU_DHABI", "UAE", "CUSTOM"] as const;
type CampaignGeography = typeof campaignGeographies[number];
type CampaignGeographyInput = { campaignGeography: CampaignGeography; campaignAreas: string[] };
type GeographyProject = PitchProject & Partial<CampaignGeographyInput>;
const geographyLabel = (geography: CampaignGeography | undefined, areas: string[] | undefined) =>
  geography === "CUSTOM" ? (areas?.join(", ") || "Custom areas") : ({ DUBAI: "Dubai", ABU_DHABI: "Abu Dhabi", UAE: "UAE" } as const)[geography || "DUBAI"];
const parseCampaignAreas = (value: string) => [...new Set(value.split(/[,\n]/).map(area => area.trim()).filter(Boolean))];
const briefSchema = z.object({
  pitchObjective: z.enum(objectives, { required_error: "Choose a pitch objective" }),
  preferredMedia: z.enum(["bus", "bus_shelter", "both"]),
  targetQuantity: z.string().refine(value => value === "" || (/^[1-9]\d*$/.test(value) && Number(value) <= 1000), "Enter a whole number from 1 to 1000"),
  campaignGeography: z.enum(campaignGeographies),
  campaignAreas: z.string().max(1000)
}).superRefine((value, context) => {
  if (value.campaignGeography === "CUSTOM") {
    const areas = parseCampaignAreas(value.campaignAreas);
    if (!areas.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ["campaignAreas"], message: "Add at least one campaign area" });
    areas.forEach(area => {
      if (area.length < 2 || area.length > 80) context.addIssue({ code: z.ZodIssueCode.custom, path: ["campaignAreas"], message: "Each area must be between 2 and 80 characters" });
    });
  }
});
type BriefValues = z.infer<typeof briefSchema>;

function EditBriefDialog({ project, onClose }: { project: PitchProject; onClose: () => void }) {
  const geographyProject = project as GeographyProject;
  const client = useQueryClient();
  const update = useUpdateProject();
  const form = useForm<BriefValues>({
    resolver: zodResolver(briefSchema),
    defaultValues: {
      pitchObjective: objectives.find(objective => objective === project.pitchObjective),
      preferredMedia: project.preferredMedia ?? "both",
      targetQuantity: project.targetQuantity?.toString() ?? "",
      campaignGeography: geographyProject.campaignGeography || "DUBAI",
      campaignAreas: geographyProject.campaignAreas?.join(", ") || ""
    }
  });
  const save = (values: BriefValues) => {
    update.mutate({ id: project.id, data: {
      pitchObjective: values.pitchObjective,
      preferredMedia: values.preferredMedia,
      targetQuantity: values.targetQuantity ? Number(values.targetQuantity) : null,
      campaignGeography: values.campaignGeography,
      campaignAreas: values.campaignGeography === "CUSTOM" ? parseCampaignAreas(values.campaignAreas) : []
    } as Parameters<typeof update.mutate>[0]["data"] }, { onSuccess: saved => {
      client.setQueryData(getGetProjectQueryKey(project.id), saved);
      client.setQueryData<ProjectWorkspace>(getGetProjectWorkspaceQueryKey(project.id),
        current => current ? { ...current, project: saved } : current);
      void Promise.all([
        client.invalidateQueries({ queryKey: getGetProjectQueryKey(project.id) }),
        client.invalidateQueries({ queryKey: getGetProjectWorkspaceQueryKey(project.id) }),
        client.invalidateQueries({ queryKey: getGetNetworkRecommendationsQueryKey(project.id) }),
        client.invalidateQueries({ queryKey: getListProjectLocationsQueryKey(project.id) }),
        client.invalidateQueries({ queryKey: getGetStoreCoverageQueryKey(project.id) }),
        client.invalidateQueries({ queryKey: getGetProjectBusPlanQueryKey(project.id) }),
        client.invalidateQueries({ queryKey: getGetProjectMediaPlanQueryKey(project.id) }),
        client.invalidateQueries({ predicate: ({ queryKey }) =>
          queryKey.some(key => typeof key === "string" &&
            key.startsWith(`/api/projects/${project.id}/location-recommendations/`)) })
      ]);
      onClose();
    } });
  };
  return <Dialog open onOpenChange={open => { if (!open && !update.isPending) onClose(); }}>
    <DialogContent className="sm:max-w-md max-h-[90dvh] overflow-y-auto">
      <DialogHeader><DialogTitle>Edit pitch brief</DialogTitle><DialogDescription>Define what the pitch is trying to do. Changing quantity will refresh network planning.</DialogDescription></DialogHeader>
      <Form {...form}><form onSubmit={form.handleSubmit(save)} className="space-y-5 pt-2">
        <FormField control={form.control} name="pitchObjective" render={({ field }) => <FormItem>
          <FormLabel>Pitch objective</FormLabel>
          <FormControl><Select value={field.value} onValueChange={field.onChange}><SelectTrigger data-testid="select-edit-pitch-objective"><SelectValue placeholder="Choose one objective" /></SelectTrigger><SelectContent>{objectives.map(objective => <SelectItem key={objective} value={objective}>{objective}</SelectItem>)}</SelectContent></Select></FormControl>
          <FormMessage />
        </FormItem>} />
        <FormField control={form.control} name="preferredMedia" render={({ field }) => <FormItem>
          <FormLabel>Preferred media</FormLabel>
          <FormControl><Select value={field.value} onValueChange={field.onChange}><SelectTrigger data-testid="select-edit-preferred-media"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="bus">Bus</SelectItem><SelectItem value="bus_shelter">Bus shelter</SelectItem><SelectItem value="both">Both / explore options</SelectItem></SelectContent></Select></FormControl>
          <FormMessage />
        </FormItem>} />
        <FormField control={form.control} name="targetQuantity" render={({ field }) => <FormItem>
          <FormLabel>Campaign quantity <span className="font-normal text-muted-foreground">(optional)</span></FormLabel>
          <FormControl><Input {...field} type="number" min={1} max={1000} step={1} placeholder="Leave open for planning" data-testid="input-edit-target-quantity" /></FormControl>
          <FormMessage />
        </FormItem>} />
        <FormField control={form.control} name="campaignGeography" render={({ field }) => <FormItem>
          <FormLabel>Campaign geography</FormLabel>
          <FormControl><Select value={field.value} onValueChange={field.onChange}><SelectTrigger data-testid="select-edit-campaign-geography"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="DUBAI">Dubai</SelectItem><SelectItem value="ABU_DHABI">Abu Dhabi</SelectItem><SelectItem value="UAE">UAE</SelectItem><SelectItem value="CUSTOM">Custom areas</SelectItem></SelectContent></Select></FormControl>
          <FormMessage />
        </FormItem>} />
        {form.watch("campaignGeography") === "CUSTOM" && <FormField control={form.control} name="campaignAreas" render={({ field }) => <FormItem>
          <FormLabel>Custom campaign areas</FormLabel>
          <FormControl><Textarea {...field} rows={3} placeholder="Separate areas with commas or new lines" data-testid="input-edit-campaign-areas" /></FormControl>
          <FormMessage />
        </FormItem>} />}
        {update.isError && <p role="alert" className="text-sm text-destructive">Brief could not be saved. Please try again.</p>}
        <DialogFooter><Button type="button" variant="outline" disabled={update.isPending} onClick={onClose}>Cancel</Button><Button type="submit" disabled={update.isPending} data-testid="button-save-pitch-brief">{update.isPending ? "Saving..." : "Save brief"}</Button></DialogFooter>
      </form></Form>
    </DialogContent>
  </Dialog>;
}

const sourceDate = (date: string | null | undefined) => date ? new Date(date).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "Date not supplied";
const UAE_PLACES = /\b(?:uae|united arab emirates|dubai|abu dhabi|sharjah|ajman|umm al quwain|ras al khaimah|fujairah)\b/i;
const recentPublication = (date: string | null | undefined) => {
  if (!date) return false;
  const published = new Date(date);
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 6);
  return !Number.isNaN(published.getTime()) && published >= cutoff && published <= new Date();
};
const campaignSource = (campaign: CampaignIntelligence) =>
  [campaign.source, ...(campaign.sources ?? [])]
    .filter(source => source?.url && recentPublication(source.publishedAt))
    .sort((a, b) => (b?.publishedAt || "").localeCompare(a?.publishedAt || ""))[0];
const eligibleQuickRun = (run: ResearchRunDetails) =>
  (run.status === "completed" || run.status === "partial_success") &&
  ["live_research_v1", "live_research_pitch_v1"].includes(run.scope) &&
  !!run.confirmedBrand &&
  (run.status !== "partial_success" || run.stages.some(stage => stage.status === "limited_evidence")) &&
  ["company_research", "recent_marketing", "campaign_research", "ooh_research", "current_promotion", "source_validation"]
    .every(key => run.stages.some(stage => stage.key === key && stage.status !== "pending" && stage.status !== "running")) &&
  ["competitor_discovery", "competitor_research", "ai_synthesis", "strategy_generation"]
    .every(key => run.stages.some(stage => stage.key === key && stage.status === "pending"));

function Evidence({ claim }: { claim: IntelligenceClaim }) {
  return <div className="border-l-2 border-brand/40 pl-4 py-1" data-testid={`finding-${claim.id}`}>
    <p className="text-sm leading-relaxed text-slate-800 dark:text-slate-100">{claim.claim}</p>
    <a href={claim.source!.url!} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline break-all" data-testid={`link-finding-source-${claim.id}`}>
      {claim.source?.publisher || claim.source?.title || "View source"} · {sourceDate(claim.source?.publishedAt)} <ArrowUpRight className="h-3 w-3 shrink-0" />
    </a>
  </div>;
}

export function PitchRecommendation({ workspace }: { workspace: ProjectWorkspace }) {
  const id = workspace.project.id;
  const project = workspace.project;
  const [, navigate] = useLocation();
  const client = useQueryClient();
  const [reviewOpen, setReviewOpen] = useState(false);
  const [briefOpen, setBriefOpen] = useState(false);
  const intelligenceQuery = useGetProjectIntelligence(id, {
    query: { queryKey: getGetProjectIntelligenceQueryKey(id), refetchInterval: query =>
      ["researching", "awaiting_brand_confirmation", "awaiting_competitor_review"].includes(query.state.data?.status.state ?? "") ? 5000 : false }
  });
  const coverageQuery = useGetStoreCoverage(id);
  const networkQuery = useGetNetworkRecommendations(id);
  const runsQuery = useListProjectResearchRuns(id, { query: {
    queryKey: getListProjectResearchRunsQueryKey(id),
    refetchInterval: query => query.state.data?.some(run => run.status === "running" || run.status === "queued") ? 5000 : false
  } });
  const deepResearch = useStartDeepResearch();
  const intelligence = intelligenceQuery.data;
  const coverage = coverageQuery.data;
  const network = networkQuery.data;
  const claims = intelligence?.claims.filter(c => c.status === "approved" && !c.isDemo && !!c.source?.url) ?? [];
  const subject = (intelligence?.identity.canonicalBrandName || project.clientName).toLowerCase();
  const relevant = claims.filter(c =>
    !c.relatedCompetitorId && (!c.relatedBrand || c.relatedBrand.toLowerCase() === subject) &&
    /marketing|campaign|ooh|outdoor|promotion|advertis|media/i.test(c.category + " " + c.claim) &&
    UAE_PLACES.test(c.claim) && recentPublication(c.source?.publishedAt))
    .sort((a, b) => (b.source?.publishedAt || "").localeCompare(a.source?.publishedAt || ""));
  // Campaign geography/location is projected only when the backend has campaign-specific evidence.
  // The project's target market is not evidence of where a promotion ran.
  const promotion = intelligence?.campaigns.filter(c =>
    !c.isDemo &&
    (c.promotionClassification === "Confirmed Active" || c.promotionClassification === "Recently Active") &&
    !!campaignSource(c) && UAE_PLACES.test(`${c.geography ?? ""} ${c.location ?? ""}`) &&
    (!c.brandOrProduct || c.brandOrProduct.toLowerCase().includes(subject) || subject.includes(c.brandOrProduct.toLowerCase())))
    .sort((a, b) => (campaignSource(b)?.publishedAt || "").localeCompare(campaignSource(a)?.publishedAt || ""))[0];
  const promotionSource = promotion ? campaignSource(promotion) : undefined;
  const today = new Date().toISOString().slice(0, 10);
  const promotionCurrent = promotion?.promotionClassification === "Confirmed Active" && promotion.isCurrent &&
    !!promotion.startDate && !!promotion.endDate && promotion.startDate <= today && promotion.endDate >= today;
  const runs = [...(runsQuery.data ?? [])].sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  const completedQuickRun = runs.find(eligibleQuickRun);
  const deepAlreadyStarted = !!completedQuickRun && runs.some(run => run.scope.startsWith(`retry:${completedQuickRun.id}:competitor_discovery`));
  const canStartDeep = !!completedQuickRun && !deepAlreadyStarted && !deepResearch.isSuccess &&
    !runs.some(run => run.status === "queued" || run.status === "running");
  const band = coverage?.aggregate.bands["500"];
  const hasStores = !!coverage?.locations.length;
  const hasRoutes = !!network?.recommendations.length;
  const hasShelters = !!band?.uniqueShelterCount;
  const mediaDirection = hasRoutes && hasShelters ? "Bus routes and shelters both have planning evidence to review."
    : hasRoutes ? "Bus routes have planning evidence to review; shelter coverage is not established."
    : hasShelters ? "Shelter coverage near approved client locations has planning evidence; a bus route mix is not established."
    : "No supported media direction yet. Review mapped locations and inventory before proposing a format.";
  const limitations = [...new Set([...(coverage?.limitations ?? []), ...(network?.limitations ?? [])])];
  const actions = [
    { label: "View Map", detail: "Review places & coverage", tab: "locations", icon: Map },
    { label: "Review Assets", detail: "Inspect the inventory", tab: "inventory", icon: Database },
    { label: "Create Mockups", detail: "Open staged creative tab", tab: "mockups", icon: Image },
    { label: "Build Proposal", detail: "Open staged proposal tab", tab: "deck", icon: Presentation }
  ];

  return <div className="space-y-8 pb-16 animate-in fade-in duration-500">
    <section className="relative overflow-hidden rounded-2xl bg-slate-900 text-slate-50 p-6 md:p-9">
      <div className="absolute inset-0 pointer-events-none opacity-20" style={{ backgroundImage: "radial-gradient(circle at 90% 10%, #8ab5bf, transparent 35%), linear-gradient(145deg, transparent 52%, #8ab5bf 53%, transparent 54%)" }} />
      <div className="relative">
        <p className="text-xs font-semibold text-cyan-200 uppercase tracking-[0.2em] mb-5">Pitch recommendation / Brand Market: {project.market}</p>
        <h1 className="text-3xl md:text-5xl font-semibold tracking-tight leading-tight max-w-2xl">A direction for {intelligence?.identity.canonicalBrandName || project.clientName}.</h1>
        <div className="mt-6 flex flex-wrap gap-2 text-xs">
          <span className="rounded-full border border-slate-500 px-3 py-1.5">{project.pitchObjective || "Objective not specified"}</span>
          <span className="rounded-full border border-slate-500 px-3 py-1.5" data-testid="summary-campaign-geography">Campaign geography: {geographyLabel((project as GeographyProject).campaignGeography, (project as GeographyProject).campaignAreas)}</span>
          <span className="rounded-full border border-slate-500 px-3 py-1.5">Media preference: {project.preferredMedia === "bus_shelter" ? "Bus shelter" : project.preferredMedia === "bus" ? "Bus" : project.preferredMedia === "both" ? "Both" : "Not specified"}</span>
          {project.productFocus && <span className="rounded-full border border-slate-500 px-3 py-1.5">Focus: {project.productFocus}</span>}
        </div>
        <p className="text-slate-300 text-sm mt-5 max-w-2xl">A working pitch brief, grounded in reviewed evidence and current planning records. Confirm the facts before sharing externally.</p>
        {(!project.pitchObjective || !project.preferredMedia) && <p className="mt-4 rounded-lg border border-amber-300/40 bg-amber-200/10 px-3 py-2 text-sm text-amber-100 max-w-xl" role="status">This earlier pitch is missing an objective or media preference. Complete the brief before planning.</p>}
        <Button variant="outline" size="sm" onClick={() => setBriefOpen(true)} className="mt-5 border-slate-500 bg-transparent text-slate-50 hover:bg-slate-800 hover:text-slate-50" data-testid="button-edit-pitch-brief"><Pencil className="h-3.5 w-3.5 mr-2" />{!project.pitchObjective || !project.preferredMedia ? "Complete brief" : "Edit brief"}</Button>
      </div>
    </section>

    {intelligenceQuery.isLoading ? <div className="space-y-3" aria-label="Loading pitch evidence"><Skeleton className="h-20 w-full" /><Skeleton className="h-40 w-full" /></div>
      : intelligenceQuery.isError ? <div role="alert" className="rounded-xl border border-destructive/30 p-5 text-sm"><AlertCircle className="inline h-4 w-4 mr-2" />Research could not be loaded. <Button variant="link" onClick={() => intelligenceQuery.refetch()}>Retry</Button></div>
      : intelligence && <ResearchStatusBanner projectId={id} status={intelligence.status} />}

    <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.6fr)_minmax(280px,1fr)] gap-5">
      <section className="rounded-2xl border bg-slate-50/70 dark:bg-slate-950/40 p-5 md:p-7">
        <p className="text-xs uppercase tracking-[0.18em] font-semibold text-brand mb-3">01 / The case to make</p>
        <h2 className="text-2xl font-semibold tracking-tight mb-3">Lead with what is known.</h2>
        <p className="text-sm text-muted-foreground leading-relaxed mb-6">Recent client activity is context for the pitch, not a substitute for a media plan. Only approved findings with dated sources from the last six months and explicit UAE relevance appear below.</p>
        {relevant.length ? <div className="space-y-5">{relevant.slice(0, 3).map(claim => <Evidence key={claim.id} claim={claim} />)}</div>
           : <div className="rounded-xl border border-dashed p-5 text-sm text-muted-foreground">No approved marketing or OOH finding has both a source published in the last six months and explicit UAE relevance. Review research before making a claim.</div>}
        <Button variant="link" className="px-0 mt-4" onClick={() => navigate(`/projects/${id}/intelligence`)} data-testid="button-review-evidence">Review all evidence <ArrowRight className="h-4 w-4 ml-1" /></Button>
      </section>
      <section className="rounded-2xl border p-5 md:p-7">
        <p className="text-xs uppercase tracking-[0.18em] font-semibold text-brand mb-3">02 / Latest promotion</p>
        {promotion && promotionSource ? <>
          <p className="text-xs font-medium text-muted-foreground mb-2">{promotionCurrent ? "Confirmed active · current dated window" : "Historical promotion · current activity not verified"}</p>
          <h2 className="text-xl font-semibold leading-snug">{promotion.name}</h2>
          {promotion.message && <p className="text-sm mt-3 leading-relaxed">{promotion.message}</p>}
          <a href={promotionSource.url!} target="_blank" rel="noopener noreferrer" className="mt-5 inline-flex items-center gap-1 text-xs text-brand hover:underline" data-testid="link-promotion-source">Source · {sourceDate(promotionSource.publishedAt)} <ArrowUpRight className="h-3 w-3" /></a>
        </> : <p className="text-sm text-muted-foreground">No explicitly classified promotion has both a source published in the last six months and campaign-specific UAE geography. Check campaign research for updates; do not present an older campaign as current.</p>}
      </section>
    </div>

    <section>
      <div className="flex items-end justify-between gap-3 mb-4"><div><p className="text-xs uppercase tracking-[0.18em] font-semibold text-brand mb-2">03 / The network angle</p><h2 className="text-2xl font-semibold tracking-tight">Where this could show up</h2></div><span className="text-xs text-muted-foreground hidden sm:block">Planning evidence, not delivery estimates</span></div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="rounded-2xl border p-5 md:p-6 bg-slate-50/70 dark:bg-slate-950/40">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Approved store footprint / shelters</p>
          {coverageQuery.isLoading ? <Skeleton className="h-16 w-full mt-4" /> : coverageQuery.isError ? <p className="text-sm mt-4">Coverage unavailable. <Button variant="link" onClick={() => coverageQuery.refetch()}>Retry</Button></p> : hasStores ? <>
            <p className="text-3xl font-semibold mt-4">{coverage!.locations.length} <span className="text-sm font-normal text-muted-foreground">approved client locations</span></p>
            <p className="text-sm mt-2">{band?.locationsCoveredCount ?? 0} locations within 500m of {band?.uniqueShelterCount ?? 0} unique active shelters, straight-line distance.</p>
          </> : <p className="text-sm text-muted-foreground mt-4">No approved client locations to calculate store coverage. Approve locations on the map first.</p>}
        </div>
        <div className="rounded-2xl border p-5 md:p-6 bg-slate-50/70 dark:bg-slate-950/40">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Bus network opportunity</p>
          {networkQuery.isLoading ? <Skeleton className="h-16 w-full mt-4" /> : networkQuery.isError ? <p className="text-sm mt-4">Network planning unavailable. <Button variant="link" onClick={() => networkQuery.refetch()}>Retry</Button></p> : hasRoutes ? <>
            <p className="text-3xl font-semibold mt-4">{network!.recommendations.length} <span className="text-sm font-normal text-muted-foreground">suggested routes</span></p>
            <p className="text-sm mt-2">Proposed {network!.proposedTotal} buses against a planning target of {network!.targetBuses}{network!.shortfall > 0 ? `, with a ${network!.shortfall} bus shortfall` : ""}. Not an availability reservation.</p>
          </> : <p className="text-sm text-muted-foreground mt-4">No route recommendations yet. A bus direction cannot be supported from current planning data.</p>}
        </div>
      </div>
      <div className="mt-4 rounded-xl border-l-4 border-brand bg-brand/5 p-5"><p className="text-xs font-semibold uppercase tracking-wider text-brand mb-2">Media direction · working inference</p><p className="text-sm font-medium">{mediaDirection}</p><p className="text-xs text-muted-foreground mt-2">Preference: {project.preferredMedia || "not specified"}. Confirm suitability, availability, and pricing separately.</p></div>
    </section>

    <section className="rounded-2xl bg-slate-900 text-slate-50 p-6 md:p-8">
      <p className="text-xs uppercase tracking-[0.18em] text-cyan-200 font-semibold mb-2">Next / Make it tangible</p>
      <h2 className="text-2xl font-semibold mb-5">Move the pitch forward.</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">{actions.map(action => <button key={action.tab} type="button" onClick={() => navigate(`/projects/${id}/${action.tab}`)} data-testid={`button-${action.tab}-from-overview`} className="text-left rounded-xl border border-slate-600/70 p-4 hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200 transition-colors flex items-center gap-3">
        <action.icon className="h-5 w-5 text-cyan-200 shrink-0" /><span className="flex-1"><strong className="block text-sm">{action.label}</strong><small className="text-slate-400">{action.detail}</small></span><ArrowRight className="h-4 w-4 text-slate-400" />
      </button>)}</div>
      <p className="text-xs text-slate-400 mt-4">Mockups and proposal are staged workspaces. Opening them does not generate creative or a deck.</p>
    </section>

    <section className="grid grid-cols-1 lg:grid-cols-2 gap-5">
      <div className="rounded-2xl border p-5 md:p-6">
        <p className="text-xs uppercase tracking-[0.18em] font-semibold text-brand mb-2">Optional / Deep research</p>
        <h2 className="text-xl font-semibold mb-2">Go further only if the pitch needs it.</h2>
        <p className="text-sm text-muted-foreground mb-4">Competitors, campaigns and strategy are a separate research pass. Review the quick findings and brand identity first; additional research may still need human approval.</p>
        {runsQuery.isLoading ? <Skeleton className="h-9 w-48" /> : runsQuery.isError ? <Button variant="outline" onClick={() => runsQuery.refetch()}>Retry research runs</Button> : <Button variant="outline" disabled={!canStartDeep || deepResearch.isPending} onClick={() => setReviewOpen(true)} data-testid="button-open-deep-research"><Search className="h-4 w-4 mr-2" />{deepResearch.isSuccess ? "Deep research started" : "Start deep research"}</Button>}
        {!canStartDeep && !deepResearch.isSuccess && !runsQuery.isLoading && !runsQuery.isError && <p className="text-xs text-muted-foreground mt-2">Available when the latest quick run is complete or partially successful and competitor discovery is ready. Check the Research workflow for any review gates.</p>}
        {deepResearch.isError && <p role="alert" className="text-sm text-destructive mt-3">Could not start deep research. Review the quick run and try again.</p>}
        {deepResearch.isSuccess && <p role="status" className="text-sm mt-3"><CheckCircle2 className="inline h-4 w-4 mr-1 text-brand" />Deep research started. Check the research tabs for progress.</p>}
      </div>
      <div className="rounded-2xl border border-amber-200/70 bg-amber-50/50 dark:bg-amber-950/10 dark:border-amber-900/50 p-5 md:p-6">
        <p className="text-xs uppercase tracking-[0.18em] font-semibold text-amber-700 dark:text-amber-400 mb-2">Before presenting / Limitations</p>
        <ul className="text-sm space-y-2 list-disc pl-5 text-slate-700 dark:text-slate-300">
          <li>No audience, reach, impressions or footfall can be inferred from these planning records.</li>
          <li>Coverage is straight-line proximity, not proof of visibility or visitation.</li>
          {limitations.slice(0, 3).map((item, i) => <li key={i}>{item}</li>)}
          {!coverage && <li>Store coverage has not been confirmed for this pitch.</li>}
          {!network && <li>Route-level opportunity has not been confirmed for this pitch.</li>}
        </ul>
      </div>
    </section>

    {briefOpen && <EditBriefDialog project={project} onClose={() => setBriefOpen(false)} />}
    <Dialog open={reviewOpen} onOpenChange={setReviewOpen}><DialogContent>
       <DialogHeader><DialogTitle>Review before deep research</DialogTitle><DialogDescription>Start an optional competitor and strategy pass from the latest completed or partially successful quick run. This will not make findings automatically approved.</DialogDescription></DialogHeader>
      <div className="rounded-lg border p-4 text-sm space-y-2">
        <p><strong>Client:</strong> {intelligence?.identity.canonicalBrandName || project.clientName}</p>
         <p><strong>Quick run:</strong> {completedQuickRun?.status?.replace("_", " ") || "Not ready"} · {completedQuickRun?.completedAt ? sourceDate(completedQuickRun.completedAt) : sourceDate(completedQuickRun?.requestedAt)}</p>
        <p><strong>Review gate:</strong> Check brand identity, sources and limitations in Intelligence before using findings in the proposal.</p>
      </div>
      <DialogFooter><Button variant="outline" onClick={() => setReviewOpen(false)}>Cancel</Button><Button disabled={!canStartDeep || deepResearch.isPending} onClick={() => { if (!completedQuickRun) return; deepResearch.mutate({ id, runId: completedQuickRun.id }, { onSuccess: () => { setReviewOpen(false); client.invalidateQueries({ queryKey: getListProjectResearchRunsQueryKey(id) }); client.invalidateQueries({ queryKey: getGetProjectIntelligenceQueryKey(id) }); } }); }} data-testid="button-confirm-deep-research">{deepResearch.isPending ? "Starting..." : "Start deep research"}</Button></DialogFooter>
    </DialogContent></Dialog>
  </div>;
}