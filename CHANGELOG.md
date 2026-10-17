# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Added a custom, no-Fabric community mobility PWA with privacy-filtered historical map layers, report intake, operator verification, and live SSE updates.
- Added a home screen based on the first slide of the LecceSafe pitch deck, with device biometric unlock (WebAuthn platform authenticator) and a simple entry button for the MVP.
- Added a Dockerfile for the community app (Node 24, persistent `/data` volume) and an `export-baseline` script that writes a pre-aggregated `data/baseline.json`, so the image does not need the raw customer CSV files. `/api/baseline` now reads that file when present (`BASELINE_PATH` overrides the location).

### Changed

- Restyled the community app with the pitch-deck palette (navy `#1F3A5F`, gold `#D9A441`, cream `#FAF7F2`) and Calibri typography, replacing the Google Fonts dependency.
