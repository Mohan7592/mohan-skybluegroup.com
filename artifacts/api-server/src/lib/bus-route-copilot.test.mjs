import assert from "node:assert/strict";
import test from "node:test";
import { answerBusRouteQuestion, isBusRouteReferenceQuestion } from "./bus-route-copilot.ts";

const routes = [
  { routeId: "83", variants: [
    { sheetName: "Bus Routes Master ", sourceRowNumber: 7, rawData: {
      "Starting Station": "Al Ghubaiba Bus Station", "Ending station": "Al Quoz",
      Via: "Sheikh Zayed service Road", "Depot Name": "Al Quoz Depot", "Buses per Route": "7",
    } },
    { sheetName: "Bus Routes Master ", sourceRowNumber: 212, rawData: {
      "Starting Station": "Al Ghubaiba Bus Station", "Ending station": "Al Fardan Exchange MS",
      Via: "Sheikh zayed road", "Depot Name": "Jebel Ali Depot", "Buses per Route": "2",
    } },
  ] },
  { routeId: "8", variants: [
    { sheetName: "Sheet5", sourceRowNumber: 9, rawData: {
      "Starting Station": "Mall", "Ending station": "Airport", Via: "Other Road",
      "Depot Name": "Al Quoz Depot", "Buses per Route": "4",
    } },
  ] },
];

test("real route-reference questions do not turn route counts into vehicles", () => {
  const road = answerBusRouteQuestion("Which routes pass Sheikh Zayed Road?", routes);
  assert.match(road, /Route 83/);
  assert.doesNotMatch(road, /Route 8:/);
  assert.match(answerBusRouteQuestion("Which routes cover Al Quoz?", routes), /Route 83/);
  assert.doesNotMatch(answerBusRouteQuestion("Which routes cover Al Quoz?", routes), /Route 8:/);
  assert.match(answerBusRouteQuestion("Show routes covering Al Ghubaiba and Sheikh Zayed Road", routes), /Route 83/);
  assert.match(answerBusRouteQuestion("Which routes have the highest source bus count?", routes), /source buses per route: 7/);
  const depot = answerBusRouteQuestion("Which routes belong to Al Quoz depot?", routes);
  assert.match(depot, /Route 83/);
  assert.match(depot, /Route 8/);
  const detail = answerBusRouteQuestion("Show Route 83 details", routes);
  assert.match(detail, /source buses per route: 7/);
  assert.match(detail, /source buses per route: 2/);
  assert.match(detail, /not identified physical buses/);
  assert.match(answerBusRouteQuestion("How many buses does the source assign to this route?", routes), /Which Route ID/);
  assert.match(answerBusRouteQuestion("How many buses does the source assign to this route?", routes, "83"), /Route 83/);
});

test("asset inventory questions stay in the inventory Copilot path", () => {
  assert.equal(isBusRouteReferenceQuestion("Show bus shelters on Route 8"), false);
  assert.equal(isBusRouteReferenceQuestion("Show buses on Route 8"), false);
  assert.equal(isBusRouteReferenceQuestion("Show Route 8 details"), true);
});