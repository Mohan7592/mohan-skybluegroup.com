import assert from "node:assert/strict";
import test from "node:test";
import { fetchCitedSource } from "./live-research.ts";

function textPdf(text, title = "Official campaign terms") {
  const escapePdfText = (value) => value.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
  const stream = `BT /F1 12 Tf 72 720 Td (${escapePdfText(text)}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Title (${escapePdfText(title)}) >>`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf);
}

function fetchOptions(body, contentType = "application/pdf") {
  return {
    resolveAddresses: async () => [{ address: "93.184.216.34", family: 4 }],
    request: async () => ({
      status: 200,
      headers: { "content-type": contentType, "content-length": String(body.length) },
      body,
    }),
  };
}

test("extracts official first-party PDF text, title, and labeled publication date", async () => {
  const body = textPdf(
    "Hisense UAE campaign Terms and Conditions. Published: 2025-06-25. Participating promotion terms apply.",
    "Hisense UAE Campaign Terms",
  );
  const source = await fetchCitedSource(
    { title: "Hisense campaign PDF", url: "https://www.hisenseme.com/campaign.pdf" },
    undefined,
    fetchOptions(body),
  );
  assert.ok(source);
  assert.equal(source.title, "Hisense UAE Campaign Terms");
  assert.equal(source.sourceKind, "first_party_pdf");
  assert.equal(source.qualityScore, 88);
  assert.match(source.text, /Hisense UAE campaign Terms and Conditions/);
  assert.equal(source.publishedAt?.toISOString().slice(0, 10), "2025-06-25");
  assert.equal(source.url, "https://www.hisenseme.com/campaign.pdf");
});

test("does not grant first-party PDF quality from a document on an unrelated domain", async () => {
  const body = textPdf("Hisense UAE campaign Terms and Conditions.");
  for (const url of [
    "https://documents.example.com/terms.pdf",
    "https://hisenseme.evil/terms.pdf",
    "https://hisenseme.evil.com/terms.pdf",
  ]) {
    const source = await fetchCitedSource(
      { title: "Hisense campaign terms", url },
      undefined,
      fetchOptions(body),
    );
    assert.ok(source);
    assert.equal(source.sourceKind, "unverified_pdf");
    assert.ok(source.qualityScore < 70);
  }
});

test("does not treat a .pdf URL as proof of a PDF or accept a false PDF MIME type", async () => {
  const html = Buffer.from("<html><title>Terms</title><body>Ordinary HTML page</body></html>");
  const fakePdf = fetchOptions(html, "text/html");
  const source = await fetchCitedSource(
    { title: "Terms PDF", url: "https://www.hisenseme.com/terms.pdf" },
    undefined,
    fakePdf,
  );
  assert.ok(source, "valid HTML should remain available through the unchanged HTML path");
  assert.equal(source.sourceKind, "secondary");
  assert.equal(source.qualityScore, 35);

  const mislabeled = fetchOptions(textPdf("Not an accepted PDF response"), "application/octet-stream");
  assert.equal(await fetchCitedSource(
    { title: "Document", url: "https://www.hisenseme.com/document.pdf" },
    undefined,
    mislabeled,
  ), null);
});

test("rejects PDF MIME without a PDF signature and PDFs over the size limit", async () => {
  const mislabeled = fetchOptions(Buffer.from("not a pdf"), "application/pdf");
  assert.equal(await fetchCitedSource(
    { title: "Document", url: "https://www.hisenseme.com/document" },
    undefined,
    mislabeled,
  ), null);

  const oversized = Buffer.alloc(8_000_001);
  Buffer.from("%PDF-1.7").copy(oversized);
  assert.equal(await fetchCitedSource(
    { title: "Large PDF", url: "https://www.hisenseme.com/large" },
    undefined,
    fetchOptions(oversized),
  ), null);
});

test("rejects private hosts before attempting citation fetch", async () => {
  let requested = false;
  const result = await fetchCitedSource(
    { title: "Private source", url: "https://127.0.0.1/internal.pdf" },
    undefined,
    {
      request: async () => {
        requested = true;
        throw new Error("must not connect");
      },
    },
  );
  assert.equal(result, null);
  assert.equal(requested, false);
});