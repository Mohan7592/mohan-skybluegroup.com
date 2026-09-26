import assert from "node:assert/strict";
import test from "node:test";
import {
  buildInitialBrandOptionSearchQueries,
  categoryOptionsFromVerifiedHomepage,
  companyOptionFromVerifiedHomepage,
  companyIdentityNameMatchesQuery,
  groupFirstPartySources,
  interleaveSearchCitations,
  isProductPageSource,
  sameRegistrableDomain,
  validateBrandOptionExtractions,
  validateBrandOptionExtractionsDetailed,
} from "./brand-options-rules.ts";

function source(url, text, title = "Company portfolio") {
  return {
    title,
    url,
    publisher: new URL(url).hostname,
    text,
    publishedAt: null,
    retrievedAt: new Date("2025-01-01T00:00:00.000Z"),
    qualityScore: 50,
    sourceKind: "secondary",
    accessible: true,
  };
}

test("initial search queries cover global, regional, and company/brand disambiguation", () => {
  const queries = buildInitialBrandOptionSearchQueries("Max");
  assert.equal(queries.length, 3, "initial query work is deliberately bounded");
  assert.ok(queries.some((query) => /global/i.test(query)));
  assert.ok(queries.some((query) => /UAE|Middle East/i.test(query)));
  assert.ok(queries.some((query) => /our brands/i.test(query)));
});

test("initial citations are interleaved across query variants before deeper results", () => {
  const results = [
    { citations: [{ url: "a1" }, { url: "a2" }, { url: "a3" }] },
    { citations: [{ url: "b1" }, { url: "b2" }, { url: "b3" }] },
    { citations: [{ url: "c1" }, { url: "c2" }, { url: "c3" }] },
  ];
  assert.deepEqual(
    interleaveSearchCitations(results, 6).map(({ url }) => url),
    ["a1", "b1", "c1", "a2", "b2", "c2"],
  );
});

test("company identity must begin with the entered name as a complete normalized token", () => {
  assert.equal(companyIdentityNameMatchesQuery("Max", "Max Fashion"), true);
  assert.equal(companyIdentityNameMatchesQuery("ITC", "ITC Ltd"), true);
  assert.equal(companyIdentityNameMatchesQuery("Max", "Lifestyle Int Pvt Ltd"), false);
  assert.equal(companyIdentityNameMatchesQuery("Max", "Maxwell Retail"), false);
});

test("company options reject unrelated names and product-page identity evidence", () => {
  const unrelatedPage = source(
    "https://www.maxfashion.in/products/lifestyle",
    "Lifestyle Int Pvt Ltd is a fashion company.",
    "Lifestyle blouse",
  );
  const productPage = source(
    "https://www.maxfashion.in/products/max-dress",
    "Max Fashion is a global retailer. Add to bag. Select size.",
    "Max Fashion dress online",
  );
  assert.equal(isProductPageSource(productPage), true);
  const { options, counts } = validateBrandOptionExtractionsDetailed("Max", [unrelatedPage, productPage], [
    {
      kind: "company",
      name: "Lifestyle Int Pvt Ltd",
      parent: null,
      category: null,
      sourceUrl: unrelatedPage.url,
      evidenceQuote: "Lifestyle Int Pvt Ltd is a fashion company.",
      parentEvidenceUrl: null,
      parentEvidenceQuote: null,
      categoryEvidenceQuote: null,
    },
    {
      kind: "company",
      name: "Max Fashion",
      parent: null,
      category: null,
      sourceUrl: productPage.url,
      evidenceQuote: "Max Fashion is a global retailer.",
      parentEvidenceUrl: null,
      parentEvidenceQuote: null,
      categoryEvidenceQuote: null,
    },
  ]);
  assert.deepEqual(options, []);
  assert.equal(counts.rejectedCompanyIdentity, 1);
  assert.equal(counts.rejectedCompanyProductPage, 1);
});

