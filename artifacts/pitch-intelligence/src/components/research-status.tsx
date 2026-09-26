import { RefreshCw, Clock, AlertCircle, CheckCircle2, XCircle, Globe, Search, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { format } from "date-fns";
import { 
  ResearchStatus, 
  useRefreshProjectResearch, 
  useGetProjectResearchRun, 
  getGetProjectResearchRunQueryKey, 
  useConfirmResearchBrand, 
  useConfirmResearchCompetitors, 
  useRetryResearchStages, 
  useListProjectResearchRuns,
  getGetProjectIntelligenceQueryKey,
  getListProjectResearchRunsQueryKey,
  getGetProjectQueryKey,
  getGetProjectWorkspaceQueryKey,
  getGetDashboardQueryKey,
  getListProjectsQueryKey,
  BrandCandidate,
  CompetitorCandidate,
  ResearchStage,
  QualityProjection,
  ResearchRunDetailsCoverageSnapshotStatus
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

export function ResearchStatusBanner({ projectId, status }: { projectId: string, status: ResearchStatus }) {
  const refresh = useRefreshProjectResearch();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  const { data: currentRun } = useGetProjectResearchRun(projectId, status.currentRunId || "", {
    query: {
      enabled: !!status.currentRunId,
      queryKey: getGetProjectResearchRunQueryKey(projectId, status.currentRunId || ""),
      refetchInterval: (query) => {
        const run = query.state.data;
        if (!run) return 2000;
        if (['queued', 'running', 'awaiting_brand_confirmation', 'awaiting_competitor_review'].includes(run.status)) return 2000;
        return false;
      }
    }
  });
  const { data: runs } = useListProjectResearchRuns(projectId, {
    query: { enabled: !!projectId, queryKey: getListProjectResearchRunsQueryKey(projectId) }
  });
  const latestRunRequestedAt = runs?.reduce<string | undefined>((latest, run) =>
    !latest || new Date(run.requestedAt).getTime() > new Date(latest).getTime() ? run.requestedAt : latest,
  undefined);
  const lastAttemptedAt = (status as ResearchStatus & { lastAttemptedAt?: string | null }).lastAttemptedAt
    || latestRunRequestedAt
    || currentRun?.requestedAt;

  useEffect(() => {
    if (currentRun && ['completed', 'failed', 'partial_success'].includes(currentRun.status)) {
      queryClient.invalidateQueries({ queryKey: getGetProjectIntelligenceQueryKey(projectId) });
      queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
    }
  }, [currentRun?.status, projectId, queryClient]);

  const getStateLabel = (state: string) => {
    switch (state) {
      case 'research_not_started': return 'Not Started';
      case 'researching': return 'In Progress';
      case 'research_complete': return 'Complete';
      case 'needs_review': return 'Needs Review';
      case 'update_available': return 'Update Available';
      case 'awaiting_brand_confirmation': return 'Confirm Brand';
      case 'awaiting_competitor_review': return 'Review Competitors';
      case 'partial_success': return 'Partial Success';
      case 'queued': return 'Queued';
      case 'running': return 'Running';
      case 'failed': return 'Failed';
      case 'completed': return 'Completed';
      default: return state.replace(/_/g, ' ');
    }
  };

  const isResearching = status.state === 'researching' || (currentRun && ['queued', 'running'].includes(currentRun.status));
  const displayStatus = currentRun ? currentRun.status : status.state;

  return (
    <div className="bg-white dark:bg-slate-900 border rounded-lg p-4 flex flex-col mb-6 shadow-sm">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium">Research Status:</span>
            <Badge variant="secondary" className="capitalize">
              {getStateLabel(displayStatus)}
            </Badge>
            <RunHistory projectId={projectId} />
          </div>
          <div className="flex flex-col gap-1 text-xs text-muted-foreground">
            <div className="flex items-center gap-1.5">
              <Clock className="h-3 w-3" />
              <span>Last attempted: {lastAttemptedAt ? format(new Date(lastAttemptedAt), 'MMM d, yyyy h:mm a') : 'Never'}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <CheckCircle2 className="h-3 w-3" />
              <span>Last successfully researched: {status.lastResearched ? format(new Date(status.lastResearched), 'MMM d, yyyy h:mm a') : 'Never'}</span>
            </div>
          </div>
        </div>
        
        <div className="flex flex-wrap items-center gap-3 w-full sm:w-auto min-w-0">
          {!status.liveResearchAvailable && (
            <div className="text-xs text-muted-foreground flex items-center gap-1.5 bg-slate-50 dark:bg-slate-950 px-2.5 py-1.5 rounded-md border min-w-0">
              <AlertCircle className="h-3 w-3 text-amber-500 shrink-0" />
              <span>Live research provider not connected</span>
            </div>
          )}
          <Button 
            variant={status.state === 'research_not_started' ? 'default' : 'outline'}
            size="sm" 
            disabled={!status.liveResearchAvailable || isResearching || refresh.isPending}
            onClick={() => {
              refresh.mutate({ id: projectId }, {
                onSuccess: (newRun) => {
                  toast({ title: "Research run started" });
                  queryClient.invalidateQueries({ queryKey: getGetProjectIntelligenceQueryKey(projectId) });
                  queryClient.invalidateQueries({ queryKey: getListProjectResearchRunsQueryKey(projectId) });
                  if (newRun?.id) {
                    queryClient.invalidateQueries({ queryKey: getGetProjectResearchRunQueryKey(projectId, newRun.id) });
                  }
                }
              });
            }}
            className="w-full sm:w-auto"
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${(refresh.isPending || isResearching) ? 'animate-spin' : ''}`} />
            {status.state === 'research_not_started' ? 'Start Research' : 'Refresh Research'}
          </Button>
        </div>
      </div>
      
      {currentRun && (
        <>
          <RunProgress stages={currentRun.stages} />
          <BrandResolutionFailure run={currentRun} />
          {currentRun.status === 'awaiting_brand_confirmation' && (
            <BrandConfirmationPanel projectId={projectId} runId={currentRun.id} enteredName={currentRun.brand} candidates={currentRun.brandCandidates} />
          )}
          {currentRun.status === 'awaiting_competitor_review' && (
            <CompetitorReviewPanel projectId={projectId} runId={currentRun.id} candidates={currentRun.competitorCandidates} />
          )}
          {(currentRun.status === 'failed' || currentRun.status === 'partial_success') && (
            <RetryPanel projectId={projectId} runId={currentRun.id} stages={currentRun.stages} />
          )}
        </>
      )}
    </div>
  );
}

function BrandResolutionFailure({ run }: { run: { status: string; brand: string | null; confirmedBrand: BrandCandidate | null; stages: ResearchStage[]; errorMessage: string | null } }) {
  const brandStage = run.stages.find((stage) => stage.key === "brand_resolution");
  const failed = brandStage?.status === "failed" || (run.status === "failed" && !run.confirmedBrand);
  if (!failed) return null;
  const reason = run.errorMessage || brandStage?.note || "The brand could not be resolved to a verified official identity.";
  return (
    <div className="mt-3 flex items-start gap-2 rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive" role="alert" data-testid="status-brand-resolution-failure">
      <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
      <span><strong>Brand Resolution failed:</strong> {reason}</span>
    </div>
  );
}

function RunProgress({ stages }: { stages: ResearchStage[] }) {
  if (!stages || stages.length === 0) return null;

  const formatStageName = (key: string) => {
    return key.split('_').map(word => {
      const lower = word.toLowerCase();
      if (lower === 'ooh') return 'OOH';
      if (lower === 'ai') return 'AI';
      if (lower === 'dooh') return 'DOOH';
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    }).join(' ');
  };

  return (
    <div className="flex flex-wrap gap-2 mt-4 pt-4 border-t border-slate-100 dark:border-slate-800">
      {stages.map(stage => (
        <div key={stage.key} className="flex items-center gap-1.5 text-[11px] font-medium bg-slate-50 dark:bg-slate-800/50 border px-2 py-1 rounded-md text-slate-600 dark:text-slate-300">
          {stage.status === 'complete' ? <CheckCircle2 className="h-3 w-3 text-emerald-500" /> :
           stage.status === 'running' ? <RefreshCw className="h-3 w-3 text-brand animate-spin" /> :
           stage.status === 'failed' ? <XCircle className="h-3 w-3 text-destructive" /> :
           stage.status === 'limited_evidence' ? <AlertCircle className="h-3 w-3 text-amber-500" /> :
           <Clock className="h-3 w-3 opacity-50" />}
          <span>{formatStageName(stage.key)}</span>
        </div>
      ))}
    </div>
  )
}

function BrandConfirmationPanel({ projectId, runId, enteredName, candidates }: { projectId: string, runId: string, enteredName: string | null, candidates: BrandCandidate[] }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const confirm = useConfirmResearchBrand();
  
  const handleConfirm = (website: string) => {
    if (!website) return;
    confirm.mutate({ id: projectId, runId, data: { website } }, {
      onSuccess: () => {
        toast({ title: "Brand confirmed", description: "Research will continue." });
        queryClient.invalidateQueries({ queryKey: getGetProjectIntelligenceQueryKey(projectId) });
        queryClient.invalidateQueries({ queryKey: getListProjectResearchRunsQueryKey(projectId) });
        queryClient.invalidateQueries({ queryKey: getGetProjectResearchRunQueryKey(projectId, runId) });
        queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) });
        queryClient.invalidateQueries({ queryKey: getGetProjectWorkspaceQueryKey(projectId) });
        queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
      },
      onError: () => {
        toast({ title: "Failed to confirm brand", variant: "destructive" });
      }
    });
  }

  return (
    <div className="mt-4 p-4 border rounded-lg bg-slate-50/50 dark:bg-slate-900/50">
      <h4 className="font-semibold text-sm mb-3 text-foreground">Confirm Brand Resolution</h4>
      <p className="text-xs text-muted-foreground mb-4">
        {enteredName
          ? `You entered “${enteredName}”. Confirm a suggested official identity to continue; your entered name will not be changed without confirmation.`
          : "Confirm the correct official identity to continue research."}
      </p>
      
      <div className="space-y-2 mb-4">
        {candidates.map((c, i) => (
          <div key={i} className="flex items-center justify-between p-3 bg-white dark:bg-slate-950 border rounded-md shadow-sm">
            <div className="min-w-0 pr-4">
              <p className="text-xs text-muted-foreground">Official candidate</p>
              <p className="text-sm font-medium truncate">{c.name}</p>
              <a href={c.website} target="_blank" rel="noreferrer" className="text-xs text-brand hover:underline flex items-center mt-0.5 truncate">
                <Globe className="h-3 w-3 mr-1 shrink-0" />
                {c.website}
              </a>
              {c.sourceUrl && (
                <a href={c.sourceUrl} target="_blank" rel="noreferrer" className="text-xs text-brand hover:underline mt-1 inline-block">
                  View cited brand page
                </a>
              )}
              {c.evidenceQuote && <p className="text-xs text-muted-foreground mt-1">“{c.evidenceQuote}”</p>}
            </div>
            <Button size="sm" variant="outline" onClick={() => handleConfirm(c.website)} disabled={confirm.isPending} className="shrink-0">
              {`Did you mean ${c.name}?`}
            </Button>
          </div>
        ))}
      </div>
    </div>
  )
}

function CompetitorReviewPanel({ projectId, runId, candidates }: { projectId: string, runId: string, candidates: CompetitorCandidate[] }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string[]>(
    candidates.filter(c => c.selected).map(c => c.name)
  );
  const [newName, setNewName] = useState("");
  const confirm = useConfirmResearchCompetitors();

  const toggle = (name: string) => {
    setSelected(prev => prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name]);
  };

  const handleAdd = () => {
    if (newName.trim() && !selected.includes(newName.trim())) {
      setSelected(prev => [...prev, newName.trim()]);
      setNewName("");
    }
  };

  const handleConfirm = () => {
    confirm.mutate({ id: projectId, runId, data: { names: selected } }, {
      onSuccess: () => {
        toast({ title: "Competitors confirmed", description: "Research will proceed with these competitors." });
        queryClient.invalidateQueries({ queryKey: getGetProjectIntelligenceQueryKey(projectId) });
        queryClient.invalidateQueries({ queryKey: getListProjectResearchRunsQueryKey(projectId) });
        queryClient.invalidateQueries({ queryKey: getGetProjectResearchRunQueryKey(projectId, runId) });
      },
      onError: () => {
        toast({ title: "Failed to confirm competitors", variant: "destructive" });
      }
    });
  };

  return (
    <div className="mt-4 p-4 border rounded-lg bg-slate-50/50 dark:bg-slate-900/50">
      <div className="flex justify-between items-start mb-3">
        <div>
          <h4 className="font-semibold text-sm text-foreground">Review Competitors</h4>
          <p className="text-xs text-muted-foreground mt-0.5">We identified these competitors. Add or remove them before continuing.</p>
        </div>
        <Button size="sm" onClick={handleConfirm} disabled={confirm.isPending || selected.length === 0}>
          Continue ({selected.length})
        </Button>
      </div>
      
      <div className="flex flex-wrap gap-2 mb-4 p-3 bg-white dark:bg-slate-950 border rounded-md min-h-[60px]">
        {selected.length === 0 && <span className="text-xs text-muted-foreground italic flex items-center h-6">No competitors selected</span>}
        {selected.map(name => (
          <Badge key={name} variant="default" className="flex items-center gap-1.5 py-1 px-2.5 text-xs">
            {name}
            <button onClick={() => toggle(name)} className="hover:text-red-200 focus:outline-none transition-colors">
              <XCircle className="h-3 w-3" />
            </button>
          </Badge>
        ))}
      </div>
      
      <div className="mb-4">
        <label className="text-xs font-medium mb-2 block text-muted-foreground">Suggested to add:</label>
        <div className="flex flex-wrap gap-2">
          {candidates.filter(c => !selected.includes(c.name)).map(c => (
            <Badge key={c.name} variant="outline" className="flex items-center gap-1 py-1 px-2 cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors text-xs border-dashed" onClick={() => toggle(c.name)}>
              <Plus className="h-3 w-3 opacity-50" />
              {c.name}
            </Badge>
          ))}
          {candidates.filter(c => !selected.includes(c.name)).length === 0 && (
            <span className="text-xs text-muted-foreground italic">No more suggestions</span>
          )}
        </div>
      </div>
      
      <div className="flex gap-2">
        <Input 
          placeholder="Add custom competitor..." 
          value={newName} 
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
          className="max-w-xs text-sm h-9"
        />
        <Button size="sm" variant="secondary" className="h-9" onClick={handleAdd}>Add</Button>
      </div>
    </div>
  )
}

function RunHistory({ projectId }: { projectId: string }) {
  const { data: runs, isLoading } = useListProjectResearchRuns(projectId, {
    query: { enabled: !!projectId, queryKey: getListProjectResearchRunsQueryKey(projectId) }
  });
  
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground h-auto py-1">View History</Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Research Run History</DialogTitle>
          <DialogDescription>Previous market intelligence gathering runs for this project.</DialogDescription>
        </DialogHeader>
        {isLoading ? <div className="p-8 text-center animate-pulse flex flex-col items-center">
          <div className="h-8 w-8 bg-slate-200 dark:bg-slate-800 rounded-full mb-4"></div>
          <div className="h-4 w-32 bg-slate-200 dark:bg-slate-800 rounded mb-2"></div>
        </div> : (
          <div className="space-y-3 mt-4">
            {runs?.map(run => (
              <div key={run.id} className="border border-slate-200 dark:border-slate-800 rounded-lg p-4 text-sm bg-slate-50/50 dark:bg-slate-900/30">
                <div className="flex justify-between items-start mb-3">
                  <div>
                    <div className="font-semibold text-foreground">{format(new Date(run.requestedAt), 'MMM d, yyyy h:mm a')}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">ID: {run.id.slice(0, 8)}...</div>
                  </div>
                  <Badge variant={run.status === 'completed' ? 'default' : run.status === 'failed' ? 'destructive' : 'secondary'} className="capitalize">
                    {run.status.replace(/_/g, ' ')}
                  </Badge>
                </div>
                <div className="grid grid-cols-3 gap-4 text-xs bg-white dark:bg-slate-950 p-3 rounded-md border">
                  <div>
                    <span className="text-muted-foreground block mb-1">Brand</span>
                    <span className="font-medium truncate block">{run.brand || '-'}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground block mb-1">Sources</span>
                    <span className="font-medium">{run.sourcesFound}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground block mb-1">Claims</span>
                    <span className="font-medium">{run.claimsGenerated}</span>
                  </div>
                </div>
                <RunCoverageSnapshot
                  snapshot={run.coverageSnapshot}
                  capturedAt={run.coverageSnapshotAt}
                  snapshotStatus={run.coverageSnapshotStatus}
                />
                {run.errorMessage && (
                  <div className="mt-3 text-xs text-destructive bg-destructive/10 p-2 rounded border border-destructive/20">
                    {run.errorMessage}
                  </div>
                )}
              </div>
            ))}
            {runs?.length === 0 && (
              <div className="text-center text-muted-foreground p-8 border border-dashed rounded-lg">
                <Search className="h-8 w-8 mx-auto mb-3 opacity-20" />
                <p>No historical runs found.</p>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function RunCoverageSnapshot({
  snapshot,
  capturedAt,
  snapshotStatus,
}: {
  snapshot: QualityProjection | null;
  capturedAt: string | null;
  snapshotStatus: ResearchRunDetailsCoverageSnapshotStatus;
}) {
  type CoverageSectionKey = "company" | "competitors" | "currentPromotion" | "ooh" | "campaign" | "strategy";
  const sections: { key: CoverageSectionKey; label: string }[] = [
    { key: "company", label: "Company" },
    { key: "competitors", label: "Competitors" },
    { key: "currentPromotion", label: "Current Promotion" },
    { key: "ooh", label: "OOH" },
    { key: "campaign", label: "Campaign" },
    { key: "strategy", label: "Strategy" },
  ];
  const statusLabel = snapshotStatus === "captured_at_completion"
    ? "Captured at completion"
    : snapshotStatus === "backfilled_before_retry"
      ? "Captured before retry"
      : "Unavailable";

  return (
    <div className="mt-3 rounded-md border bg-white dark:bg-slate-950 p-3" data-testid="run-coverage-snapshot">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h4 className="text-xs font-semibold">Coverage snapshot</h4>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={snapshot ? "secondary" : "outline"} className="text-[10px]">
            {snapshot ? statusLabel : `Not recorded · ${statusLabel}`}
          </Badge>
          {capturedAt && (
            <span className="text-[10px] text-muted-foreground">
              As of {format(new Date(capturedAt), "MMM d, yyyy h:mm a")}
            </span>
          )}
          {!capturedAt && (
            <span className="text-[10px] text-muted-foreground">Capture time not recorded</span>
          )}
        </div>
      </div>
      {!snapshot ? (
        <p className="text-xs text-muted-foreground">
          Coverage snapshot unavailable for this run; no per-run coverage was recorded.
        </p>
      ) : (
        <>
          <p className="text-[11px] text-muted-foreground mb-2">
            Promotion: {snapshot.promotionSummary}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {sections.map(({ key, label }) => {
              const section = snapshot[key];
              return (
                <div key={key} className="rounded border bg-slate-50/70 dark:bg-slate-900/60 px-2.5 py-2" data-testid={`run-coverage-${key}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-medium">{label}</span>
                    <span className="text-xs font-semibold tabular-nums">{section.percentage}%</span>
                  </div>
                  <div
                    role="progressbar"
                    aria-label={`${label} coverage`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={section.percentage}
                    className="h-1.5 mt-1.5 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden"
                  >
                    <div className="h-full rounded-full bg-brand" style={{ width: `${Math.max(0, Math.min(100, section.percentage))}%` }} />
                  </div>
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    {section.missingCriteria.length
                      ? `${section.missingCriteria.length} missing: ${section.missingCriteria.map((criterion) => criterion.replace(/_/g, " ")).join(", ")}`
                      : "No missing criteria"}
                  </p>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function RetryPanel({ projectId, runId, stages }: { projectId: string, runId: string, stages: ResearchStage[] }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const retry = useRetryResearchStages();
  
  const failedStages = stages.filter(s => s.status === 'failed' || s.status === 'limited_evidence').map(s => s.key);
  
  if (failedStages.length === 0) return null;

  return (
    <div className="mt-4 p-4 border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/30 rounded-lg">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h4 className="font-semibold text-sm text-amber-800 dark:text-amber-500 mb-1">Some research stages had issues</h4>
          <p className="text-xs text-amber-700/80 dark:text-amber-400/80">You can retry the specific stages that did not complete successfully or had limited evidence.</p>
        </div>
        <Button 
          size="sm" 
          variant="outline" 
          className="border-amber-300 dark:border-amber-700 text-amber-800 dark:text-amber-500 hover:bg-amber-100 dark:hover:bg-amber-900 shrink-0"
          disabled={retry.isPending}
          onClick={() => {
            retry.mutate({ id: projectId, runId, data: { stages: failedStages } }, {
              onSuccess: () => {
                toast({ title: "Retrying failed stages", description: "The research run has been updated." });
                queryClient.invalidateQueries({ queryKey: getGetProjectIntelligenceQueryKey(projectId) });
                queryClient.invalidateQueries({ queryKey: getListProjectResearchRunsQueryKey(projectId) });
                queryClient.invalidateQueries({ queryKey: getGetProjectResearchRunQueryKey(projectId, runId) });
              }
            });
          }}
        >
          <RefreshCw className={`h-3 w-3 mr-2 ${retry.isPending ? 'animate-spin' : ''}`} />
          Retry Failed Stages
        </Button>
      </div>
    </div>
  )
}
