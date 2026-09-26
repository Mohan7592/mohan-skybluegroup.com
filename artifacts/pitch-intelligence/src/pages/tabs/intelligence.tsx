import { useParams } from "wouter";
import { useGetProjectIntelligence, getGetProjectIntelligenceQueryKey, IntelligenceEntry, IntelligenceClaim } from "@workspace/api-client-react";
import { ResearchStatusBanner } from "@/components/research-status";
import { EvidenceList, EvidenceBadge } from "@/components/evidence-badge";
import { ResearchCoveragePanel } from "@/components/research-coverage";
import { ClaimReviewPanel } from "@/components/claim-review";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertCircle, Building2, TrendingUp, Presentation, Sparkles } from "lucide-react";
import { format } from "date-fns";

export function IntelligenceTab() {
  const { id = "" } = useParams();
  const { data: intelligence, isLoading, isError } = useGetProjectIntelligence(id, {
    query: { enabled: !!id, queryKey: getGetProjectIntelligenceQueryKey(id) }
  });

  if (isLoading) return <IntelligenceSkeleton />;
  if (isError || !intelligence) return <IntelligenceError />;

  const validClaims = intelligence.claims.filter(c => c.status === 'approved' && !c.isDemo && c.source);
  const sortedClaims = [...validClaims].sort((a, b) => {
    const dateA = new Date(a.source!.publishedAt || a.source!.retrievedAt || 0).getTime();
    const dateB = new Date(b.source!.publishedAt || b.source!.retrievedAt || 0).getTime();
    return dateB - dateA;
  });
  
  const priorityCategories = ['marketing.promotion', 'marketing.overview'];
  const prioritizedClaims = sortedClaims.filter(c => priorityCategories.includes(c.category));
  const latestClaim = prioritizedClaims.length > 0 ? prioritizedClaims[0] : sortedClaims[0];

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500 pb-12">
      <div>
        <h1 className="text-3xl font-bold tracking-tight mb-2">Market & Brand Intelligence</h1>
        <p className="text-muted-foreground">Market context and data points for this pitch.</p>
      </div>

      <ResearchStatusBanner projectId={id} status={intelligence.status} />
      <ResearchCoveragePanel
        projectId={id}
        currentRunId={intelligence.status.currentRunId}
        quality={intelligence.quality}
        researchInProgress={["researching", "awaiting_brand_confirmation", "awaiting_competitor_review"].includes(intelligence.status.state)}
      />

      {latestClaim && (
        <Card className="shadow-sm border-brand/20 bg-brand/5 dark:bg-brand/10 mb-6 flex flex-col sm:flex-row sm:items-center justify-between p-4 gap-4 rounded-lg">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <Sparkles className="h-4 w-4 text-brand shrink-0" />
              <h3 className="text-xs font-semibold uppercase tracking-wider text-brand">Latest sourced finding</h3>
              <span className="text-xs text-muted-foreground capitalize">• {latestClaim.category.replace(/[._]/g, ' ')}</span>
            </div>
            <p className="text-sm font-medium text-foreground leading-relaxed mt-1">{latestClaim.claim}</p>
            <p className="text-xs text-muted-foreground mt-1">
              {latestClaim.source!.publishedAt 
                ? `Published ${format(new Date(latestClaim.source!.publishedAt), 'MMM d, yyyy')}` 
                : latestClaim.source!.retrievedAt 
                  ? `Retrieved ${format(new Date(latestClaim.source!.retrievedAt), 'MMM d, yyyy')}`
                  : 'Recent finding'
              }
            </p>
          </div>
          <div className="shrink-0 sm:self-start mt-2 sm:mt-0">
            <EvidenceBadge claim={latestClaim} />
          </div>
        </Card>
      )}

      {intelligence.sampleNotice && (
        <div className="bg-amber-50 border border-amber-200 dark:bg-amber-950/30 dark:border-amber-900/50 rounded-lg p-4 flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
          <div>
            <h4 className="font-medium text-amber-800 dark:text-amber-500 mb-1">Demo Data</h4>
            <p className="text-sm text-amber-700/80 dark:text-amber-400/80">{intelligence.sampleNotice}</p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <DataCard title="Company Snapshot" icon={Building2} items={intelligence.company} claims={intelligence.claims} researchStatus={intelligence.status.state} />
        <DataCard title="Market Intelligence" icon={TrendingUp} items={intelligence.market} claims={intelligence.claims} researchStatus={intelligence.status.state} />
        <DataCard title="Marketing Channels" icon={Presentation} items={intelligence.marketing} claims={intelligence.claims} researchStatus={intelligence.status.state} className="lg:col-span-2" />
      </div>

      <ClaimReviewPanel projectId={id} claims={intelligence.claims} />
    </div>
  );
}

function DataCard({ title, icon: Icon, items, claims, researchStatus, className = "" }: { title: string, icon: any, items: IntelligenceEntry[], claims: IntelligenceClaim[], researchStatus: string, className?: string }) {
  return (
    <Card className={`shadow-sm border-slate-200 dark:border-slate-800 ${className}`}>
      <CardHeader className="pb-3 flex flex-row items-center space-x-2">
        <div className="bg-slate-100 dark:bg-slate-800 p-2 rounded-md">
          <Icon className="h-5 w-5 text-slate-700 dark:text-slate-300" />
        </div>
        <CardTitle className="text-xl">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="divide-y divide-slate-100 dark:divide-slate-800">
          {items.map(item => (
            <div key={item.key} className="py-4 first:pt-0 last:pb-0">
              <div className="grid grid-cols-1 md:grid-cols-[1fr_2fr] gap-2 md:gap-4">
                <div className="text-sm font-medium text-muted-foreground flex items-start gap-2">
                  {item.label}
                  {item.isDemo && <span className="text-[10px] px-1.5 py-0.5 rounded-sm bg-slate-100 dark:bg-slate-800 border">Sample</span>}
                </div>
                <div>
                  <div className="text-sm font-medium text-foreground whitespace-pre-wrap">
                    {item.value || <span className="italic text-muted-foreground opacity-70">Not identified</span>}
                  </div>
                  <EvidenceList claimIds={item.claimIds} claims={claims} />
                </div>
              </div>
            </div>
          ))}
          {items.length === 0 && (
            <div className="py-8 text-center text-muted-foreground text-sm italic">
              {researchStatus === 'research_not_started' 
                ? "Research not started. Connect a live provider to begin."
                : "No data points identified yet."}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function IntelligenceSkeleton() {
  return (
    <div className="space-y-8 animate-pulse">
      <div className="h-10 bg-slate-100 dark:bg-slate-800 rounded w-1/3 mb-2"></div>
      <div className="h-6 bg-slate-100 dark:bg-slate-800 rounded w-1/2"></div>
      <div className="h-24 bg-slate-100 dark:bg-slate-800 rounded-lg"></div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="h-96 bg-slate-100 dark:bg-slate-800 rounded-xl"></div>
        <div className="h-96 bg-slate-100 dark:bg-slate-800 rounded-xl"></div>
      </div>
    </div>
  );
}

function IntelligenceError() {
  return (
    <div className="bg-destructive/10 text-destructive p-6 rounded-lg flex flex-col items-center justify-center text-center">
      <AlertCircle className="h-10 w-10 mb-4 opacity-80" />
      <h3 className="text-lg font-medium mb-1">Failed to load intelligence</h3>
      <p className="opacity-80">There was a problem loading the research data.</p>
    </div>
  );
}