test("first-party source groups preserve multiple candidate companies and reject lookalikes/hosted domains", () => {
  const sources = [
    source("https://www.maxfashion.com/brands", "Max Fashion - Our brands"),
    source("https://www.max.com/about", "Max is a company offering products."),
    source("https://max.fake-domain.com/brands", "Max's brands include examples."),
    source("https://max.blogspot.com/brands", "Max's brands include examples."),
    source("https://www.example.com/about", "Max is a company offering products."),
  ];
  const groups = groupFirstPartySources("Max", sources);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((group) => new URL(group[0].url).hostname).sort(), [
    "www.max.com",
    "www.maxfashion.com",
  ]);
  assert.equal(sameRegistrableDomain("https://portfolio.maxfashion.com/brands", "https://maxfashion.com"), true);
  assert.equal(sameRegistrableDomain("https://maxfashion.fake-site.com/brands", "https://maxfashion.com"), false);
});

test("verified official regional hosts may group on exact title/body identity, but unverified hosts stay rejected", () => {
  const regional = source(
    "https://www.hisense-regional.example/about",
    "Explore our television products and customer support.",
    "Hisense — Official company website",
  );
  const unrelatedRegional = source(
    "https://www.hisense-uae.example/about",
    "Explore our television products and customer support.",
    "Hisense — Official company website",
  );
  const inaccessible = {
    ...regional,
    url: "https://www.hisense-regional.example/brands",
    accessible: false,
  };

  assert.deepEqual(groupFirstPartySources("Hisense", [regional]), []);
  const groups = groupFirstPartySources("Hisense", [regional, unrelatedRegional, inaccessible], [
    "hisense-regional.example",
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].map(({ url }) => url), [regional.url]);
  assert.equal(groupFirstPartySources("Hisense", [unrelatedRegional], []).length, 0);
});

test("verified official homepage yields title-backed company and explicit category options", () => {
  const title = "Hisense Middle East | Smart TVs, Home Appliances & Electronics";
  const homepage = source(
    "https://www.hisenseme.com/",
    `${title} Hisense Middle East offers home appliances and electronics.`,
    title,
  );
  const option = companyOptionFromVerifiedHomepage("Hisense", homepage, "hisenseme.com");
  assert.deepEqual(option, {
    kind: "company",
    name: "Hisense Middle East",
    parent: null,
    category: null,
    website: "https://hisenseme.com",
    sourceUrl: homepage.url,
    evidenceQuote: title,
    regionalEntity: null,
  });
  const categoryOptions = categoryOptionsFromVerifiedHomepage(option, homepage);
  assert.deepEqual(categoryOptions.map((category) => ({
    kind: category.kind,
    name: category.name,
    parent: category.parent,
    category: category.category,
    sourceUrl: category.sourceUrl,
    evidenceQuote: category.evidenceQuote,
    regionalEntity: category.regionalEntity,
  })), [
    {
      kind: "category",
      name: "Smart TVs",
      parent: "Hisense Middle East",
      category: null,
      sourceUrl: homepage.url,
      evidenceQuote: title,
      regionalEntity: null,
    },
    {
      kind: "category",
      name: "Home Appliances",
      parent: "Hisense Middle East",
      category: null,
      sourceUrl: homepage.url,
      evidenceQuote: title,
      regionalEntity: null,
    },
    {
      kind: "category",
      name: "Electronics",
      parent: "Hisense Middle East",
      category: null,
      sourceUrl: homepage.url,
      evidenceQuote: title,
      regionalEntity: null,
    },
  ]);
  assert.ok(categoryOptions.every((category) => category.website === option.website));
  assert.equal(companyOptionFromVerifiedHomepage("Hisense", {
    ...homepage,
    url: "https://www.hisense-uae.example/",
  }, "hisenseme.com"), null, "an unrelated regional host cannot inherit the verified hint");
  assert.equal(companyOptionFromVerifiedHomepage("Hisense", {
    ...homepage,
    accessible: false,
  }, "hisenseme.com"), null, "the direct path requires a successfully fetched page");
  assert.equal(companyOptionFromVerifiedHomepage("Hisense", {
    ...homepage,
    url: "http://www.hisenseme.com/",
  }, "hisenseme.com"), null, "the direct path never downgrades TLS");
  assert.equal(companyOptionFromVerifiedHomepage("Hisense", {
    ...homepage,
    text: "Only an unrelated product page.",
  }, "hisenseme.com"), null, "the displayed evidence must be present verbatim in fetched content");
  const noDelimiter = {
    ...homepage,
    title: "Hisense Middle East Smart TVs Home Appliances Electronics",
    text: "Hisense Middle East Smart TVs Home Appliances Electronics",
  };
  assert.equal(companyOptionFromVerifiedHomepage("Hisense", noDelimiter, "hisenseme.com"), null);
  assert.deepEqual(categoryOptionsFromVerifiedHomepage(option, noDelimiter), [],
    "without an exact identity/category delimiter, no categories are inferred");
  const slogan = {
    ...homepage,
    title: "Hisense Middle East | Discover a better tomorrow",
    text: "Hisense Middle East | Discover a better tomorrow",
  };
  const sloganCompany = companyOptionFromVerifiedHomepage("Hisense", slogan, "hisenseme.com");
  assert.ok(sloganCompany);
  assert.deepEqual(categoryOptionsFromVerifiedHomepage(sloganCompany, slogan),
    [], "marketing slogans do not become category options");
});

