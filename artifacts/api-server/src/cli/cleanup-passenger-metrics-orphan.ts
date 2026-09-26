import {
  deleteUnreferencedPassengerCsvObject,
} from "../lib/passenger-metrics-storage";
import { isPassengerMetricObjectReferenced } from "../lib/passenger-metrics-service";
import { pool } from "@workspace/db";

const args = process.argv.slice(2);
const pathFlag = args.indexOf("--object-path");
const objectPath = pathFlag >= 0 ? args[pathFlag + 1] : undefined;

try {
  if (!objectPath || objectPath.startsWith("--")) {
    throw new Error(
      "Supply the orphan's private object path only after confirming a prior commit failure: " +
      "node --experimental-strip-types artifacts/api-server/src/cli/cleanup-passenger-metrics-orphan.mjs --object-path /objects/passenger-metrics/<uuid>.csv",
    );
  }
  await deleteUnreferencedPassengerCsvObject(objectPath, isPassengerMetricObjectReferenced);
  console.log(JSON.stringify({ deleted: true, objectPath }));
} catch (error) {
  console.error(error instanceof Error ? error.message : `Cleanup failed for ${objectPath ?? "the supplied object"}.`);
  process.exitCode = 1;
} finally {
  await pool.end();
}