import { useQueryClient } from "@tanstack/react-query";
import {
  ClaimReviewInputDecision,
  IntelligenceClaim,
  getGetProjectIntelligenceQueryKey,
  getListProjectResearchRunsQueryKey,
  getListResearchClaimReviewsQueryKey,
  useListResearchClaimReviews,
  useReviewResearchClaim,
} from "@workspace/api-client-react";
import { AlertCircle, ExternalLink, History, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { format } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

const decisions: { value: ClaimReviewInputDecision; label: string; variant: "default" | "outline" | "secondary" }[] = [
  { value: "approved", label: "Approve", variant: "default" },
  { value: "rejected", label: "Reject", variant: "outline" },
  { value: "needs_review", label: "Needs Review", variant: "secondary" },
];

const isHttpsUrl = (value: string) => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};

export function ClaimReviewPanel({ projectId, claims }: { projectId: string; claims: IntelligenceClaim[] }) {
  const reviewableClaims = claims.filter((claim) => !claim.isDemo);

  return (
    <Card className="shadow-sm border-slate-200 dark:border-slate-800">
      <CardHeader className="pb-3">
        <CardTitle className="text-lg">Evidence Review</CardTitle>
        <p className="text-sm text-muted-foreground">
          Record an auditable decision without changing the original sourced claim.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {reviewableClaims.length ? reviewableClaims.map((claim) => (
          <ClaimReviewItem key={claim.id} projectId={projectId} claim={claim} />
        )) : (
          <p className="py-5 text-center text-sm text-muted-foreground">
            No sourced claims are available for review yet.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function ClaimReviewItem({ projectId, claim }: { projectId: string; claim: IntelligenceClaim }) {
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceQuote, setSourceQuote] = useState(() => {
    const methodology = claim.methodology || "";
    return methodology.startsWith("Source-exact excerpt:")
      ? methodology.replace("Source-exact excerpt:", "").trim()
      : "";
  });
  const [researchNote, setResearchNote] = useState("");
  const review = useReviewResearchClaim();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const historyQuery = useListResearchClaimReviews(projectId, claim.id, {
    query: {
      enabled: !!projectId && !!claim.id,
      queryKey: getListResearchClaimReviewsQueryKey(projectId, claim.id),
    },
  });

  const submitReview = (decision: ClaimReviewInputDecision) => {
    review.mutate({
      id: projectId,
      claimId: claim.id,
      data: {
        decision,
        ...(sourceUrl.trim() ? { additionalSourceUrl: sourceUrl.trim() } : {}),
        ...(researchNote.trim() ? { researchNote: researchNote.trim() } : {}),
        ...(decision === "approved" ? { sourceQuote: sourceQuote.trim() } : {}),
      },
    }, {
      onSuccess: () => {
        setSourceUrl("");
        setSourceQuote("");
        setResearchNote("");
        toast({ title: "Claim review recorded" });
        queryClient.invalidateQueries({ queryKey: getGetProjectIntelligenceQueryKey(projectId) });
        queryClient.invalidateQueries({ queryKey: getListProjectResearchRunsQueryKey(projectId) });
        queryClient.invalidateQueries({ queryKey: getListResearchClaimReviewsQueryKey(projectId, claim.id) });
      },
    });
  };
  const hasInvalidSourceUrl = !!sourceUrl.trim() && !isHttpsUrl(sourceUrl.trim());

  return (
    <article className="rounded-lg border p-4" data-testid={`claim-review-${claim.id}`}>
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <Badge variant="outline" className="capitalize">{claim.status.replace(/_/g, " ")}</Badge>
        <Badge variant="secondary" className="capitalize">{claim.claimType.replace(/_/g, " ")}</Badge>
        <span className="text-xs text-muted-foreground">{claim.category.replace(/[._]/g, " ")}</span>
      </div>
      <p className="text-sm font-medium leading-relaxed" data-testid={`text-claim-${claim.id}`}>{claim.claim}</p>
      {claim.source && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>{claim.source.title}</span>
          {claim.source.publisher && <span>• {claim.source.publisher}</span>}
          {claim.source.url && (
            <a href={claim.source.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center text-brand hover:underline">
              Source <ExternalLink className="h-3 w-3 ml-1" />
            </a>
          )}
        </div>
      )}

      <div className="mt-4">
        <label htmlFor={`review-quote-${claim.id}`} className="text-xs font-medium text-muted-foreground">
          Exact passage from the original source
        </label>
        <Textarea
          id={`review-quote-${claim.id}`}
          value={sourceQuote}
          onChange={(event) => setSourceQuote(event.target.value)}
          placeholder="Paste the exact, contiguous passage from the original source (at least 20 characters)."
          maxLength={4000}
          className="mt-1 min-h-20"
          data-testid={`input-review-quote-${claim.id}`}
        />
        <p className="mt-1 text-xs text-muted-foreground">
          Approve requires at least 20 characters. Approval verifies this exact passage against the claim’s original source. An additional URL is supplemental only and does not prove the claim.
        </p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
        <div>
          <label htmlFor={`review-source-${claim.id}`} className="text-xs font-medium text-muted-foreground">Supplemental source URL (optional)</label>
          <Input
            id={`review-source-${claim.id}`}
            type="url"
            value={sourceUrl}
            onChange={(event) => setSourceUrl(event.target.value)}
            placeholder="https://example.com/source"
            maxLength={2048}
            className="mt-1"
            data-testid={`input-review-source-${claim.id}`}
          />
          <p className="mt-1 text-xs text-muted-foreground">Only HTTPS links are accepted; this link is not a substitute for the passage above.</p>
          {hasInvalidSourceUrl && <p className="mt-1 text-xs text-destructive">Enter a valid HTTPS URL.</p>}
        </div>
        <div>
          <label htmlFor={`review-note-${claim.id}`} className="text-xs font-medium text-muted-foreground">Separate research note (optional)</label>
          <Textarea
            id={`review-note-${claim.id}`}
            value={researchNote}
            onChange={(event) => setResearchNote(event.target.value)}
            placeholder="Add context for this review; the sourced claim remains unchanged."
            className="mt-1 min-h-10"
            data-testid={`input-review-note-${claim.id}`}
          />
        </div>
      </div>

      {review.isError && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive" role="alert">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>
            Review could not be saved. {review.error instanceof Error ? review.error.message : "Check the URL and try again."}
          </span>
        </div>
      )}
      <div className="flex flex-wrap gap-2 mt-3">
        {decisions.map(({ value, label, variant }) => (
          <Button
            key={value}
            size="sm"
            variant={variant}
            disabled={
              review.isPending ||
              hasInvalidSourceUrl ||
              (value === "approved" && (sourceQuote.trim().length < 20 || !claim.source?.url))
            }
            onClick={() => submitReview(value)}
            data-testid={`button-${value.replace(/_/g, "-")}-${claim.id}`}
          >
            {label}
          </Button>
        ))}
      </div>
      {!claim.source?.url && (
        <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
          Approval is unavailable because this claim has no original source URL to verify against.
        </p>
      )}

      <div className="mt-4 pt-3 border-t">
        <h4 className="flex items-center text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
          <History className="h-3.5 w-3.5 mr-1.5" /> Audit history
        </h4>
        {historyQuery.isLoading ? (
          <p className="text-xs text-muted-foreground">Loading review history…</p>
        ) : historyQuery.isError ? (
          <p className="text-xs text-destructive">Review history could not be loaded.</p>
        ) : historyQuery.data?.length ? (
          <ol className="space-y-2">
            {historyQuery.data.map((entry) => (
              <li key={entry.id} className="rounded-md bg-slate-50 dark:bg-slate-950/50 px-3 py-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={entry.decision === "approved" ? "secondary" : "outline"} className="capitalize">
                    {entry.decision.replace(/_/g, " ")}
                  </Badge>
                  <span className="text-muted-foreground">{format(new Date(entry.reviewedAt), "MMM d, yyyy h:mm a")}</span>
                  {entry.verifiedSourceTitle && <span>{entry.verifiedSourceTitle}</span>}
                </div>
                <p className="mt-1 text-muted-foreground">Original claim: {entry.originalClaim}</p>
                {entry.researchNote && <p className="mt-1">Research note: {entry.researchNote}</p>}
                {entry.sourceQuote && <p className="mt-1">Verified passage: “{entry.sourceQuote}”</p>}
                {entry.additionalSourceUrl && (
                  <a href={entry.additionalSourceUrl} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center text-brand hover:underline">
                    {entry.additionalSourceUrl} <ExternalLink className="h-3 w-3 ml-1" />
                  </a>
                )}
                {entry.sourceVerifiedAt && (
                  <p className="mt-1 flex items-center text-emerald-700 dark:text-emerald-400">
                    <ShieldCheck className="h-3 w-3 mr-1" /> Additional source verified
                  </p>
                )}
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-xs text-muted-foreground">No reviews recorded yet.</p>
        )}
      </div>
    </article>
  );
}