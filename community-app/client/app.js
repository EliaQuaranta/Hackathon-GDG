const categoryLabels = {
  blocked_cycle_lane: "Pista ciclabile bloccata",
  dangerous_crossing: "Attraversamento pericoloso",
  road_obstacle: "Ostacolo sulla strada",
  collision_or_near_miss: "Incidente o quasi incidente",
  other: "Problema di mobilità",
};

const map = L.map("map", { zoomControl: false, preferCanvas: true }).setView([40.351, 18.175], 13);
L.control.zoom({ position: "bottomright" }).addTo(map);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

const networkLayer = L.geoJSON(null, {
  style: (feature) => {
    const type = feature?.properties?.Tipologia ?? "";
    const protectedLane = type.includes("sede protetta") || type.includes("corsia riservata");
    const crossing = type.includes("Attraversamento");
    return {
      color: protectedLane ? "#16865f" : crossing ? "#d5a137" : "#dc795d",
      weight: crossing ? 2 : 3,
      opacity: 0.78,
      dashArray: feature?.properties?.Stato === "di progetto" ? "5 7" : null,
    };
  },
}).addTo(map);

const hotspotLayer = L.layerGroup().addTo(map);
const schoolLayer = L.layerGroup();
const liveLayer = L.layerGroup().addTo(map);
let draftLocation = null;
let draftMarker = null;
let selectingLocation = false;
let operatorEvents = null;
let toastTimer = null;
const publicReports = new Map();

function icons() {
  window.lucide?.createIcons();
}

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 4200);
}

async function requestJson(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  let body = {};
  try { body = await response.json(); } catch { /* Empty response. */ }
  if (!response.ok) throw new Error(body.error ?? "Richiesta non riuscita.");
  return body;
}

function safePopup(text) {
  const element = document.createElement("span");
  element.textContent = text;
  return element;
}

function renderPublicReport(report) {
  if (publicReports.has(report.id)) return;
  const marker = L.circleMarker([report.latitude, report.longitude], {
    radius: 8,
    color: "#ffffff",
    weight: 2,
    fillColor: "#137b5c",
    fillOpacity: 0.94,
  }).bindPopup(safePopup(`${categoryLabels[report.category] ?? categoryLabels.other} · segnalazione verificata, posizione approssimata`));
  marker.addTo(liveLayer);
  publicReports.set(report.id, { marker, report });
  renderPublicFeed();
}

function renderPublicFeed() {
  const feed = document.getElementById("publicFeed");
  const items = [...publicReports.values()].slice(-4).reverse();
  document.getElementById("publicReportCount").textContent = String(publicReports.size);
  feed.replaceChildren();
  if (items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "Nessuna segnalazione verificata recente. La mappa mostra il contesto storico.";
    feed.append(empty);
    return;
  }

  for (const { report } of items) {
    const item = document.createElement("div");
    item.className = "feed-item";
    const dot = document.createElement("span");
    dot.className = "feed-dot";
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = categoryLabels[report.category] ?? categoryLabels.other;
    const status = document.createElement("span");
    status.textContent = "Verificata · posizione approssimata";
    copy.append(title, status);
    item.append(dot, copy);
    feed.append(item);
  }
}

function addSchoolMarker(school) {
  const marker = L.circleMarker([school.latitude, school.longitude], {
    radius: 5,
    color: "#ffffff",
    weight: 1.5,
    fillColor: "#d5a137",
    fillOpacity: 0.95,
  });
  marker.bindPopup(safePopup(`${school.name} · dato scolastico 2017/18`));
  schoolLayer.addLayer(marker);
}

async function loadPublicReports() {
  const data = await requestJson("/api/public/reports");
  data.reports.forEach(renderPublicReport);
}

function connectPublicStream() {
  const status = document.getElementById("connectionLabel");
  const stream = new EventSource("/api/public/events");
  stream.onopen = () => {
    status.textContent = "Aggiornamenti live";
    status.closest(".topbar-state").classList.remove("is-offline");
  };
  stream.onerror = () => {
    status.textContent = "Riconnessione live…";
    status.closest(".topbar-state").classList.add("is-offline");
  };
  stream.addEventListener("report_verified", (event) => {
    renderPublicReport(JSON.parse(event.data));
    showToast("Nuova segnalazione verificata nella tua zona.");
  });
}

