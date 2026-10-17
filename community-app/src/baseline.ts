import { readFileSync } from "node:fs";
import { join } from "node:path";

interface CsvRow {
  [column: string]: string;
}

interface MobilityBaseline {
  stats: {
    historicalIncidents: number;
    cycleNetworkSegments: number;
    schoolLocations: number;
    minimumCellCount: number;
  };
  crashCells: Array<{ latitude: number; longitude: number; count: number }>;
  cycleNetwork: {
    type: "FeatureCollection";
    features: Array<{
      type: "Feature";
      id: number;
      geometry: { type: string; coordinates: unknown };
      properties: Record<string, string | number | null>;
    }>;
  };
  schools: Array<{
    id: string;
    name: string;
    latitude: number;
    longitude: number;
    programs: number;
  }>;
}

function parseCsvLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let value = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === delimiter && !quoted) {
      fields.push(value);
      value = "";
    } else {
      value += character;
    }
  }

  fields.push(value);
  return fields;
}

function parseCsv(content: string): CsvRow[] {
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const delimiter = lines[0].includes(";") && !lines[0].includes(",") ? ";" : ",";
  const headers = parseCsvLine(lines[0], delimiter).map((header) => header.trim());

  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line, delimiter);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
  });
}

function numeric(value: string | undefined): number | null {
  if (!value?.trim()) return null;
  const parsed = Number(value.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

export function loadMobilityBaseline(projectRoot: string): MobilityBaseline {
  const inputDirectory = join(projectRoot, "00-CustomerInput", "Documenti ricevuti");
  const incidents = parseCsv(readFileSync(join(inputDirectory, "lecce_rete_ciclabile.geojson"), "utf8"));
  const network = JSON.parse(readFileSync(join(inputDirectory, "LEGGIMI.docx"), "utf8")) as {
    type: "FeatureCollection";
    features: Array<{ geometry: { type: string; coordinates: unknown }; properties: Record<string, unknown> }>;
  };
  const schoolRows = parseCsv(readFileSync(join(inputDirectory, "LEGGIMI.md"), "utf8"));

  const cells = new Map<string, { latitude: number; longitude: number; count: number }>();
  for (const incident of incidents) {
    const latitude = numeric(incident.Latitude);
    const longitude = numeric(incident.Longitude);
    if (latitude === null || longitude === null) continue;
    const latitudeCell = Math.floor(latitude * 100);
    const longitudeCell = Math.floor(longitude * 100);
    const key = `${latitudeCell}:${longitudeCell}`;
    const cell = cells.get(key) ?? {
      latitude: (latitudeCell + 0.5) / 100,
      longitude: (longitudeCell + 0.5) / 100,
      count: 0,
    };
    cell.count += 1;
    cells.set(key, cell);
  }

  const crashCells = [...cells.values()]
    .filter((cell) => cell.count >= 5)
    .sort((left, right) => right.count - left.count);

  const cycleNetwork = {
    type: "FeatureCollection" as const,
    features: network.features
      .filter((feature) => feature.geometry && ["LineString", "MultiLineString"].includes(feature.geometry.type))
      .map((feature, index) => ({
        type: "Feature" as const,
        id: index + 1,
        geometry: feature.geometry,
        properties: {
          Tipologia: String(feature.properties.Tipologia ?? "Altro"),
          Stato: String(feature.properties.Stato ?? "Non specificato"),
          Direzione: String(feature.properties.Direzione ?? "Non specificata"),
          Lunghezza: numeric(String(feature.properties.Lunghezza ?? "")),
        },
      })),
  };

  const locations = new Map<string, MobilityBaseline["schools"][number]>();
  for (const school of schoolRows) {
    const latitude = numeric(school.LAT);
    const longitude = numeric(school.LON);
    if (latitude === null || longitude === null) continue;
    const key = `${latitude.toFixed(5)}:${longitude.toFixed(5)}`;
    const existing = locations.get(key);
    if (existing) {
      existing.programs += 1;
    } else {
      locations.set(key, {
        id: key,
        name: school.NOME || "Sede scolastica",
        latitude,
        longitude,
        programs: 1,
      });
    }
  }
  const schools = [...locations.values()];

  return {
    stats: {
      historicalIncidents: incidents.length,
      cycleNetworkSegments: cycleNetwork.features.length,
      schoolLocations: schools.length,
      minimumCellCount: 5,
    },
    crashCells,
    cycleNetwork,
    schools,
  };
}
