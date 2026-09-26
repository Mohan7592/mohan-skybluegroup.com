import test from "node:test";
import assert from "node:assert/strict";
import {
  deleteUnreferencedPassengerCsvObject,
  passengerImportCleanupFailureMessage,
  passengerObjectCleanupCommand,
} from "./passenger-metrics-storage.ts";

const objectPath = "/objects/passenger-metrics/00000000-0000-4000-8000-000000000001.csv";

test("orphan cleanup refuses to delete an object referenced by an import batch", async () => {
  let removeCalled = false;
  await assert.rejects(
    deleteUnreferencedPassengerCsvObject(objectPath, async () => true, async () => { removeCalled = true; }),
    new RegExp(`${objectPath}: it is referenced by an import batch`),
  );
  assert.equal(removeCalled, false);
});

test("orphan cleanup deletes only after confirming no batch references the object", async () => {
  let removedPath = "";
  await deleteUnreferencedPassengerCsvObject(objectPath, async () => false, async (path) => { removedPath = path; });
  assert.equal(removedPath, objectPath);
});

test("orphan cleanup errors retain the object path and deletion failure details", async () => {
  await assert.rejects(
    deleteUnreferencedPassengerCsvObject(
      objectPath,
      async () => false,
      async () => { throw new Error("App Storage timeout"); },
    ),
    new RegExp(`Could not delete unreferenced passenger object ${objectPath}: App Storage timeout`),
  );
});

test("cleanup failure instructions preserve the orphan path and safe recovery command", () => {
  const command = passengerObjectCleanupCommand(objectPath);
  assert.match(command, /cleanup-passenger-metrics-orphan\.mjs/);
  assert.match(command, new RegExp(objectPath));
  const message = passengerImportCleanupFailureMessage(objectPath, "database write failed", "App Storage timeout");
  assert.match(message, /database write failed/);
  assert.match(message, /App Storage timeout/);
  assert.match(message, new RegExp(objectPath));
  assert.match(message, /cleanup-passenger-metrics-orphan\.mjs/);
});