test("brand parent can be evidenced separately from the exact brand-name quote across same-domain pages", () => {
  const companyPage = source(
    "https://www.unilever.com/about",
    "Unilever PLC is a global consumer goods company.",
    "About Unilever",
  );
  const portfolioPage = source(
    "https://www.unilever.com/brands",
    "Unilever's brands include Dove and Knorr.",
    "Unilever brand portfolio",
  );
  const page = source(
    "https://www.unilever.com/brands/dove",
    "Dove is a personal care brand.",
  );
  const options = validateBrandOptionExtractions("Unilever", [companyPage, portfolioPage, page], [
    {
      kind: "company",
      name: "Unilever",
      parent: null,
      category: null,
      sourceUrl: companyPage.url,
      evidenceQuote: "Unilever PLC is a global consumer goods company.",
      parentEvidenceUrl: null,
      parentEvidenceQuote: null,
      categoryEvidenceQuote: null,
    },
    {
      kind: "brand",
      name: "Dove",
      parent: "Unilever",
      category: "Personal care",
      sourceUrl: page.url,
      evidenceQuote: "Dove is a personal care brand.",
      parentEvidenceUrl: portfolioPage.url,
      parentEvidenceQuote: "Unilever's brands include Dove and Knorr.",
      categoryEvidenceQuote: "Dove is a personal care brand.",
    },
  ]);
  assert.equal(options.find((option) => option.kind === "brand")?.parent, "Unilever");
  assert.equal(options.find((option) => option.kind === "brand")?.category, "Personal care");
  assert.ok(options.some((option) => option.kind === "category" && option.name === "Personal care" && option.parent === "Unilever"));
});

test("a validated company's entered short name can identify its portfolio in an exact quote", () => {
  const companyPage = source("https://itcportal.com/about-itc", "ITC Limited is a diversified company.", "About ITC Limited");
  const portfolioPage = source("https://itcportal.com/brands", "ITC's brands include Aashirvaad and Sunfeast.", "ITC brand portfolio");
  const brandPage = source("https://itcportal.com/brands/aashirvaad", "Aashirvaad is a packaged food brand.");
  const options = validateBrandOptionExtractions("ITC", [companyPage, portfolioPage, brandPage], [
    {
      kind: "company", name: "ITC Limited", parent: null, category: null,
      sourceUrl: companyPage.url, evidenceQuote: companyPage.text,
      parentEvidenceUrl: null, parentEvidenceQuote: null, categoryEvidenceQuote: null,
    },
    {
      kind: "brand", name: "Aashirvaad", parent: "ITC Limited", category: null,
      sourceUrl: brandPage.url, evidenceQuote: brandPage.text,
      parentEvidenceUrl: portfolioPage.url, parentEvidenceQuote: portfolioPage.text, categoryEvidenceQuote: null,
    },
  ]);
  assert.ok(options.some((option) => option.kind === "brand" && option.name === "Aashirvaad"));
});

test("an official child-brand page title can recover a brand when structured extraction omits it", () => {
  const companyPage = source("https://www.unilever.com/about", "Unilever is a consumer goods company.", "About Unilever");
  const dovePage = source("https://www.unilever.com/brands/beauty-wellbeing/dove/", "Dove | Unilever Dove makes beauty products.", "Dove | Unilever");
  const unrelatedPage = source("https://www.unilever.com/news/something/", "News | Unilever", "News | Unilever");
  const categoryPage = source("https://www.unilever.com/brands/foods/", "Foods | Unilever", "Foods | Unilever");
  const options = validateBrandOptionExtractions("Unilever", [companyPage, dovePage, unrelatedPage, categoryPage], [{
    kind: "company", name: "Unilever", parent: null, category: null,
    sourceUrl: companyPage.url, evidenceQuote: companyPage.text,
    parentEvidenceUrl: null, parentEvidenceQuote: null, categoryEvidenceQuote: null,
  }]);
  assert.ok(options.some((option) => option.kind === "brand" && option.name === "Dove" && option.parent === "Unilever"));
  assert.ok(!options.some((option) => option.name === "News"));
  assert.ok(!options.some((option) => option.kind === "brand" && option.name === "Foods"));
});

