import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Lightbulb, Target, MapPin, TrendingUp, AlertTriangle } from "lucide-react";
import { type ProjectWorkspace } from "@workspace/api-client-react";
import { PitchRecommendation } from "@/components/workspace/pitch-recommendation";

export function OverviewTab({ workspace }: { workspace: ProjectWorkspace }) {
  if (!workspace.project.isDemo) {
    return <PitchRecommendation workspace={workspace} />;
  }

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight mb-2">Workspace Overview</h1>
        <p className="text-muted-foreground">Project context and clearly labeled sample content for workspace review.</p>
      </div>

      {workspace.demoNotice && (
        <div className="bg-amber-50 border border-amber-200 dark:bg-amber-950/30 dark:border-amber-900/50 rounded-lg p-4 flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
          <div>
            <h4 className="font-medium text-amber-800 dark:text-amber-500 mb-1">Demo Environment</h4>
            <p className="text-sm text-amber-700/80 dark:text-amber-400/80">{workspace.demoNotice}</p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card className="shadow-sm border-slate-200 dark:border-slate-800">
          <CardHeader className="pb-3 flex flex-row items-center justify-between">
            <div>
              <CardTitle className="text-lg">Sample Insight</CardTitle>
              <CardDescription>Illustrative content only</CardDescription>
            </div>
            <div className="bg-brand/10 p-2 rounded-full">
              <Lightbulb className="h-5 w-5 text-brand" />
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-foreground leading-relaxed">
              {workspace.insight}
            </p>
          </CardContent>
        </Card>

        <Card className="shadow-sm border-slate-200 dark:border-slate-800">
          <CardHeader className="pb-3 flex flex-row items-center justify-between">
            <div>
              <CardTitle className="text-lg">Market Snapshot</CardTitle>
              <CardDescription>Project scope placeholder</CardDescription>
            </div>
            <div className="bg-slate-100 dark:bg-slate-800 p-2 rounded-full">
              <TrendingUp className="h-5 w-5 text-slate-500" />
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-foreground leading-relaxed">
              {workspace.marketSnapshot}
            </p>
            <div className="mt-4 flex gap-4 text-sm border-t pt-4">
              <div>
                <span className="text-muted-foreground block text-xs uppercase tracking-wider mb-1">Competitors</span>
                <span className="font-semibold">
                  {workspace.competitorCount == null ? "Not researched" : `${workspace.competitorCount} identified`}
                </span>
              </div>
              {workspace.lastKnownOohActivity && (
                <div>
                  <span className="text-muted-foreground block text-xs uppercase tracking-wider mb-1">Recent Activity</span>
                  <span className="font-semibold truncate block max-w-[150px]" title={workspace.lastKnownOohActivity}>
                    {workspace.lastKnownOohActivity}
                  </span>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-sm border-slate-200 dark:border-slate-800">
          <CardHeader className="pb-3 flex flex-row items-center justify-between">
            <div>
              <CardTitle className="text-lg">Sample Opportunity</CardTitle>
              <CardDescription>Illustrative · not approved</CardDescription>
            </div>
            <div className="bg-emerald-500/10 p-2 rounded-full">
              <Target className="h-5 w-5 text-emerald-600" />
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-foreground leading-relaxed">
              {workspace.opportunitySummary}
            </p>
          </CardContent>
        </Card>

        <Card className="shadow-sm border-slate-200 dark:border-slate-800">
          <CardHeader className="pb-3 flex flex-row items-center justify-between">
            <div>
              <CardTitle className="text-lg">Media & Locations</CardTitle>
              <CardDescription>Planning placeholders</CardDescription>
            </div>
            <div className="bg-blue-500/10 p-2 rounded-full">
              <MapPin className="h-5 w-5 text-blue-600" />
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-foreground leading-relaxed mb-4">
              {workspace.locationsSummary}
            </p>
            <div className="flex flex-wrap gap-2">
              {workspace.recommendedMedia.map((media, i) => (
                <Badge key={i} variant="secondary" className="font-normal text-xs">{media}</Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
