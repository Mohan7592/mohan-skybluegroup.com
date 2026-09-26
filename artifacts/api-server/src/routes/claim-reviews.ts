import { lookup as dnsLookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { request as httpsRequest } from "node:https";
import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import {
  ClaimReview,
  ListResearchClaimReviewsParams,
  ListResearchClaimReviewsResponse,
  ReviewResearchClaimBody,
  ReviewResearchClaimParams,
  ReviewResearchClaimResponse,
} from "@workspace/api-zod";
import { claimReviewsTable, db, researchClaimsTable, sourcesTable } from "@workspace/db";
import { loadProjectContext } from "../lib/research";

const router: IRouter = Router();

function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return a !== 0 && a !== 10 && a !== 127 && a < 224 &&
      !(a === 169 && b === 254) && !(a === 172 && b! >= 16 && b! <= 31) &&
      !(a === 192 && (b === 0 || b === 2 || b === 88 && c === 99 || b === 168)) &&
      !(a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)) &&
      !(a === 203 && b === 0 && c === 113) &&
      !(a === 100 && b! >= 64 && b! <= 127);
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith("::ffff:")) return false;
    const firstBlock = Number.parseInt(normalized.split(":")[0] || "0", 16);
    return firstBlock >= 0x2000 && firstBlock <= 0x3fff &&
      !normalized.startsWith("2001:db8:");
  }
  return false;
}

