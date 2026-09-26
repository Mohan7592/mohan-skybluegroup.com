import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetProjectIntelligenceQueryKey,
  getGetProjectResearchRunQueryKey,
  getListProjectResearchRunsQueryKey,
  QualityProjection,
  useGetProjectResearchRun,
  useRetryResearchStages,
} from "@workspace/api-client-react";
import { AlertCircle, CheckCircle2, RefreshCw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";

type CoverageKey = "company" | "competitors" | "currentPromotion" | "ooh" | "campaign" | "strategy";

const SECTIONS: { key: CoverageKey; label: string; targetedStage?: string }[] = [
  { key: "company", label: "Company", targetedStage: "company_research" },
  { key: "competitors", label: "Competitors", targetedStage: "competitor_research" },
  { key: "currentPromotion", label: "Current Promotion", targetedStage: "current_promotion" },
  { key: "ooh", label: "OOH", targetedStage: "ooh_research" },
  { key: "campaign", label: "Campaign", targetedStage: "campaign_research" },
  { key: "strategy", label: "Strategy" },
];

const formatCriterion = (value: string) =>
  value.replace(/_/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());

export function ResearchCoveragePanel({
  projectId,
  currentRunId,
  quality,
  researchInProgress = false,
}: {
  projectId: string;
  currentRunId?: string | null;
  quality: QualityProjection;
  researchInProgress?: boolean;
}) {
  const retry = useRetryResearchStages();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [targeting, setTargeting] = useState<string | null>(null);
  const { data: currentRun } = useGetProjectResearchRun(projectId, currentRunId || "", {
    query: {
      enabled: !!projectId && !!currentRunId,
      queryKey: getGetProjectResearchRunQueryKey(projectId, currentRunId || ""),
    },
  });
  const brandResolutionConfirmed = !!currentRun?.confirmedBrand;
  const brandResolutionStage = currentRun?.stages.find((stage) => stage.key === "brand_resolution");
  const brandResolutionReason = currentRun?.errorMessage || brandResolutionStage?.note
    || (currentRun?.status === "awaiting_brand_confirmation"
      ? "Confirm the brand and official website before researching coverage gaps."
      : "Confirm the initial brand identity before retrying research stages.");
  const missingStages = [...new Set(
    SECTIONS
      .filter(({ key }) => quality[key].missingCriteria.length > 0)
      .flatMap(({ key }) => quality[key].retryStages),
  )];

  const handleRetry = (stages: string[], runId: string, target?: string) => {
    if (!stages.length || !runId || retry.isPending || researchInProgress) return;
    setTargeting(target ?? "gaps");
    retry.mutate({ id: projectId, runId, data: { stages } }, {
      onSuccess: (run) => {
        toast({ title: target ? `Retrying ${target}` : "Resolving research gaps" });
        queryClient.invalidateQueries({ queryKey: getGetProjectIntelligenceQueryKey(projectId) });
        queryClient.invalidateQueries({ queryKey: getListProjectResearchRunsQueryKey(projectId) });
        queryClient.invalidateQueries({ queryKey: getGetProjectResearchRunQueryKey(projectId, runId) });
        if (run.id !== runId) {
          queryClient.invalidateQueries({ queryKey: getGetProjectResearchRunQueryKey(projectId, run.id) });
        }
      },
      onError: (error) => {
        toast({
          title: "Could not retry research",
          description: error instanceof Error ? error.message : "Please try again.",
          variant: "destructive",
        });
      },
      onSettled: () => setTargeting(null),
    });
  };

  const errorMessage = retry.error instanceof Error ? retry.error.message : "Please try again.";
  const promotionStage = currentRun?.stages.find((stage) => stage.key === "current_promotion");
  const promotionStagePending = !!currentRun && (!promotionStage || ["pending", "running", "needs_review"].includes(promotionStage.status));
  const promotionSummary = (String(quality.promotionSummary) === "No Verified Active Promotion" && promotionStagePending)
    || String(quality.promotionSummary) === "Not researched"
    ? "Not researched"
    : quality.promotionSummary;

  return (
    <Card className="shadow-sm border-slate-200 dark:border-slate-800">
      <CardHeader className="pb-3">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div>
            <CardTitle className="text-lg">Research Gaps &amp; Coverage</CardTitle>
            <p className="text-sm text-muted-foreground mt-1">
              Evidence coverage by research area. Resolve Gaps retries only stages linked to missing criteria.
            </p>
              <Badge
              variant="outline"
              className={`mt-2 ${promotionSummary === "Confirmed Active"
                ? "border-emerald-200 text-emerald-700 bg-emerald-50 dark:border-emerald-900/50 dark:text-emerald-400 dark:bg-emerald-950/30"
                : "border-amber-200 text-amber-700 bg-amber-50 dark:border-amber-900/50 dark:text-amber-400 dark:bg-amber-950/30"}`}
              data-testid="status-promotion-summary"
            >
              Promotion: {promotionSummary}
            </Badge>
          </div>
          <Button
            size="sm"
            onClick={() => {
              const runId = currentRunId || SECTIONS.map(({ key }) => quality[key].researchRunId).find(Boolean);
              if (runId) handleRetry(missingStages, runId);
            }}
            disabled={!brandResolutionConfirmed || !missingStages.length || !(currentRunId || SECTIONS.some(({ key }) => quality[key].researchRunId)) || retry.isPending || researchInProgress}
            data-testid="button-resolve-research-gaps"
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${retry.isPending && targeting === "gaps" ? "animate-spin" : ""}`} />
            Resolve Gaps
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {researchInProgress && (
          <div className="mb-4 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800 dark:border-blue-900/50 dark:bg-blue-950/30 dark:text-blue-300">
            Research is in progress. Targeted retries are paused until the current run finishes.
          </div>
        )}
        {!brandResolutionConfirmed && (
          <div className="mb-4 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300" role="status" data-testid="notice-brand-resolution-required">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <span><strong>Research retries are paused until Brand Resolution is confirmed.</strong> {brandResolutionReason}</span>
          </div>
        )}
        {retry.isError && (
          <div className="mb-4 flex items-start gap-2 rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive" role="alert">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>Retry failed. {errorMessage}</span>
          </div>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {SECTIONS.map(({ key, label, targetedStage }) => {
            const coverage = quality[key];
            const runId = currentRunId || coverage.researchRunId;
            const stageKey = targetedStage || "strategy_generation";
            const sectionStage = currentRun?.stages.find((stage) => stage.key === stageKey);
            const sectionResearched = coverage.coveredCriteria.length > 0
              || !!sectionStage && ["complete", "limited_evidence", "failed"].includes(sectionStage.status);
            return (
              <div key={key} className="rounded-lg border bg-slate-50/60 dark:bg-slate-950/30 p-3" data-testid={`coverage-${key}`}>
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-medium">{label}</h3>
                  <Badge variant={coverage.percentage === 100 ? "secondary" : "outline"}>
                    {sectionResearched ? `${coverage.percentage}%` : "Not researched"}
                  </Badge>
                </div>
                {sectionResearched && <Progress value={coverage.percentage} className="h-1.5 mt-2" aria-label={`${label} evidence coverage`} />}
                <p className="text-[11px] text-muted-foreground mt-2">
                  {sectionResearched
                    ? `${coverage.coveredCriteria.length} of ${coverage.requiredCriteria.length} criteria covered`
                    : "Not researched"}
                </p>
                {sectionResearched && coverage.missingCriteria.length > 0 ? (
                  <div className="mt-2">
                    <p className="text-[11px] font-medium text-amber-800 dark:text-amber-400 mb-1">Missing criteria</p>
                    <ul className="space-y-1">
                      {coverage.missingCriteria.map((criterion) => (
                        <li key={criterion} className="text-xs text-muted-foreground">• {formatCriterion(criterion)}</li>
                      ))}
                    </ul>
                  </div>
                ) : sectionResearched ? (
                  <p className="mt-2 flex items-center text-xs text-emerald-700 dark:text-emerald-400">
                    <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> All required criteria covered
                  </p>
                ) : null}
                {targetedStage && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-3 h-8 w-full text-xs"
                    disabled={!brandResolutionConfirmed || !runId || retry.isPending || researchInProgress}
                    onClick={() => runId && handleRetry([targetedStage], runId, label)}
                    data-testid={`button-retry-${key}`}
                  >
                    <RefreshCw className={`h-3 w-3 mr-1.5 ${retry.isPending && targeting === label ? "animate-spin" : ""}`} />
                    Research {label}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}