async function loadBaseline() {
  const label = document.getElementById("mapDataState");
  try {
    const baseline = await requestJson("/api/baseline");
    document.getElementById("incidentCount").textContent = baseline.stats.historicalIncidents.toLocaleString("it-IT");
    document.getElementById("networkCount").textContent = baseline.stats.cycleNetworkSegments.toLocaleString("it-IT");
    document.getElementById("schoolCount").textContent = baseline.stats.schoolLocations.toLocaleString("it-IT");

    networkLayer.addData(baseline.cycleNetwork);
    for (const cell of baseline.crashCells) {
      const circle = L.circleMarker([cell.latitude, cell.longitude], {
        radius: Math.max(6, Math.min(16, 5 + Math.sqrt(cell.count))),
        color: "#ffffff",
        weight: 1,
        fillColor: "#e16d53",
        fillOpacity: 0.62,
      });
      circle.bindPopup(safePopup(`${cell.count} incidenti storici aggregati · cella con almeno 5 eventi`));
      hotspotLayer.addLayer(circle);
    }
    baseline.schools.forEach(addSchoolMarker);

    const bounds = networkLayer.getBounds();
    if (bounds.isValid()) map.fitBounds(bounds.pad(0.07), { maxZoom: 14 });
    label.textContent = "Storico 2013–2023 · aggregato";
    document.getElementById("mapInstruction").classList.remove("is-hidden");
  } catch {
    label.textContent = "Dati di contesto non disponibili";
    showToast("Non riesco a caricare i dati di mobilità.");
  }
}

function updateSelectedLocation() {
  const target = document.getElementById("selectedLocation");
  if (!draftLocation) {
    target.textContent = "Posizione non ancora scelta";
    return;
  }
  target.textContent = `Posizione impostata · ${draftLocation.lat.toFixed(3)}, ${draftLocation.lng.toFixed(3)}`;
}

function placeDraftMarker(location) {
  draftLocation = L.latLng(location.lat, location.lng);
  if (draftMarker) map.removeLayer(draftMarker);
  draftMarker = L.marker(draftLocation, { draggable: true }).addTo(map);
  draftMarker.on("dragend", () => {
    draftLocation = draftMarker.getLatLng();
    updateSelectedLocation();
  });
  updateSelectedLocation();
}

function openReportDialog() {
  document.getElementById("reportDialog").showModal();
  updateSelectedLocation();
}

document.getElementById("reportButton").addEventListener("click", openReportDialog);
document.getElementById("chooseLocation").addEventListener("click", () => {
  selectingLocation = true;
  document.getElementById("reportDialog").close();
  showToast("Tocca la mappa nel punto da segnalare.");
});

document.getElementById("useLocation").addEventListener("click", () => {
  if (!navigator.geolocation) {
    showToast("La posizione non è disponibile in questo browser.");
    return;
  }
  navigator.geolocation.getCurrentPosition((position) => {
    const location = { lat: position.coords.latitude, lng: position.coords.longitude };
    placeDraftMarker(location);
    map.setView(location, 16);
  }, () => showToast("Posizione non disponibile. Puoi scegliere il punto sulla mappa."), { enableHighAccuracy: true, timeout: 8000 });
});

map.on("click", (event) => {
  if (!selectingLocation) return;
  selectingLocation = false;
  placeDraftMarker(event.latlng);
  openReportDialog();
});

document.getElementById("reportForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!draftLocation) {
    showToast("Scegli prima una posizione sulla mappa o usa il GPS.");
    return;
  }
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const report = await requestJson("/api/reports", {
      method: "POST",
      body: JSON.stringify({
        category: document.getElementById("category").value,
        latitude: draftLocation.lat,
        longitude: draftLocation.lng,
        description: document.getElementById("description").value,
      }),
    });
    document.getElementById("reportDialog").close();
    document.getElementById("category").selectedIndex = 0;
    document.getElementById("description").value = "";
    if (draftMarker) map.removeLayer(draftMarker);
    draftMarker = null;
    draftLocation = null;
    updateSelectedLocation();
    showToast(`Segnalazione ricevuta. Codice ${report.report.id.slice(0, 8)} · in attesa di verifica.`);
  } catch (error) {
    showToast(error.message);
  } finally {
    submit.disabled = false;
  }
});

