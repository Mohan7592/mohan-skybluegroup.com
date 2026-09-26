import { useParams } from "wouter";
import { useGetProjectIntelligence, getGetProjectIntelligenceQueryKey, CampaignIntelligence } from "@workspace/api-client-react";
import { ResearchStatusBanner } from "@/components/research-status";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Megaphone, MapPin, Calendar, Image as ImageIcon, CheckCircle2, AlertCircle, FileText, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { format } from "date-fns";

export function CampaignsTab() {
  const { id = "" } = useParams();
  const { data: intelligence, isLoading, isError } = useGetProjectIntelligence(id, {
    query: { enabled: !!id, queryKey: getGetProjectIntelligenceQueryKey(id) }
  });

  if (isLoading) return <div className="p-8"><Skeleton className="w-full h-96" /></div>;
  if (isError || !intelligence) return <div>Error loading campaigns</div>;

  const campaigns = intelligence.campaigns || [];
  const sourcedCampaigns = campaigns.filter(c => !c.isDemo);
  const sampleCampaigns = campaigns.filter(c => c.isDemo);

  const isStrictlyVerified = (c: CampaignIntelligence) =>
    !c.isDemo && (!!c.source?.url || !!c.sources?.some(s => s.url)) && !!c.startDate && !!c.endDate;

  const currentVerified = campaigns.filter(c => c.isCurrent && isStrictlyVerified(c));
  const lastKnownVerified = campaigns.filter(c => !c.isCurrent && isStrictlyVerified(c));
  
  const topCurrentPromo = currentVerified.length > 0 ? currentVerified[0] : null;
  const topLastKnown = lastKnownVerified.length > 0 ? lastKnownVerified[0] : null;

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500 pb-12">
      <div>
        <h1 className="text-3xl font-bold tracking-tight mb-2">Campaign Timeline</h1>
        <p className="text-muted-foreground">Mentions of campaigns reported in market sources. OOH evidence requires verification.</p>
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

      {/* Summary Panels */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card className="shadow-sm border-slate-200 dark:border-slate-800 p-6 flex flex-col justify-between">
          <div>
            <h3 className="font-semibold text-muted-foreground uppercase tracking-wider text-xs mb-4">Reported Active Promotion</h3>
            {topCurrentPromo ? (
              <div>
                <p className="text-lg font-bold">{topCurrentPromo.name}</p>
                <p className="text-sm text-muted-foreground mt-1">{topCurrentPromo.brandOrProduct}</p>
              </div>
            ) : (
              <p className="text-foreground font-medium">No confirmed active campaigns identified.</p>
            )}
          </div>
        </Card>
        
        <Card className="shadow-sm border-slate-200 dark:border-slate-800 p-6 flex flex-col justify-between">
          <div>
            <h3 className="font-semibold text-muted-foreground uppercase tracking-wider text-xs mb-4">
              {topLastKnown && ['confirmed_ooh', 'likely_ooh'].includes(topLastKnown.evidenceStatus || '') ? 'Last Known OOH Campaign' : 'Last Known Campaign'}
            </h3>
            {topLastKnown ? (
              <div>
                <p className="text-lg font-bold">{topLastKnown.name}</p>
                <p className="text-sm text-muted-foreground mt-1">
                  Ended: {topLastKnown.endDate || 'End unknown'}
                </p>
              </div>
            ) : (
              <p className="text-muted-foreground">No confirmed OOH campaigns identified.</p>
            )}
          </div>
        </Card>
      </div>

      <div className="mt-8">
        <h2 className="text-2xl font-semibold mb-6">Sourced Campaign Mentions</h2>
        {sourcedCampaigns.length === 0 ? (
          <div className="bg-white dark:bg-slate-900 border rounded-xl p-12 text-center shadow-sm">
            <Megaphone className="h-10 w-10 text-slate-300 mx-auto mb-4" />
            <h3 className="text-lg font-medium">No sourced campaigns identified.</h3>
            <p className="text-muted-foreground mt-2 max-w-md mx-auto">No sourced campaign mentions are stored yet for this brand in the target market.</p>
          </div>
        ) : (
          <div className="space-y-6">
            {sourcedCampaigns.map(campaign => (
              <CampaignCard key={campaign.id} campaign={campaign} />
            ))}
          </div>
        )}
      </div>

      {sampleCampaigns.length > 0 && (
        <div className="mt-12 pt-8 border-t border-dashed">
          <h2 className="text-xl font-semibold mb-2 text-slate-500 flex items-center">
            Illustrative Timeline
            <Badge variant="outline" className="ml-3 font-normal text-xs border-dashed">Sample Concept</Badge>
          </h2>
          <p className="text-sm text-muted-foreground mb-6">These concepts are provided for UI demonstration and are not verified facts.</p>
          <div className="space-y-6 opacity-80">
            {sampleCampaigns.map(campaign => (
              <CampaignCard key={campaign.id} campaign={campaign} />
            ))}
          </div>
        </div>
      )}

    </div>
  );
}

