import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMobilityBaseline } from "./baseline.ts";

const categories = new Set([
  "blocked_cycle_lane",
  "dangerous_crossing",
  "road_obstacle",
  "collision_or_near_miss",
  "other",
]);

const clientFiles = new Map<string, [string, string]>([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/manifest.webmanifest", ["manifest.webmanifest", "application/manifest+json"]],
  ["/service-worker.js", ["service-worker.js", "text/javascript; charset=utf-8"]],
  ["/icon.svg", ["icon.svg", "image/svg+xml"]],
]);

interface ServerOptions {
  databasePath: string;
  operatorKey: string;
  projectRoot: string;
}

interface NewReport {
  category: string;
  latitude: number;
  longitude: number;
  description: string;
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 16_384) throw new Error("Request body too large");
    chunks.push(buffer);
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function normalizeReport(input: unknown): NewReport | null {
  if (!input || typeof input !== "object") return null;
  const value = input as Record<string, unknown>;
  const category = typeof value.category === "string" ? value.category : "";
  const latitude = Number(value.latitude);
  const longitude = Number(value.longitude);
  const description = typeof value.description === "string"
    ? value.description.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 400)
    : "";

  if (!categories.has(category)) return null;
  if (!Number.isFinite(latitude) || latitude < 40.30 || latitude > 40.53) return null;
  if (!Number.isFinite(longitude) || longitude < 18.07 || longitude > 18.35) return null;
  if (description.length < 8) return null;

  return { category, latitude, longitude, description };
}

