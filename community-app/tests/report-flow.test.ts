import assert from "node:assert/strict";
import { once } from "node:events";
import { after, test } from "node:test";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { createMobilityServer } from "../src/server.ts";

const server = createMobilityServer({
  databasePath: ":memory:",
  operatorKey: "test-operator-key",
  projectRoot: resolve(process.cwd(), ".."),
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address() as AddressInfo;
const baseUrl = `http://127.0.0.1:${address.port}`;

after(async () => {
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
});

test("a new report is accepted for review but hidden from the public feed", async () => {
  const response = await fetch(`${baseUrl}/api/reports`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      category: "blocked_cycle_lane",
      latitude: 40.483,
      longitude: 18.329,
      description: "Passaggio ostruito vicino all'incrocio",
    }),
  });

  assert.equal(response.status, 201);
  const receipt = await response.json();
  assert.equal(receipt.report.status, "pending_review");
  assert.ok(receipt.report.id);

  const publicResponse = await fetch(`${baseUrl}/api/public/reports`);
  assert.deepEqual(await publicResponse.json(), { reports: [] });
});

test("only an authenticated operator can verify a report and publish an approximate location", async () => {
  const created = await fetch(`${baseUrl}/api/reports`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      category: "dangerous_crossing",
      latitude: 40.3548,
      longitude: 18.1764,
      description: "Attraversamento con visibilita ridotta",
    }),
  });
  const { report } = await created.json();

  const unauthorized = await fetch(`${baseUrl}/api/operator/reports`);
  assert.equal(unauthorized.status, 401);

  const login = await fetch(`${baseUrl}/api/operator/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: "test-operator-key" }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);

  const queueResponse = await fetch(`${baseUrl}/api/operator/reports`, {
    headers: { cookie },
  });
  const queue = await queueResponse.json();
  assert.ok(queue.reports.some((item: { id: string }) => item.id === report.id));

  const verifyResponse = await fetch(`${baseUrl}/api/operator/reports/${report.id}`, {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ status: "verified" }),
  });
  assert.equal(verifyResponse.status, 200);

  const publicResponse = await fetch(`${baseUrl}/api/public/reports`);
  const publicFeed = await publicResponse.json();
  assert.equal(publicFeed.reports.length, 1);
  assert.equal(publicFeed.reports[0].latitude, 40.35);
  assert.equal(publicFeed.reports[0].longitude, 18.18);
  assert.equal("description" in publicFeed.reports[0], false);
});

test("the public baseline contains only aggregated crash cells and mobility context", async () => {
  const response = await fetch(`${baseUrl}/api/baseline`);
  assert.equal(response.status, 200);
  const baseline = await response.json();

  assert.equal(baseline.stats.historicalIncidents, 7444);
  assert.equal(baseline.stats.cycleNetworkSegments, 628);
  assert.equal(baseline.stats.schoolLocations, 44);
  assert.ok(baseline.crashCells.length > 0);
  assert.ok(baseline.crashCells.every((cell: { count: number }) => cell.count >= 5));
  assert.equal("id" in baseline.crashCells[0], false);
  assert.equal(baseline.cycleNetwork.type, "FeatureCollection");
  assert.ok(baseline.schools.length > 0);
});

test("the same-origin server serves the community app shell", async () => {
  const response = await fetch(`${baseUrl}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/html/);
  assert.match(await response.text(), /Lecce si muove/);
});

test("the app shell opens on a home screen with biometric and simple entry", async () => {
  const html = await (await fetch(`${baseUrl}/`)).text();
  assert.match(html, /id="homeScreen"/);
  assert.match(html, /id="biometricEnter"/);
  assert.match(html, /id="simpleEnter"/);

  const hero = await fetch(`${baseUrl}/home-hero.jpg`);
  assert.equal(hero.status, 200);
  assert.equal(hero.headers.get("content-type"), "image/jpeg");
  assert.ok((await hero.arrayBuffer()).byteLength > 10_000);
});
