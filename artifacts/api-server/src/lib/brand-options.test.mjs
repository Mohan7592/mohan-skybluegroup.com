import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import {
  createBrandSelectionToken,
  validateRegionalEntityEvidence,
  verifyBrandSelectionToken,
} from "./brand-selection-token.ts";

test("brand selection tokens preserve validated choices and reject tampering", () => {
  const previous = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = "test-only-brand-selection-signing-secret";
  try {
    const option = {
      kind: "brand",
      name: "Dove",
      parent: "Unilever",
      category: "Personal care",
      website: "https://www.unilever.com",
      sourceUrl: "https://www.unilever.com/brands/dove/",
      evidenceQuote: "Dove is a Unilever personal care brand.",
    };
    const token = createBrandSelectionToken("Unilever", option);
    const verified = verifyBrandSelectionToken(token);
    assert.equal(verified.query, "Unilever");
    assert.deepEqual(verified.option, option);
    assert.throws(() => verifyBrandSelectionToken(`${token}x`), /Invalid or expired/);
  } finally {
    if (previous === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previous;
  }
});

test("regional entity evidence requires an exact same-site quote naming the option and regional legal entity", () => {
  const option = {
    kind: "brand",
    name: "Dove",
    parent: "Unilever",
    category: "Personal care",
    website: "https://unilever.com",
    sourceUrl: "https://www.unilever.com/brands/dove/",
    evidenceQuote: "Dove is a Unilever personal care brand.",
  };
  const quote = "Unilever Gulf FZE is the UAE legal entity responsible for Dove.";
  const source = {
    url: "https://www.unilever.com/legal/uae",
    title: "UAE legal information",
    text: quote,
  };
  const extracted = [{
    kind: "brand",
    name: "Dove",
    category: "Personal care",
    regionalEntity: {
      name: "Unilever Gulf FZE",
      sourceUrl: source.url,
      evidenceQuote: quote,
    },
  }];
  assert.deepEqual(validateRegionalEntityEvidence(option, extracted, [source]), {
    name: "Unilever Gulf FZE",
    sourceUrl: source.url,
    evidenceQuote: quote,
  });
  assert.equal(validateRegionalEntityEvidence(option, [{
    ...extracted[0],
    regionalEntity: { ...extracted[0].regionalEntity, evidenceQuote: "Unilever Gulf FZE serves the region." },
  }], [source]), null, "a parent/entity mention without an explicit option reference is not inherited");
  assert.equal(validateRegionalEntityEvidence(option, extracted, [{
    ...source,
    url: "https://unilever-uae.example/legal",
  }]), null, "a domain cannot establish an entity");
});

test("regional entity details round-trip in the signed selection token", () => {
  const previous = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = "test-only-brand-selection-signing-secret";
  try {
    const option = {
      kind: "company",
      name: "Unilever",
      parent: null,
      category: null,
      website: "https://unilever.com",
      sourceUrl: "https://www.unilever.com/about",
      evidenceQuote: "Unilever is a global consumer goods company.",
      regionalEntity: {
        name: "Unilever Gulf FZE",
        sourceUrl: "https://www.unilever.com/legal/uae",
        evidenceQuote: "Unilever Gulf FZE is the UAE legal entity for Unilever.",
      },
    };
    assert.deepEqual(verifyBrandSelectionToken(createBrandSelectionToken("Unilever", option)).option, option);
  } finally {
    if (previous === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previous;
  }
});

test("previously signed version-one tokens without regionalEntity remain valid", () => {
  const previous = process.env.SESSION_SECRET;
  const secret = "test-only-brand-selection-signing-secret";
  process.env.SESSION_SECRET = secret;
  try {
    const option = {
      kind: "brand",
      name: "Dove",
      parent: "Unilever",
      category: null,
      website: "https://unilever.com",
      sourceUrl: "https://www.unilever.com/brands/dove/",
      evidenceQuote: "Dove is a Unilever brand.",
    };
    const payload = Buffer.from(JSON.stringify({
      v: 1,
      query: "Unilever",
      option,
      expiresAt: Date.now() + 60_000,
    }), "utf8").toString("base64url");
    const signature = createHmac("sha256", secret).update(payload).digest("base64url");
    assert.deepEqual(verifyBrandSelectionToken(`${payload}.${signature}`).option, option);
  } finally {
    if (previous === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previous;
  }
});

test("brand selection token generation requires the configured signing secret", () => {
  const previous = process.env.SESSION_SECRET;
  delete process.env.SESSION_SECRET;
  try {
    assert.throws(() => createBrandSelectionToken("Example", {
      kind: "company",
      name: "Example",
      parent: null,
      category: null,
      website: "https://example.com",
      sourceUrl: "https://example.com/about",
      evidenceQuote: "Example is a company.",
    }), /SESSION_SECRET/);
  } finally {
    if (previous !== undefined) process.env.SESSION_SECRET = previous;
  }
});