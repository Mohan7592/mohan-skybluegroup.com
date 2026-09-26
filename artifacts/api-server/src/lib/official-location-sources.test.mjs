import assert from "node:assert/strict";
import test from "node:test";
import {
  discoverHisenseOfficialLocations,
  parseHisenseTermsLocationMentions,
} from "./official-location-sources.ts";

function htmlResponse(body) {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function xmlResponse(body = "<urlset />") {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/xml" },
  });
}

test("Hisense store locator candidates preserve official address and source map coordinates", async () => {
  const home = `
    <h1>Hisense UAE Official Store</h1>
    <a href="https://www.shophisense.com/where-to-buy/dubai-hills">Dubai Hills</a>
    <a href="https://www.shophisense.com/where-to-buy/abu-dhabi">Abu Dhabi</a>
    <a href="https://attacker.example/where-to-buy/mall">Untrusted location</a>`;
  const calls = [];
  const fetchImpl = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url === "https://www.shophisense.com/") return htmlResponse(home);
    if (url === "https://hisenseme.com/" || url === "https://www.shophisense.com/deals-promotions") {
      return htmlResponse("<h1>Hisense official information</h1>");
    }
    if (url === "https://hisenseme.com/sitemap.xml") {
      return xmlResponse("<urlset><url><loc>https://hisenseme.com/about-hisense/newsroom-details/hisense-campaign-arena-at-mall-of-the-emirates</loc></url></urlset>");
    }
    if (url === "https://hisenseme.com/about-hisense/support/certificate") return htmlResponse("<h1>Hisense support</h1>");
    if (url === "https://hisenseme.com/about-hisense/newsroom") {
      return htmlResponse('<a href="/about-hisense/newsroom-details/hisense-campaign-arena-at-mall-of-the-emirates">Hisense campaign arena</a>');
    }
    if (url.endsWith("/hisense-campaign-arena-at-mall-of-the-emirates")) {
      return htmlResponse('<meta property="article:published_time" content="2025-06-20"><p>Hisense campaign arena activation at Mall of the Emirates.</p>');
    }
    if (url === "https://www.shophisense.com/where-to-buy/dubai-hills") {
      return htmlResponse(`
        <h1>Dubai Hills</h1>
        <p>Hisense official store information</p>
        <p>FF, Shop #259, Dubai Hills Mall</p>
        <a href="https://www.google.com/maps/dir/?api=1&amp;destination=25.1019412%2C55.2368465">Directions</a>`);
    }
    if (url === "https://www.shophisense.com/where-to-buy/abu-dhabi") {
      return htmlResponse(`
        <h1>Abu Dhabi</h1>
        <p>Hisense official store information</p>
        <p>L1, Shop ＃148, Reem Mall</p>
        <p>Abu Dhabi, UAE</p>
        <a href="https://www.google.com/maps/dir/?api=1&amp;destination=24.4883731%2C54.397811">Directions</a>`);
    }
    throw new Error(`Unexpected network request: ${url}`);
  };

  const candidates = await discoverHisenseOfficialLocations("Hisense client stores UAE", { fetchImpl });
  assert.equal(candidates.length, 3);
  const dubaiHills = candidates.find((candidate) => candidate.name.includes("Dubai Hills"));
  const reemMall = candidates.find((candidate) => candidate.name.includes("Abu Dhabi"));
  const campaignVenue = candidates.find((candidate) => candidate.name.includes("Mall of the Emirates"));
  assert.equal(dubaiHills.address, "FF, Shop #259, Dubai Hills Mall");
  assert.equal(dubaiHills.latitude, 25.1019412);
  assert.equal(dubaiHills.longitude, 55.2368465);
  assert.match(dubaiHills.coordinatesSourceUrl, /destination=25\.1019412/);
  assert.equal(dubaiHills.locationType, "BRAND_STORE");
  assert.equal(dubaiHills.evidenceType, "HISENSE_OFFICIAL_STORE_LOCATOR");
  assert.equal(dubaiHills.evidenceStatus, "OFFICIAL_SOURCE_VERIFIED");
  assert.equal(dubaiHills.confidence, "LIKELY");
  assert.equal(reemMall.address, "L1, Shop ＃148, Reem Mall");
  assert.equal(reemMall.latitude, 24.4883731);
  assert.equal(reemMall.longitude, 54.397811);
  assert.equal(campaignVenue.locationType, "EXHIBITION_VENUE");
  assert.equal(campaignVenue.evidenceType, "HISENSE_OFFICIAL_NEWSROOM");
  assert.equal(campaignVenue.sourceDate, "2025-06-20");
  assert.equal(candidates.some((candidate) => candidate.locationType === "DEALER_DISTRIBUTOR"), false);
  assert.ok(calls.every((url) => !url.includes("attacker.example")));
});

