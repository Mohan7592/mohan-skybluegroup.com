import { randomUUID, createHash } from "node:crypto";

const SIDECAR_ENDPOINT = "http://127.0.0.1:1106";
const PASSENGER_OBJECT_PREFIX = "/objects/passenger-metrics/";
export const MAX_PASSENGER_CSV_BYTES = 20 * 1024 * 1024;

function privateObjectCoordinates(objectPath: string): { bucketName: string; objectName: string } {
  if (!/^\/objects\/passenger-metrics\/[0-9a-f-]{36}\.csv$/i.test(objectPath)) {
    throw new Error("The passenger source object path is invalid.");
  }
  const privateDir = process.env.PRIVATE_OBJECT_DIR?.trim();
  if (!privateDir) throw new Error("Private App Storage is not configured.");
  const [bucketName, ...prefixParts] = privateDir.replace(/^\/+|\/+$/g, "").split("/");
  if (!bucketName) throw new Error("Private App Storage is not configured.");
  const objectId = objectPath.slice(PASSENGER_OBJECT_PREFIX.length);
  return {
    bucketName,
    objectName: [...prefixParts, "passenger-metrics", objectId].filter(Boolean).join("/"),
  };
}

async function signedObjectUrl(objectPath: string, method: "PUT" | "GET" | "DELETE"): Promise<string> {
  const { bucketName, objectName } = privateObjectCoordinates(objectPath);
  const response = await fetch(`${SIDECAR_ENDPOINT}/object-storage/signed-object-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      bucket_name: bucketName,
      object_name: objectName,
      method,
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`App Storage could not authorize the ${method} operation.`);
  const result = await response.json() as { signed_url?: string };
  if (!result.signed_url) throw new Error("App Storage returned no signed object URL.");
  return result.signed_url;
}

export async function createPassengerCsvUpload(): Promise<{ uploadUrl: string; objectPath: string }> {
  const objectPath = `${PASSENGER_OBJECT_PREFIX}${randomUUID()}.csv`;
  return { uploadUrl: await signedObjectUrl(objectPath, "PUT"), objectPath };
}

export async function readPassengerCsvObject(objectPath: string): Promise<{
  bytes: Uint8Array;
  sha256: string;
  csv: string;
}> {
  const signedUrl = await signedObjectUrl(objectPath, "GET");
  const response = await fetch(signedUrl, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error("The uploaded passenger CSV could not be read from private App Storage.");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("The uploaded passenger CSV has no readable body.");
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > MAX_PASSENGER_CSV_BYTES) {
      await reader.cancel();
      await deletePassengerCsvObject(objectPath);
      throw new Error("CSV exceeds the 20 MB import limit.");
    }
    chunks.push(value);
  }
  if (!byteLength) throw new Error("Uploaded passenger CSV is empty.");
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let csv: string;
  try { csv = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch {
    await deletePassengerCsvObject(objectPath);
    throw new Error("Passenger CSV must contain valid UTF-8 text.");
  }
  return {
    bytes,
    csv,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export async function deletePassengerCsvObject(objectPath: string): Promise<void> {
  const signedUrl = await signedObjectUrl(objectPath, "DELETE");
  const response = await fetch(signedUrl, { method: "DELETE", signal: AbortSignal.timeout(30_000) });
  if (!response.ok && response.status !== 404) throw new Error("The rejected or abandoned passenger CSV could not be removed from App Storage.");
}

export async function deleteUnreferencedPassengerCsvObject(
  objectPath: string,
  isReferenced: (path: string) => Promise<boolean>,
  removeObject: (path: string) => Promise<void> = deletePassengerCsvObject,
): Promise<void> {
  if (!/^\/objects\/passenger-metrics\/[0-9a-f-]{36}\.csv$/i.test(objectPath)) {
    throw new Error(`Refusing cleanup because the passenger object path is invalid: ${objectPath}`);
  }
  if (await isReferenced(objectPath)) {
    throw new Error(`Refusing to delete passenger object ${objectPath}: it is referenced by an import batch.`);
  }
  try {
    await removeObject(objectPath);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown App Storage deletion error";
    throw new Error(`Could not delete unreferenced passenger object ${objectPath}: ${reason}`);
  }
}

export function passengerObjectCleanupCommand(objectPath: string): string {
  return `node --experimental-strip-types artifacts/api-server/src/cli/cleanup-passenger-metrics-orphan.mjs --object-path ${objectPath}`;
}

export function passengerImportCleanupFailureMessage(
  objectPath: string,
  importFailure: string,
  cleanupFailure: string,
): string {
  return `Passenger import failed (${importFailure}); cleanup did not complete (${cleanupFailure}). ` +
    `Review private object path ${objectPath}. If it is unreferenced, clean it with: ${passengerObjectCleanupCommand(objectPath)}`;
}