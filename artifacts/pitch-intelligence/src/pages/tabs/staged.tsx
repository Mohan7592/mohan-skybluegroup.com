import { Card, CardContent } from "@/components/ui/card";
import { Wrench, Sparkles } from "lucide-react";

export function StagedTab({ tabId, tabName }: { tabId: string, tabName: string }) {
  return (
    <div className="h-full min-h-[60vh] flex flex-col items-center justify-center animate-in fade-in duration-500">
      <div className="max-w-md text-center">
        <div className="inline-flex items-center justify-center p-4 bg-slate-100 dark:bg-slate-800/50 rounded-full mb-6 relative">
          <Wrench className="h-8 w-8 text-slate-400" />
          <Sparkles className="h-4 w-4 text-brand absolute top-0 right-0 -mt-1 -mr-1 animate-pulse" />
        </div>
        
        <h2 className="text-2xl font-bold tracking-tight mb-3">
          {tabName} Module
        </h2>
        
        <p className="text-muted-foreground mb-8 text-lg">
          This workspace module is currently staged for development.
        </p>

        <Card className="bg-slate-50 dark:bg-slate-900/50 border-dashed border-2 shadow-none">
          <CardContent className="p-6">
            <h3 className="font-semibold text-sm uppercase tracking-wider text-slate-500 mb-4">Planned Features</h3>
            <ul className="text-sm text-left space-y-3 text-slate-600 dark:text-slate-400">
              <li className="flex items-start">
                <span className="mr-2 text-brand">•</span>
                <span>Deep integration with market research APIs</span>
              </li>
              <li className="flex items-start">
                <span className="mr-2 text-brand">•</span>
                <span>Automated insight generation & data visualization</span>
              </li>
              <li className="flex items-start">
                <span className="mr-2 text-brand">•</span>
                <span>Collaborative editing with version history</span>
              </li>
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
