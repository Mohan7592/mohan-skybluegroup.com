import { useParams } from "wouter";
import { useGetProjectIntelligence, getGetProjectIntelligenceQueryKey } from "@workspace/api-client-react";
import { ResearchStatusBanner } from "@/components/research-status";
import { EvidenceList } from "@/components/evidence-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { CheckCircle2, ChevronRight, AlertCircle, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export function StrategyTab() {
  const { id = "" } = useParams();
  const { data: intelligence, isLoading, isError } = useGetProjectIntelligence(id, {
    query: { enabled: !!id, queryKey: getGetProjectIntelligenceQueryKey(id) }
  });

  if (isLoading) return <div className="p-8"><Skeleton className="w-full h-96" /></div>;
  if (isError || !intelligence) return <div>Error loading strategy</div>;

  const strategy = intelligence.strategy || [];

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500 pb-12 max-w-4xl">
      <div>
        <h1 className="text-3xl font-bold tracking-tight mb-2">Pitch Hypothesis</h1>
        <p className="text-muted-foreground">Strategic recommendations formulated from market intelligence.</p>
      </div>

      <ResearchStatusBanner projectId={id} status={intelligence.status} />

      {intelligence.sampleNotice && (
        <div className="bg-amber-50 border border-amber-200 dark:bg-amber-950/30 dark:border-amber-900/50 rounded-lg p-4 flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
          <div>
            <h4 className="font-medium text-amber-800 dark:text-amber-500 mb-1">Demo Data</h4>
            <p className="text-sm text-amber-700/80 dark:text-amber-400/80">{intelligence.sampleNotice}</p>
          </div>
        </div>
      )}

      {strategy.length === 0 ? (
        <div className="p-12 text-center text-muted-foreground border rounded-xl bg-slate-50 dark:bg-slate-900 shadow-sm">
          {intelligence.status.state === 'research_not_started' 
            ? 'Research not started. Connect a live provider to begin.' 
            : 'No strategic recommendations available yet.'}
        </div>
      ) : (
        <div className="relative border-l-2 border-slate-200 dark:border-slate-800 ml-4 space-y-12 pb-8">
          {strategy.map((item, index) => (
            <div key={item.id} className="relative pl-8">
              {/* Timeline marker */}
              <div className="absolute -left-[11px] top-1 h-5 w-5 rounded-full bg-slate-50 dark:bg-slate-950 border-2 border-brand flex items-center justify-center">
                <div className="h-2 w-2 rounded-full bg-brand" />
              </div>
              
              <div className="bg-white dark:bg-slate-900 border rounded-xl p-6 shadow-sm">
                <div className="flex flex-wrap justify-between items-start gap-4 mb-4">
                  <h3 className="text-lg font-bold flex items-center text-slate-900 dark:text-white">
                    <span className="text-muted-foreground/50 mr-2 text-sm">{index + 1}.</span>
                    {item.label}
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    {item.status === 'approved' && (
                      <Badge variant="outline" className="border-emerald-200 text-emerald-700 bg-emerald-50 dark:border-emerald-900/50 dark:text-emerald-400 dark:bg-emerald-950/30">
                        <CheckCircle2 className="h-3 w-3 mr-1" /> Approved
                      </Badge>
                    )}
                    {item.status === 'draft' && (
                      <Badge variant="secondary" className="border-amber-200 text-amber-700 bg-amber-50 dark:border-amber-900/50 dark:text-amber-400 dark:bg-amber-950/30">
                        <AlertCircle className="h-3 w-3 mr-1" /> AI Draft
                      </Badge>
                    )}
                    {item.status === 'rejected' && (
                      <Badge variant="outline" className="border-destructive/50 text-destructive bg-destructive/10 dark:text-red-400 dark:bg-red-950/30">
                        <XCircle className="h-3 w-3 mr-1" /> Rejected
                      </Badge>
                    )}
                    {item.isDemo && (
                      <Badge variant="secondary" className="font-normal text-xs text-amber-700 bg-amber-50 dark:text-amber-400 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/50">Illustrative / Sample</Badge>
                    )}
                    {!item.isDemo && (
                      <Badge
                        variant="outline"
                        className={item.evidenceStrength === "Strong"
                          ? "border-emerald-200 text-emerald-700 bg-emerald-50 dark:border-emerald-900/50 dark:text-emerald-400 dark:bg-emerald-950/30"
                          : "border-amber-200 text-amber-700 bg-amber-50 dark:border-amber-900/50 dark:text-amber-400 dark:bg-amber-950/30"}
                        data-testid={`strategy-evidence-strength-${item.id}`}
                      >
                        {item.evidenceStrength} Evidence
                      </Badge>
                    )}
                  </div>
                </div>

                <div className="space-y-5">
                  <div>
                    <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center">
                      <ChevronRight className="h-3 w-3 mr-1 text-brand" /> Recommendation
                    </h4>
                    <p className="text-base text-foreground font-medium leading-relaxed pl-4 border-l-2 border-slate-100 dark:border-slate-800">
                      {item.recommendation}
                    </p>
                  </div>
                  
                  <div>
                    <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center">
                      <ChevronRight className="h-3 w-3 mr-1 text-brand" /> Rationale
                    </h4>
                    <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed pl-4 border-l-2 border-slate-100 dark:border-slate-800">
                      {item.rationale}
                    </p>
                  </div>

                  <div className="pt-4 mt-2 border-t border-slate-100 dark:border-slate-800">
                    <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Supporting Evidence</h4>
                    {(!item.evidenceClaimIds || item.evidenceClaimIds.length === 0) ? (
                      <div className="text-sm text-amber-700/80 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/50 p-3 rounded-md flex items-start gap-2">
                        <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-amber-600 dark:text-amber-500" />
                        <span><strong>Unsupported:</strong> No sourced evidence is currently attached to support this interpretation.</span>
                      </div>
                    ) : (
                      <EvidenceList claimIds={item.evidenceClaimIds} claims={intelligence.claims} fallback="No verified evidence yet" />
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