function CampaignCard({ campaign }: { campaign: CampaignIntelligence }) {
  return (
    <Card className={`overflow-hidden transition-all ${campaign.isCurrent && !campaign.isDemo ? 'border-brand/50 shadow-md ring-1 ring-brand/10' : ''}`}>
      <div className="flex flex-col md:flex-row">
        {/* Visual side */}
        <div className="w-full md:w-1/3 lg:w-1/4 bg-slate-100 dark:bg-slate-900 flex flex-col items-center justify-center p-6 border-b md:border-b-0 md:border-r">
          {campaign.referenceImageUrl ? (
            <img src={campaign.referenceImageUrl} alt={campaign.name} className="w-full h-auto rounded-md shadow-sm object-cover max-h-[200px]" />
          ) : (
            <div className="w-full aspect-video bg-slate-200 dark:bg-slate-800 rounded-md flex flex-col items-center justify-center text-slate-400">
              <ImageIcon className="h-8 w-8 mb-2 opacity-50" />
              <span className="text-xs font-medium uppercase tracking-widest">No Image</span>
            </div>
          )}
          {campaign.isDemo && (
            <Badge variant="outline" className="mt-4 border-dashed bg-white dark:bg-slate-950">Sample Illustration</Badge>
          )}
        </div>
        
        {/* Content side */}
        <div className="flex-1 p-6 flex flex-col justify-between">
          <div>
            <div className="flex flex-wrap justify-between items-start gap-4 mb-4">
              <div>
                <div className="flex flex-wrap items-center gap-2 mb-1">
                  <h3 className="text-xl font-bold text-foreground">{campaign.name}</h3>
                  {campaign.isCurrent && !campaign.isDemo && (
                    <Badge variant="secondary" className="bg-blue-50 text-blue-700 hover:bg-blue-100 border-blue-200 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-800">
                      <CheckCircle2 className="h-3 w-3 mr-1" /> Reported Active
                    </Badge>
                  )}
                  {campaign.promotionClassification && !campaign.isDemo && (
                    <Badge variant="outline" className="capitalize" data-testid={`campaign-promotion-classification-${campaign.id}`}>
                      {campaign.promotionClassification}
                    </Badge>
                  )}
                  {['confirmed_ooh', 'likely_ooh'].includes(campaign.evidenceStatus || '') && !campaign.isDemo && (
                    <Badge variant="outline" className="border-emerald-200 text-emerald-700 bg-emerald-50 dark:bg-emerald-950/30 dark:text-emerald-400 dark:border-emerald-900/50">
                      <CheckCircle2 className="h-3 w-3 mr-1" /> OOH Verified
                    </Badge>
                  )}
                </div>
                <p className="text-sm font-medium text-slate-600 dark:text-slate-400">
                  {campaign.brandOrProduct} {campaign.productFocus ? `• ${campaign.productFocus}` : ''}
                </p>
              </div>
              
              <div className="flex items-center gap-4 text-sm text-muted-foreground bg-slate-50 dark:bg-slate-900/50 p-2 rounded-lg border">
                <div className="flex items-center">
                  <Calendar className="h-4 w-4 mr-1.5 opacity-70" />
                  {campaign.startDate || 'Unknown'} - {campaign.endDate || 'End unknown'}
                </div>
                <div className="flex items-center border-l border-slate-200 dark:border-slate-800 pl-4 ml-2">
                  <MapPin className="h-4 w-4 mr-1.5 opacity-70" />
                  {campaign.geography || 'Unknown Market'}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mt-6">
              <div>
                <h4 className="font-semibold text-sm mb-2 text-foreground">Campaign Message</h4>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {campaign.message || 'No core message identified.'}
                </p>
              </div>
              
              <div className="space-y-4">
                <div>
                  <h4 className="font-semibold text-sm mb-2 text-foreground">Media Mix</h4>
                  <div className="flex flex-wrap gap-2">
                    <Badge variant="secondary" className="font-normal">{campaign.medium || 'Unknown Medium'}</Badge>
                    {campaign.oohMediumType && (
                      <Badge variant="outline" className="font-normal">{campaign.oohMediumType}</Badge>
                    )}
                    {campaign.oohMediumClassification && !campaign.isDemo && (
                      <Badge variant="outline" className="font-normal" data-testid={`campaign-ooh-classification-${campaign.id}`}>
                        OOH: {campaign.oohMediumClassification}
                      </Badge>
                    )}
                  </div>
                  {campaign.oohMediumSourceQuote && !campaign.isDemo && (
                    <blockquote className="mt-2 border-l-2 border-brand/30 pl-2 text-xs italic text-muted-foreground" data-testid={`campaign-ooh-source-quote-${campaign.id}`}>
                      Source quote: “{campaign.oohMediumSourceQuote}”
                    </blockquote>
                  )}
                </div>
                {campaign.location && (
                  <div>
                    <h4 className="font-semibold text-sm mb-1.5 text-foreground">Key Locations</h4>
                    <p className="text-sm text-muted-foreground leading-relaxed">{campaign.location}</p>
                  </div>
                )}
              </div>
            </div>
          </div>
          
          <div className="mt-6 pt-4 border-t border-slate-100 dark:border-slate-800 flex justify-end">
            <CampaignSourceBadge campaign={campaign} />
          </div>
        </div>
      </div>
    </Card>
  );
}

