import { createHmac, timingSafeEqual } from "node:crypto";

export type BrandOptionSelection = {
  kind: "company" | "brand" | "category";
  name: string;
  parent: string | null;
  category: string | null;
  website: string;
  sourceUrl: string;
  evidenceQuote: string;
  regionalEntity?: RegionalEntityEvidence | null;
};
export type RegionalEntityEvidence = {
  name: string;
  sourceUrl: string;
  evidenceQuote: string;
};
type RegionalEntityCandidate = {
  kind: BrandOptionSelection["kind"];
  name: string;
  category?: string | null;
  regionalEntity?: RegionalEntityEvidence | null;
};
type RegionalEntitySource = { url: string; title: string; text: string };
export type BrandSelection = { query: string; option: BrandOptionSelection; expiresAt: number };

const TOKEN_TTL_MS = 30 * 60 * 1000;
const TOKEN_VERSION = 1;
const regionalJurisdictionPattern =
  /\b(?:UAE|United Arab Emirates|Dubai|Abu Dhabi|Sharjah|Gulf|Middle East|MENA|GCC|Qatar|Bahrain|Kuwait|Oman|Saudi Arabia)\b/i;
const regionalLegalEntityPattern =
  /\b(?:FZE|FZCO|FZ-LLC|DMCC|PJSC|LLC|L\.L\.C\.|LTD|LIMITED|INC|PLC|LLP|JSC|ESTABLISHMENT|BRANCH|LEGAL ENTITY|TRADING ENTITY|REGISTERED|REGISTRATION|LICENSED|LICENCED)\b/i;

function normalizedEvidenceContains(text: string, value: string): boolean {
  const normalizedText = ` ${text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim()} `;
  const normalizedValue = value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();
  return !!normalizedValue && normalizedText.includes(` ${normalizedValue} `);
}

function sameOfficialHost(leftUrl: string, rightUrl: string): boolean {
  try {
    const hostname = (url: string) => new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return hostname(leftUrl) === hostname(rightUrl);
  } catch {
    return false;
  }
}

export function validateRegionalEntityEvidence(
  option: BrandOptionSelection,
  extractions: RegionalEntityCandidate[],
  sources: RegionalEntitySource[],
): RegionalEntityEvidence | null {
  const sourceByUrl = new Map(sources.map((source) => [source.url, source]));
  for (const extraction of extractions) {
    const appliesToOption = (extraction.kind === option.kind && extraction.name.toLowerCase() === option.name.toLowerCase()) ||
      (option.kind === "category" &&
        (extraction.category?.toLowerCase() === option.name.toLowerCase() ||
          (extraction.kind === "category" && extraction.name.toLowerCase() === option.name.toLowerCase())));
    const entity = extraction.regionalEntity;
    if (!appliesToOption || !entity || entity.name.trim().length < 2 || entity.name.length > 180 ||
      entity.evidenceQuote.length < 12 || entity.evidenceQuote.length > 700) continue;
    const source = sourceByUrl.get(entity.sourceUrl);
    if (!source || !sameOfficialHost(source.url, option.sourceUrl) ||
      !(source.text.includes(entity.evidenceQuote) || source.title === entity.evidenceQuote) ||
      !normalizedEvidenceContains(entity.evidenceQuote, entity.name) ||
      !normalizedEvidenceContains(entity.evidenceQuote, option.name) ||
      !regionalJurisdictionPattern.test(entity.evidenceQuote) ||
      !regionalLegalEntityPattern.test(`${entity.name} ${entity.evidenceQuote}`)) continue;
    return {
      name: entity.name.trim(),
      sourceUrl: source.url,
      evidenceQuote: entity.evidenceQuote,
    };
  }
  return null;
}

function signingSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("Brand selection signing is unavailable because SESSION_SECRET is not configured");
  }
  return secret;
}

function signature(payload: string): Buffer {
  return createHmac("sha256", signingSecret()).update(payload).digest();
}

export function createBrandSelectionToken(query: string, option: BrandOptionSelection): string {
  const payload = Buffer.from(JSON.stringify({
    v: TOKEN_VERSION,
    query,
    option,
    expiresAt: Date.now() + TOKEN_TTL_MS,
  } satisfies BrandSelection & { v: number }), "utf8").toString("base64url");
  return `${payload}.${signature(payload).toString("base64url")}`;
}

export function verifyBrandSelectionToken(token: string): BrandSelection {
  const [payload, encodedSignature, extra] = token.split(".");
  if (!payload || !encodedSignature || extra) throw new Error("Invalid or expired brand selection token");
  const expected = signature(payload);
  let received: Buffer;
  try {
    received = Buffer.from(encodedSignature, "base64url");
  } catch {
    throw new Error("Invalid or expired brand selection token");
  }
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new Error("Invalid or expired brand selection token");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid or expired brand selection token");
  }
  if (!decoded || typeof decoded !== "object") throw new Error("Invalid or expired brand selection token");
  const selection = decoded as Partial<BrandSelection> & { v?: unknown };
  if (selection.v !== TOKEN_VERSION || typeof selection.query !== "string" ||
    typeof selection.expiresAt !== "number" || selection.expiresAt <= Date.now() ||
    !selection.option || !["company", "brand", "category"].includes(selection.option.kind) ||
    typeof selection.option.name !== "string" || typeof selection.option.website !== "string" ||
    typeof selection.option.sourceUrl !== "string" || typeof selection.option.evidenceQuote !== "string" ||
    !(selection.option.parent === null || typeof selection.option.parent === "string") ||
    !(selection.option.category === null || typeof selection.option.category === "string") ||
    (selection.option.regionalEntity !== undefined &&
      selection.option.regionalEntity !== null &&
      (typeof selection.option.regionalEntity !== "object" ||
        typeof selection.option.regionalEntity.name !== "string" ||
        typeof selection.option.regionalEntity.sourceUrl !== "string" ||
        typeof selection.option.regionalEntity.evidenceQuote !== "string"))) {
    throw new Error("Invalid or expired brand selection token");
  }
  const { v: _version, ...result } = selection;
  return result as BrandSelection;
}