async function verifyPublicHttpsUrl(rawUrl: string): Promise<{
  title: string;
  publisher: string;
  publishedAt: Date | null;
  url: string;
  pageText: string;
}> {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" || url.username || url.password ||
      (url.port && url.port !== "443") || url.hostname.endsWith(".")) {
    throw new Error("Additional source must be a public HTTPS URL without credentials or a nonstandard port");
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error("Additional source host is not publicly routable");
  }
  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await dnsLookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error("Additional source host resolves to a non-public address");
  }
  const address = addresses[0]!;
  const family = isIP(address.address);
  const pinnedLookup: LookupFunction = (_host, options, callback) => {
    if (options.all) {
      callback(null, [{ address: address.address, family }]);
      return;
    }
    callback(null, address.address, family);
  };
  const { status, contentType, html } = await new Promise<{
    status: number;
    contentType: string;
    html: string;
  }>((resolve, reject) => {
    let settled = false;
    const settle = (result: { status: number; contentType: string; html: string }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const request = httpsRequest(url, {
      lookup: pinnedLookup,
      timeout: 8000,
      headers: { Accept: "text/html,application/xhtml+xml" },
    }, (response) => {
      const status = response.statusCode ?? 0;
      const contentType = response.headers["content-type"] ?? "";
      let html = "";
      response.on("data", (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const remaining = 64000 - html.length;
        html += bytes.subarray(0, remaining).toString("utf8");
        if (html.length >= 64000) {
          response.destroy();
          settle({ status, contentType, html });
        }
      });
      response.on("end", () => settle({ status, contentType, html }));
      response.on("error", (error) => {
        if (!settled) reject(error);
      });
    });
    request.on("timeout", () => request.destroy(new Error("Additional source request timed out")));
    request.on("error", (error) => {
      if (!settled) reject(error);
    });
    request.end();
  });
  if (status < 200 || status >= 300) {
    throw new Error(`Additional source could not be verified (HTTP ${status})`);
  }
  if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
    throw new Error("Additional source must return an HTML page");
  }
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
    ?.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim() || hostname;
  const pageText = html
    .replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
  const publishedValue =
    html.match(/(?:property|name)=["'](?:article:published_time|datePublished|pubdate)["'][^>]*content=["']([^"']+)/i)?.[1] ??
    html.match(/content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:article:published_time|datePublished|pubdate)/i)?.[1];
  const parsedPublished = publishedValue ? new Date(publishedValue) : null;
  return {
    title: title.slice(0, 300),
    publisher: hostname,
    publishedAt: parsedPublished && !Number.isNaN(parsedPublished.getTime()) ? parsedPublished : null,
    url: url.toString(),
    pageText,
  };
}

function normalizeExactQuote(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

router.post("/projects/:id/claims/:claimId/review", async (req, res): Promise<void> => {
  const params = ReviewResearchClaimParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid project or claim ID" });
    return;
  }
  const body = ReviewResearchClaimBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const project = await loadProjectContext(params.data.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const [claim] = await db.select().from(researchClaimsTable).where(and(
    eq(researchClaimsTable.id, params.data.claimId),
    eq(researchClaimsTable.projectId, project.id),
  ));
  if (!claim) {
    res.status(404).json({ error: "Claim not found in this project" });
    return;
  }

  let verified: Awaited<ReturnType<typeof verifyPublicHttpsUrl>> | null = null;
  if (body.data.additionalSourceUrl) {
    try {
      verified = await verifyPublicHttpsUrl(body.data.additionalSourceUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Additional source verification failed";
      res.status(422).json({ error: message });
      return;
    }
  }
  let quoteVerifiedAt: Date | null = null;
  if (body.data.decision === "approved") {
    const [primarySource] = claim.sourceId ? await db.select().from(sourcesTable)
      .where(eq(sourcesTable.id, claim.sourceId)) : [];
    if (!primarySource?.url || !primarySource.publisher || !primarySource.publishedAt ||
        !primarySource.retrievedAt || !body.data.sourceQuote) {
      res.status(422).json({
        error: "Approval requires the claim's original dated source and an exact supporting passage from that source; choose needs_review otherwise",
      });
      return;
    }
    try {
      const originalPage = await verifyPublicHttpsUrl(primarySource.url);
      const quote = normalizeExactQuote(body.data.sourceQuote);
      if (quote.length < 20 || !normalizeExactQuote(originalPage.pageText).includes(quote)) {
        res.status(422).json({
          error: "The quoted passage was not found verbatim in the claim's original source; choose needs_review",
        });
        return;
      }
      quoteVerifiedAt = new Date();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Original source verification failed";
      res.status(422).json({ error: `Original dated source could not validate the quote: ${message}` });
      return;
    }
  }

  const [review] = await db.transaction(async (tx) => {
    const [verifiedSource] = verified ? await tx.insert(sourcesTable).values({
      researchRunId: claim.researchRunId,
      title: verified.title,
      url: verified.url,
      publisher: verified.publisher,
      publishedAt: verified.publishedAt,
      geography: claim.geography,
      sourceKind: "human_review_additional_source",
      retrievedAt: new Date(),
    }).returning() : [];
    return tx.insert(claimReviewsTable).values({
      projectId: project.id,
      claimId: claim.id,
      decision: body.data.decision,
      researchNote: body.data.researchNote ?? null,
      additionalSourceUrl: verified?.url ?? null,
      verifiedSourceId: verifiedSource?.id ?? null,
      verifiedSourceTitle: verified?.title ?? null,
      verifiedSourcePublisher: verified?.publisher ?? null,
      verifiedSourcePublishedAt: verified?.publishedAt ?? null,
      sourceVerifiedAt: verified ? new Date() : null,
      sourceQuote: body.data.sourceQuote ?? null,
      quoteVerifiedAt,
      originalClaim: claim.claim,
    }).returning();
  });
  res.status(201).json(ReviewResearchClaimResponse.parse(review));
});

router.get("/projects/:id/claims/:claimId/reviews", async (req, res): Promise<void> => {
  const params = ListResearchClaimReviewsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid project or claim ID" });
    return;
  }
  const project = await loadProjectContext(params.data.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const [claim] = await db.select({ id: researchClaimsTable.id })
    .from(researchClaimsTable).where(and(
      eq(researchClaimsTable.id, params.data.claimId),
      eq(researchClaimsTable.projectId, project.id),
    ));
  if (!claim) {
    res.status(404).json({ error: "Claim not found in this project" });
    return;
  }
  const history = await db.select().from(claimReviewsTable).where(and(
    eq(claimReviewsTable.projectId, project.id),
    eq(claimReviewsTable.claimId, claim.id),
  )).orderBy(desc(claimReviewsTable.reviewedAt));
  res.json(ListResearchClaimReviewsResponse.parse(history as ClaimReview[]));
});

export default router;