function setOperatorMode(authenticated) {
  document.getElementById("operatorLoginForm").hidden = authenticated;
  document.getElementById("operatorQueuePanel").hidden = !authenticated;
  if (!authenticated && operatorEvents) {
    operatorEvents.close();
    operatorEvents = null;
  }
  if (authenticated) {
    loadOperatorQueue();
    operatorEvents = new EventSource("/api/operator/events");
    operatorEvents.addEventListener("report_submitted", loadOperatorQueue);
    operatorEvents.addEventListener("report_status_changed", loadOperatorQueue);
  }
}

async function loadOperatorQueue() {
  try {
    const data = await requestJson("/api/operator/reports");
    renderOperatorQueue(data.reports);
  } catch (error) {
    if (error.message.includes("Accesso operatore")) setOperatorMode(false);
    else showToast(error.message);
  }
}

function renderOperatorQueue(reports) {
  const queue = document.getElementById("operatorQueue");
  queue.replaceChildren();
  if (reports.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "Nessuna segnalazione in attesa.";
    queue.append(empty);
    return;
  }

  for (const report of reports) {
    const item = document.createElement("article");
    item.className = "queue-item";
    const head = document.createElement("div");
    head.className = "queue-item-head";
    const title = document.createElement("strong");
    title.textContent = categoryLabels[report.category] ?? categoryLabels.other;
    const time = document.createElement("time");
    time.textContent = new Date(report.createdAt).toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" });
    head.append(title, time);
    const description = document.createElement("p");
    description.textContent = report.description;
    const coordinates = document.createElement("span");
    coordinates.className = "queue-coordinates";
    coordinates.textContent = `${report.latitude.toFixed(5)}, ${report.longitude.toFixed(5)} · ${report.id.slice(0, 8)}`;
    const actions = document.createElement("div");
    actions.className = "queue-actions";
    actions.append(
      makeQueueAction(report.id, "verified", "Verifica", "button-verify"),
      makeQueueAction(report.id, "rejected", "Rifiuta", "button-reject"),
    );
    item.append(head, description, coordinates, actions);
    queue.append(item);
  }
  icons();
}

function makeQueueAction(id, status, label, className) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `button ${className}`;
  button.textContent = label;
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await requestJson(`/api/operator/reports/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      await loadOperatorQueue();
      showToast(status === "verified" ? "Segnalazione verificata e pubblicata in forma approssimata." : "Segnalazione rifiutata.");
    } catch (error) {
      showToast(error.message);
      button.disabled = false;
    }
  });
  return button;
}

document.getElementById("operatorButton").addEventListener("click", async () => {
  document.getElementById("operatorDialog").showModal();
  try {
    await requestJson("/api/operator/reports");
    setOperatorMode(true);
  } catch {
    setOperatorMode(false);
  }
});

document.getElementById("operatorLoginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const key = document.getElementById("operatorKey").value;
  try {
    await requestJson("/api/operator/login", { method: "POST", body: JSON.stringify({ key }) });
    document.getElementById("operatorKey").value = "";
    setOperatorMode(true);
  } catch (error) {
    showToast(error.message);
  }
});

document.getElementById("operatorLogout").addEventListener("click", async () => {
  await fetch("/api/operator/logout", { method: "POST" });
  setOperatorMode(false);
});

document.querySelectorAll("[data-close]").forEach((button) => {
  button.addEventListener("click", () => document.getElementById(button.dataset.close).close());
});

document.getElementById("toggleNetwork").addEventListener("change", (event) => {
  if (event.target.checked) map.addLayer(networkLayer); else map.removeLayer(networkLayer);
});
document.getElementById("toggleHistory").addEventListener("change", (event) => {
  if (event.target.checked) map.addLayer(hotspotLayer); else map.removeLayer(hotspotLayer);
});
document.getElementById("toggleSchools").addEventListener("change", (event) => {
  if (event.target.checked) map.addLayer(schoolLayer); else map.removeLayer(schoolLayer);
});

for (const dialog of document.querySelectorAll("dialog")) {
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
}

icons();
loadBaseline();
loadPublicReports().catch(() => {});
connectPublicStream();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/service-worker.js").catch(() => {});