test("brands without explicit parent portfolio context are rejected and unsupported categories are dropped", () => {
  const page = source(
    "https://www.itcportal.com/brands",
    "Aashirvaad is one of the brands listed. ITC is a diversified company.",
  );
  const options = validateBrandOptionExtractions("ITC", [page], [
    {
      kind: "company",
      name: "ITC",
      parent: null,
      category: null,
      sourceUrl: page.url,
      evidenceQuote: "ITC is a diversified company.",
      parentEvidenceUrl: null,
      parentEvidenceQuote: null,
      categoryEvidenceQuote: null,
    },
    {
      kind: "brand",
      name: "Aashirvaad",
      parent: "ITC",
      category: "Foods",
      sourceUrl: page.url,
      evidenceQuote: "Aashirvaad is one of the brands listed.",
      parentEvidenceUrl: null,
      parentEvidenceQuote: null,
      categoryEvidenceQuote: "Aashirvaad is one of the brands listed.",
    },
  ]);
  assert.equal(options.some((option) => option.kind === "brand"), false);
  const noCompanyOption = validateBrandOptionExtractions("ITC", [page], [{
    kind: "brand",
    name: "Aashirvaad",
    parent: "ITC",
    category: null,
    sourceUrl: page.url,
    evidenceQuote: "Aashirvaad is one of the brands listed.",
    parentEvidenceUrl: page.url,
    parentEvidenceQuote: "ITC is a diversified company.",
    categoryEvidenceQuote: null,
  }]);
  assert.deepEqual(noCompanyOption, [], "a company option is never fabricated from a brand mention");

  const supported = source(
    "https://www.itcportal.com/brands",
    "Aashirvaad is one of our brands. ITC's brands include Aashirvaad. Aashirvaad is a foods brand.",
  );
  const optionsWithSupportedParent = validateBrandOptionExtractions("ITC", [supported], [
    {
      kind: "company",
      name: "ITC",
      parent: null,
      category: null,
      sourceUrl: supported.url,
      evidenceQuote: "ITC's brands include Aashirvaad.",
      parentEvidenceUrl: null,
      parentEvidenceQuote: null,
      categoryEvidenceQuote: null,
    },
    {
      kind: "brand",
      name: "Aashirvaad",
      parent: "ITC",
      category: "Foods",
      sourceUrl: supported.url,
      evidenceQuote: "Aashirvaad is one of our brands.",
      parentEvidenceUrl: supported.url,
      parentEvidenceQuote: "ITC's brands include Aashirvaad.",
      categoryEvidenceQuote: null,
    },
  ]);
  assert.equal(optionsWithSupportedParent.find((option) => option.kind === "brand")?.category, null);
});

test("title-backed brand without a company option is allowed only when title and registrable domain identify the brand", () => {
  const officialPage = source(
    "https://www.maxfashion.com/",
    "Max Fashion | Official online store. Discover the latest collections.",
    "Max Fashion | Official online store",
  );
  const { options, counts } = validateBrandOptionExtractionsDetailed("Max", [officialPage], []);
  assert.equal(counts.standaloneTitleBrands, 1);
  assert.equal(counts.validatedCompanies, 0);
  assert.deepEqual(options.map(({ kind, name, parent, evidenceQuote }) => ({
    kind,
    name,
    parent,
    evidenceQuote,
  })), [{
    kind: "brand",
    name: "Max Fashion",
    parent: null,
    evidenceQuote: "Max Fashion | Official online store",
  }]);

  const lookalikeTitle = source(
    "https://www.unrelated.com/",
    "Max Fashion | Official online store. Max Fashion is mentioned here.",
    "Max Fashion | Official online store",
  );
  assert.deepEqual(validateBrandOptionExtractions("Max", [lookalikeTitle], []), []);
});