export function createMobilityServer(options: ServerOptions) {
  const database = new DatabaseSync(options.databasePath);
  const sessions = new Set<string>();
  const operatorStreams = new Set<ServerResponse>();
  const publicStreams = new Set<ServerResponse>();
  let baseline: ReturnType<typeof loadMobilityBaseline> | undefined;
  database.exec(`
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS outbox_events (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      delivered_at TEXT
    );
  `);

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const sessionId = request.headers.cookie?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("operator_session="))
      ?.slice("operator_session=".length);
    const isOperator = Boolean(sessionId && sessions.has(sessionId));

    if (request.method === "GET" && url.pathname === "/api/baseline") {
      try {
        baseline ??= loadMobilityBaseline(options.projectRoot);
        sendJson(response, 200, baseline);
      } catch {
        sendJson(response, 503, { error: "Dataset di mobilità non disponibile." });
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/operator/login") {
      let key = "";
      try {
        const body = await readJson(request) as { key?: unknown };
        if (typeof body?.key === "string") key = body.key;
      } catch {
        sendJson(response, 400, { error: "Richiesta non valida." });
        return;
      }

      const supplied = Buffer.from(key);
      const expected = Buffer.from(options.operatorKey);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        sendJson(response, 401, { error: "Credenziale operatore non valida." });
        return;
      }

      const token = randomBytes(32).toString("hex");
      sessions.add(token);
      const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "set-cookie": `operator_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600${secure}`,
      });
      response.end(JSON.stringify({ authenticated: true }));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/operator/logout") {
      if (sessionId) sessions.delete(sessionId);
      response.writeHead(204, {
        "set-cookie": "operator_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
      });
      response.end();
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/operator/reports") {
      if (!isOperator) {
        sendJson(response, 401, { error: "Accesso operatore richiesto." });
        return;
      }
      const reports = database.prepare(`
        SELECT id, category, latitude, longitude, description, status, created_at AS createdAt
        FROM reports WHERE status = 'pending_review' ORDER BY created_at ASC
      `).all();
      sendJson(response, 200, { reports });
      return;
    }

    if (request.method === "PATCH" && url.pathname.startsWith("/api/operator/reports/")) {
      if (!isOperator) {
        sendJson(response, 401, { error: "Accesso operatore richiesto." });
        return;
      }

      const id = decodeURIComponent(url.pathname.slice("/api/operator/reports/".length));
      let status: unknown;
      try {
        status = (await readJson(request) as { status?: unknown }).status;
      } catch {
        sendJson(response, 400, { error: "Richiesta non valida." });
        return;
      }
      if (status !== "verified" && status !== "rejected") {
        sendJson(response, 422, { error: "Stato non valido." });
        return;
      }

      const existing = database.prepare("SELECT * FROM reports WHERE id = ? AND status = 'pending_review'").get(id) as Record<string, unknown> | undefined;
      if (!existing) {
        sendJson(response, 404, { error: "Segnalazione non trovata o già gestita." });
        return;
      }

      const changedAt = new Date().toISOString();
      const changedReport = { ...existing, status, changedAt };
      database.exec("BEGIN IMMEDIATE");
      try {
        database.prepare("UPDATE reports SET status = ? WHERE id = ?").run(status, id);
        database.prepare(`
          INSERT INTO outbox_events (id, event_type, payload, created_at)
          VALUES (?, ?, ?, ?)
        `).run(randomUUID(), "MobilityReportStatusChanged", JSON.stringify(changedReport), changedAt);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }

      sendJson(response, 200, { report: { id, status, changedAt } });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/operator/events") {
      if (!isOperator) {
        sendJson(response, 401, { error: "Accesso operatore richiesto." });
        return;
      }
      openEventStream(response, operatorStreams, "operator_connected", {});
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/public/events") {
      openEventStream(response, publicStreams, "connected", {});
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/public/reports") {
      const reports = database.prepare(`
        SELECT id, category, round(latitude, 2) AS latitude,
               round(longitude, 2) AS longitude, status
        FROM reports
        WHERE status IN ('verified', 'assigned', 'resolved')
        ORDER BY created_at DESC
        LIMIT 100
      `).all();
      sendJson(response, 200, { reports });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/reports") {
      let report: NewReport | null;
      try {
        report = normalizeReport(await readJson(request));
      } catch {
        sendJson(response, 400, { error: "Richiesta non valida." });
        return;
      }

      if (!report) {
        sendJson(response, 422, { error: "Controlla categoria, posizione e descrizione." });
        return;
      }

      const id = randomUUID();
      const createdAt = new Date().toISOString();
      const savedReport = { id, ...report, status: "pending_review", createdAt };
      const insertReport = database.prepare(`
        INSERT INTO reports (id, category, latitude, longitude, description, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const insertEvent = database.prepare(`
        INSERT INTO outbox_events (id, event_type, payload, created_at)
        VALUES (?, ?, ?, ?)
      `);
      database.exec("BEGIN IMMEDIATE");
      try {
        insertReport.run(id, report.category, report.latitude, report.longitude, report.description, savedReport.status, createdAt);
        insertEvent.run(randomUUID(), "MobilityReportSubmitted", JSON.stringify(savedReport), createdAt);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }

      sendJson(response, 201, {
        report: { id, status: savedReport.status, createdAt },
        message: "Segnalazione ricevuta e in attesa di verifica.",
      });
      return;
    }

    const clientFile = request.method === "GET" ? clientFiles.get(url.pathname) : undefined;
    if (clientFile) {
      try {
        const [filename, contentType] = clientFile;
        const content = readFileSync(resolve(process.cwd(), "client", filename));
        response.writeHead(200, {
          "content-type": contentType,
          "cache-control": "no-cache",
          "x-content-type-options": "nosniff",
          "referrer-policy": "strict-origin-when-cross-origin",
          "content-security-policy": "default-src 'self'; img-src 'self' data: https://tile.openstreetmap.org https://unpkg.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com; font-src 'self' https://fonts.gstatic.com https://unpkg.com data:; script-src 'self' https://unpkg.com; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
        });
        response.end(content);
      } catch {
        sendJson(response, 404, { error: "Risorsa non trovata." });
      }
      return;
    }

    sendJson(response, 404, { error: "Risorsa non trovata." });
  });

  const outboxTimer = setInterval(() => {
    const events = database.prepare(`
      SELECT id, event_type, payload FROM outbox_events
      WHERE delivered_at IS NULL ORDER BY created_at LIMIT 100
    `).all() as Array<{ id: string; event_type: string; payload: string }>;

    for (const event of events) {
      const payload = JSON.parse(event.payload) as Record<string, unknown>;
      if (event.event_type === "MobilityReportSubmitted") {
        broadcast(operatorStreams, "report_submitted", payload);
      } else if (event.event_type === "MobilityReportStatusChanged") {
        broadcast(operatorStreams, "report_status_changed", payload);
        if (payload.status === "verified") {
          const publicReport = {
            id: payload.id,
            category: payload.category,
            latitude: Math.round(Number(payload.latitude) * 100) / 100,
            longitude: Math.round(Number(payload.longitude) * 100) / 100,
            status: payload.status,
          };
          broadcast(publicStreams, "report_verified", publicReport);
        }
      }
      database.prepare("UPDATE outbox_events SET delivered_at = ? WHERE id = ?")
        .run(new Date().toISOString(), event.id);
    }
  }, 250);

  server.on("close", () => {
    clearInterval(outboxTimer);
    database.close();
  });
  return server;
}

function openEventStream(response: ServerResponse, clients: Set<ServerResponse>, event: string, data: unknown): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  clients.add(response);
  response.on("close", () => clients.delete(response));
}

function broadcast(clients: Set<ServerResponse>, event: string, data: unknown): void {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) client.write(message);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const operatorKey = process.env.OPERATOR_KEY ?? (process.env.NODE_ENV === "production" ? "" : "demo-lecce");
  if (!operatorKey) throw new Error("Set OPERATOR_KEY before starting in production.");

  const databasePath = process.env.DATABASE_PATH ?? resolve(process.cwd(), "data", "reports.sqlite");
  if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
  const server = createMobilityServer({
    databasePath,
    operatorKey,
    projectRoot: resolve(process.cwd(), ".."),
  });
  const host = process.env.HOST ?? "127.0.0.1";
  const port = Number(process.env.PORT ?? 4173);
  server.listen(port, host, () => console.log(`Lecce si muove: http://${host}:${port}`));
}