function CampaignSourceBadge({ campaign }: { campaign: CampaignIntelligence }) {
  const sources = campaign.sources?.length ? campaign.sources : (campaign.source ? [campaign.source] : []);
  
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-medium border cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors text-slate-600 dark:text-slate-400 bg-white dark:bg-slate-900 shadow-sm">
          <FileText className="h-3 w-3 mr-1.5" />
          {sources.length > 0 ? (sources.length > 1 ? `${sources.length} Sources` : 'View Source') : 'No verified source'}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-96 p-0 text-sm max-h-[80vh] overflow-y-auto" align="end">
        <div className="p-4 space-y-4">
          {sources.length > 0 ? (
            <>
              <div className="flex items-center justify-between mb-2">
                <span className="font-semibold text-xs uppercase tracking-wider text-muted-foreground block">Source Details</span>
                {campaign.evidenceStatus && (
                  <Badge variant="outline" className="text-[10px] capitalize bg-slate-50 dark:bg-slate-900">{campaign.evidenceStatus.replace(/_/g, ' ')}</Badge>
                )}
              </div>
              
              <div className="space-y-4">
                {sources.map((source, idx) => (
                  <div key={source.id || idx} className="space-y-2 text-xs border-b border-slate-100 dark:border-slate-800 pb-4 last:border-0 last:pb-0">
                    {source.title && (
                      <div className="flex flex-col gap-1">
                        <span className="text-muted-foreground whitespace-nowrap">Title</span>
                        <span className="font-medium" title={source.title}>{source.title}</span>
                      </div>
                    )}
                    {source.publisher && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Publisher</span>
                        <span className="font-medium">{source.publisher}</span>
                      </div>
                    )}
                    {source.publishedAt && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Published</span>
                        <span>{format(new Date(source.publishedAt), 'MMM d, yyyy')}</span>
                      </div>
                    )}
                    {source.retrievedAt && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Retrieved</span>
                        <span>{format(new Date(source.retrievedAt), 'MMM d, yyyy')}</span>
                      </div>
                    )}
                    {source.qualityScore !== undefined && source.qualityScore !== null && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Quality Score</span>
                        <span>{source.qualityScore}/100</span>
                      </div>
                    )}
                    {source.url && (
                      <div className="pt-2 mt-2 flex justify-end">
                        <a href={source.url} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline inline-flex items-center">
                          View Original <ExternalLink className="h-3 w-3 ml-1" />
                        </a>
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <div className="flex justify-between pt-3 border-t border-slate-100 dark:border-slate-800 text-xs">
                <span className="text-muted-foreground">Overall Confidence</span>
                <span className="capitalize font-medium">{campaign.confidence.replace(/_/g, ' ')}</span>
              </div>
            </>
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
                  <span className="capitalize">{campaign.confidence.replace(/_/g, ' ')}</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
