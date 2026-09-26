import { useParams } from "wouter";
import { useGetProjectIntelligence, getGetProjectIntelligenceQueryKey } from "@workspace/api-client-react";
import { ResearchStatusBanner } from "@/components/research-status";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Users, AlertCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export function CompetitorsTab() {
  const { id = "" } = useParams();
  const { data: intelligence, isLoading, isError } = useGetProjectIntelligence(id, {
    query: { enabled: !!id, queryKey: getGetProjectIntelligenceQueryKey(id) }
  });

  if (isLoading) return <div className="p-8"><Skeleton className="w-full h-96" /></div>;
  if (isError || !intelligence) return <div>Error loading competitors</div>;

  const competitors = intelligence.competitors || [];

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500 pb-12">
      <div>
        <h1 className="text-3xl font-bold tracking-tight mb-2">Competitor Analysis</h1>
        <p className="text-muted-foreground">Market positioning, activity, and observable gaps.</p>
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

      {competitors.length === 0 ? (
        <div className="bg-white dark:bg-slate-900 border rounded-xl p-12 text-center shadow-sm">
          <Users className="h-10 w-10 text-slate-300 mx-auto mb-4" />
          <h3 className="text-lg font-medium">
            {intelligence.status.state === 'research_not_started' ? 'Research not started' : 'No competitors identified'}
          </h3>
          <p className="text-muted-foreground mt-2">
            {intelligence.status.state === 'research_not_started' 
              ? intelligence.status.liveResearchAvailable
                ? 'Start research for this brand to discover competitors.'
                : 'Live research is unavailable. Connect a research provider to begin.'
              : 'Research is pending or no direct competitors were found in the target market.'}
          </p>
        </div>
      ) : (
        <div className="space-y-12">
          {/* Comparison Table */}
          <div className="bg-white dark:bg-slate-900 border rounded-xl shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm min-w-[1000px]">
                <thead>
                  <tr className="bg-slate-50 dark:bg-slate-900 border-b">
                    <th className="p-4 text-left font-semibold w-48 shrink-0">Brand</th>
                    <th className="p-4 text-left font-semibold">Positioning</th>
                    <th className="p-4 text-left font-semibold">Current Promotion</th>
                    <th className="p-4 text-left font-semibold">OOH Activity</th>
                    <th className="p-4 text-left font-semibold">DOOH Activity</th>
                    <th className="p-4 text-left font-semibold">Transit Activity</th>
                    <th className="p-4 text-left font-semibold">Product Focus / Main Products</th>
                    <th className="p-4 text-left font-semibold">Messaging Theme</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {competitors.map((comp) => (
                    <tr key={comp.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-900/50 transition-colors">
                      <td className="p-4 font-medium align-top">
                        <div className="flex flex-col gap-1 items-start">
                          {comp.name}
                          {comp.isDemo && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-sm bg-slate-200 dark:bg-slate-800 text-slate-600 font-normal">Sample</span>
                          )}
                          {!comp.isDemo && (
                            <>
                              <Badge
                                variant="outline"
                                className={
                                  comp.verificationStatus === "Verified"
                                    ? "border-emerald-200 text-emerald-700 bg-emerald-50 dark:border-emerald-900/50 dark:text-emerald-400 dark:bg-emerald-950/30"
                                    : comp.verificationStatus === "Partially Verified"
                                      ? "border-amber-200 text-amber-700 bg-amber-50 dark:border-amber-900/50 dark:text-amber-400 dark:bg-amber-950/30"
                                      : "border-slate-200 text-slate-600 bg-slate-50 dark:border-slate-800 dark:text-slate-400 dark:bg-slate-900"
                                }
                                data-testid={`competitor-verification-${comp.id}`}
                              >
                                {comp.verificationStatus}
                              </Badge>
                              <div className="mt-1 space-y-0.5 text-[10px] font-normal text-muted-foreground" data-testid={`competitor-evidence-${comp.id}`}>
                                {([
                                  ["Official identity", comp.verificationEvidence.officialIdentity],
                                  ["UAE presence", comp.verificationEvidence.uaePresence],
                                  ["Category", comp.verificationEvidence.category],
                                  ["Positioning", comp.verificationEvidence.positioning],
                                  ["Recent activity", comp.verificationEvidence.recentActivity],
                                ] as [string, boolean][]).map(([dimension, covered]) => (
                                  <div key={dimension} className="flex items-center gap-1">
                                    <span className={covered ? "text-emerald-600 dark:text-emerald-400" : "text-slate-400"}>
                                      {covered ? "✓" : "○"}
                                    </span>
                                    {dimension}
                                  </div>
                                ))}
                              </div>
                            </>
                          )}
                        </div>
                      </td>
                      {(!comp.evidenceClaimIds || comp.evidenceClaimIds.length === 0) ? (
                        <td colSpan={7} className="p-4 align-top">
                          <div className="inline-flex items-center text-xs font-medium text-slate-500 bg-slate-100 dark:text-slate-400 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-800 px-2.5 py-1.5 rounded-md">
                            <AlertCircle className="h-3.5 w-3.5 mr-1.5 opacity-70" /> Selected for research · profile unverified
                          </div>
                        </td>
                      ) : (
                        <>
                          <td className="p-4 align-top text-muted-foreground">{comp.positioning || '—'}</td>
                          <td className="p-4 align-top text-muted-foreground">{comp.currentPromotion || '—'}</td>
                          <td className="p-4 align-top text-muted-foreground">{comp.outdoorActivity || '—'}</td>
                          <td className="p-4 align-top text-muted-foreground">{comp.doohActivity || '—'}</td>
                          <td className="p-4 align-top text-muted-foreground">{comp.transitActivity || '—'}</td>
                          <td className="p-4 align-top text-muted-foreground">{comp.mainProducts || '—'}</td>
                          <td className="p-4 align-top text-muted-foreground">{comp.mainMessage || '—'}</td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* White Space Opportunities */}
          <div>
            <h2 className="text-2xl font-semibold mb-6">White Space Opportunities</h2>
            <div className="space-y-6">
              {competitors.map((comp) => (
                <Card key={`ws-${comp.id}`} className="shadow-sm">
                  <CardHeader className="pb-3 border-b border-slate-100 dark:border-slate-800">
                    <CardTitle className="text-lg flex items-center">
                      {comp.name}
                      {comp.isDemo && <span className="ml-3 text-[10px] px-1.5 py-0.5 rounded-sm bg-slate-200 dark:bg-slate-800 text-slate-600 font-normal">Sample</span>}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pt-4 grid grid-cols-1 md:grid-cols-2 gap-8">
                    <div>
                      <h4 className="font-semibold text-muted-foreground mb-2 uppercase tracking-wider text-xs flex items-center">
                        <span className="bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-400 p-1 rounded-sm mr-2">Observed fact</span>
                      </h4>
                      <p className="text-sm leading-relaxed">
                        {(!comp.isDemo && comp.observableGaps) ? comp.observableGaps : "No verified observation."}
                      </p>
                    </div>
                    <div>
                      <h4 className="font-semibold text-muted-foreground mb-2 uppercase tracking-wider text-xs flex items-center">
                        <span className="bg-brand/10 text-brand p-1 rounded-sm mr-2">AI strategic interpretation</span>
                      </h4>
                      <p className="text-sm leading-relaxed text-foreground">
                        {(comp.isDemo && comp.observableGaps) ? comp.observableGaps : "Pending AI analysis of verified observations."}
                      </p>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
