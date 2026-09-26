import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import { FileText, ExternalLink, ShieldCheck, HelpCircle, Bot } from "lucide-react";
import { IntelligenceClaim } from "@workspace/api-client-react";
import { format } from "date-fns";

export function EvidenceList({ claimIds, claims, fallback = "No verified evidence yet" }: { claimIds: string[], claims: IntelligenceClaim[], fallback?: string }) {
  if (!claimIds || claimIds.length === 0) {
    return <span className="text-xs text-muted-foreground italic block mt-2">{fallback}</span>;
  }

  const activeClaims = claims.filter(c => claimIds.includes(c.id));
  if (activeClaims.length === 0) {
    return <span className="text-xs text-muted-foreground italic block mt-2">{fallback}</span>;
  }

  return (
    <div className="flex flex-wrap gap-2 mt-2">
      {activeClaims.map(claim => (
        <EvidenceBadge key={claim.id} claim={claim} />
      ))}
    </div>
  );
}

export function EvidenceBadge({ claim }: { claim: IntelligenceClaim }) {
  const getIcon = () => {
    switch (claim.claimType) {
      case 'verified_fact': return <ShieldCheck className="h-3 w-3 mr-1" />;
      case 'ai_interpretation': return <Bot className="h-3 w-3 mr-1" />;
      case 'estimate': return <HelpCircle className="h-3 w-3 mr-1" />;
      default: return <FileText className="h-3 w-3 mr-1" />;
    }
  };

  const getColor = () => {
    if (claim.claimType === 'ai_interpretation') return 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-300';
    if (claim.confidence === 'confirmed') return 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-900/20 dark:text-emerald-300';
    return 'border-slate-200 bg-slate-50 text-slate-800 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300';
  };

  const getLabel = () => {
    if (claim.source) return 'Source';
    if (claim.isDemo) return 'Sample interpretation';
    return 'Unsourced interpretation';
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className={`inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-medium border cursor-pointer hover:opacity-80 transition-opacity ${getColor()}`}>
          {getIcon()}
          {getLabel()}
          {claim.isDemo && claim.source && <span className="ml-1 opacity-70">(Sample)</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-4 text-sm" align="start">
        <div className="space-y-3">
          <div>
            <div className="flex justify-between items-start mb-1">
              <span className="font-semibold text-xs uppercase tracking-wider text-muted-foreground">Claim</span>
              <Badge variant="outline" className="text-[10px] py-0">{claim.claimType.replace(/_/g, ' ')}</Badge>
            </div>
            <p className="font-medium text-foreground">{claim.claim}</p>
          </div>
          
          {claim.source ? (
            <div className="bg-slate-50 dark:bg-slate-900 rounded-md p-3 border">
              <span className="font-semibold text-xs uppercase tracking-wider text-muted-foreground block mb-2">Source Details</span>
              
              <div className="space-y-2 text-xs">
                {claim.source.title && (
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground whitespace-nowrap">Title</span>
                    <span className="font-medium max-w-[180px] text-right truncate" title={claim.source.title}>{claim.source.title}</span>
                  </div>
                )}
                {claim.source.publisher && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Publisher</span>
                    <span className="font-medium">{claim.source.publisher}</span>
                  </div>
                )}
                {claim.source.publishedAt && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Published</span>
                    <span>{format(new Date(claim.source.publishedAt), 'MMM d, yyyy')}</span>
                  </div>
                )}
                {claim.source.retrievedAt && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Retrieved</span>
                    <span>{format(new Date(claim.source.retrievedAt), 'MMM d, yyyy')}</span>
                  </div>
                )}
                {claim.source.qualityScore !== undefined && claim.source.qualityScore !== null && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Quality Score</span>
                    <span>{claim.source.qualityScore}/100</span>
                  </div>
                )}
                {claim.methodology && claim.methodology.startsWith('Source-exact excerpt:') && (
                  <div className="pt-2 mt-2 border-t text-xs space-y-1">
                    <span className="text-muted-foreground block mb-1">Verifiable Passage</span>
                    <blockquote className="border-l-2 border-brand/30 pl-2 italic text-foreground/90 leading-relaxed">
                      {claim.methodology.replace('Source-exact excerpt:', '').trim()}
                    </blockquote>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Confidence</span>
                  <span className="capitalize">{claim.confidence.replace(/_/g, ' ')}</span>
                </div>
                {claim.source.url && (
                  <div className="pt-2 mt-2 border-t flex justify-end">
                    <a href={claim.source.url} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline inline-flex items-center">
                      View Original <ExternalLink className="h-3 w-3 ml-1" />
                    </a>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="bg-slate-50 dark:bg-slate-900 rounded-md p-3 border border-dashed text-xs">
              <span className="font-semibold text-xs uppercase tracking-wider text-muted-foreground block mb-2">No Verified Source</span>
              <div className="space-y-2">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Status</span>
                  <span>No URL / publication / access date</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Confidence</span>
                  <span className="capitalize">{claim.confidence.replace(/_/g, ' ')}</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