test("Terms PDFs only create candidates when a named branch is tied to a Hisense retail or campaign activity", () => {
  const officialUrl = "https://hisenseme.com/assets/campaign-terms.pdf";
  const accepted = parseHisenseTermsLocationMentions(
    "Hisense promotion is hosted at Times Square Center. Other Hisense terms apply across the UAE.",
    officialUrl,
    "2025-02-27",
  );
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].name, "Hisense location candidate — Times Square Center");
  assert.equal(accepted[0].locationType, "CAMPAIGN_ACTIVATION_LOCATION");
  assert.equal(accepted[0].evidenceType, "HISENSE_OFFICIAL_TERMS_PDF");
  assert.equal(accepted[0].sourceDate, "2025-02-27");
  assert.equal(accepted[0].latitude, null);
  assert.equal(accepted[0].longitude, null);
  assert.equal(accepted[0].confidence, "NEEDS_REVIEW");

  const dealer = parseHisenseTermsLocationMentions(
    "Hisense appointed an official distributor at Times Square Center.",
    officialUrl,
    null,
  );
  assert.equal(dealer.length, 1);
  assert.equal(dealer[0].locationType, "DEALER_DISTRIBUTOR");
  assert.equal(dealer[0].category, "Hisense dealer or distributor");

  const unrelatedBranch = parseHisenseTermsLocationMentions(
    "A general list includes authorised retailers. Hisense terms apply separately. Times Square Center has limited parking.",
    officialUrl,
    null,
  );
  assert.deepEqual(unrelatedBranch, []);
  assert.deepEqual(
    parseHisenseTermsLocationMentions("Hisense campaign held at Times Square.", "https://untrusted.example/terms.pdf", null),
    [],
  );
});

test("official-source scanning extracts linked PDF text through an injected safe extractor", async () => {
  const home = `
    <h1>Hisense UAE Official Store</h1>
    <a href="https://www.shophisense.com/where-to-buy/dubai-hills">Dubai Hills</a>
    <a href="https://www.shophisense.com/where-to-buy/abu-dhabi">Abu Dhabi</a>`;
  const certificate = `
    <h1>Hisense Certificate Download</h1>
    <a href="/assets/campaign-terms.pdf">Terms and Conditions PDF</a>
    <a href="https://attacker.example/exfiltrate.pdf">Terms PDF</a>`;
  const fetchImpl = async (input) => {
    const url = String(input);
    if (url === "https://www.shophisense.com/") return htmlResponse(home);
    if (url === "https://hisenseme.com/" || url === "https://www.shophisense.com/deals-promotions") {
      return htmlResponse("<h1>Hisense official information</h1>");
    }
    if (url === "https://hisenseme.com/sitemap.xml") return xmlResponse();
    if (url === "https://hisenseme.com/about-hisense/support/certificate") return htmlResponse(certificate);
    if (url === "https://hisenseme.com/about-hisense/newsroom") return htmlResponse("<h1>Hisense newsroom</h1>");
    if (url.endsWith("/assets/campaign-terms.pdf")) {
      return new Response(new Uint8Array(Buffer.from("%PDF-1.4")), {
        status: 200,
        headers: { "content-type": "application/pdf" },
      });
    }
    if (url.includes("/where-to-buy/")) {
      const title = url.endsWith("dubai-hills") ? "Dubai Hills" : "Abu Dhabi";
      return htmlResponse(`<h1>${title}</h1><p>Hisense official store information</p>`);
    }
    throw new Error(`Unexpected network request: ${url}`);
  };
  const fetchedPdfTexts = [];
  const candidates = await discoverHisenseOfficialLocations("Hisense promotion", {
    fetchImpl,
    pdfTextExtractor: async (bytes) => {
      fetchedPdfTexts.push(new TextDecoder().decode(bytes));
      return "Hisense promotional event held at Times Square Center.";
    },
  });
  const campaignCandidate = candidates.find((candidate) => candidate.locationType === "CAMPAIGN_ACTIVATION_LOCATION");
  assert.deepEqual(fetchedPdfTexts, ["%PDF-1.4"]);
  assert.equal(campaignCandidate.evidence, "Hisense promotional event held at Times Square Center.");
  assert.equal(campaignCandidate.locationType, "CAMPAIGN_ACTIVATION_LOCATION");
  assert.ok(candidates.every((candidate) => candidate.latitude === null || candidate.longitude === null ||
    candidate.sourceUrl.startsWith("https://www.shophisense.com/where-to-buy/")));
});