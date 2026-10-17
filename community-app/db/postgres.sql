CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS mobility_reports (
  id UUID PRIMARY KEY,
  category TEXT NOT NULL CHECK (category IN (
    'blocked_cycle_lane', 'dangerous_crossing', 'road_obstacle',
    'collision_or_near_miss', 'other'
  )),
  location GEOGRAPHY(POINT, 4326) NOT NULL,
  description TEXT NOT NULL CHECK (char_length(description) <= 400),
  status TEXT NOT NULL CHECK (status IN (
    'pending_review', 'verified', 'assigned', 'resolved', 'rejected'
  )),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mobility_reports_location_idx
  ON mobility_reports USING GIST (location);
CREATE INDEX IF NOT EXISTS mobility_reports_status_created_idx
  ON mobility_reports (status, created_at DESC);

CREATE TABLE IF NOT EXISTS mobility_outbox (
  id UUID PRIMARY KEY,
  aggregate_id UUID NOT NULL REFERENCES mobility_reports(id),
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS mobility_outbox_pending_idx
  ON mobility_outbox (created_at) WHERE delivered_at IS NULL;
