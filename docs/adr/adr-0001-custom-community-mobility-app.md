---
status: "Accepted"
date: "2026-10-17"
authors: "Alessio Andriulo"
tags: ["architecture", "community", "mobility"]
supersedes: ""
superseded_by: ""
---

# ADR-0001: Custom Community Mobility App

## Status

Accepted

## Context

The hackathon outcome must be a citizen-facing mobility service for Lecce, not an internal analytics solution. The supplied datasets are historical and cannot provide live reports. The user explicitly ruled out Microsoft Fabric. Reports that can reach public-safety staff also require verification, privacy controls, and an authorized municipal workflow.

## Decision

Build a custom, mobile-first Progressive Web App with a Node.js/TypeScript API. Store reports and their lifecycle in a custom database; use a transactional outbox and server-sent events (SSE) for reliable processing and live UI updates. Keep new reports private until an operator verifies them. Do not dispatch raw citizen reports directly to the Polizia Locale. The local prototype may use Node's built-in SQLite; PostgreSQL/PostGIS is the production database target. No Fabric components are part of the product.

## Consequences

### Positive

- Citizens can open the service by link without an app-store installation.
- The API and event lifecycle remain under project control and can evolve independently of analytics platforms.
- Human verification and a public/private data boundary reduce false-alert and privacy risks.

### Negative

- The team owns hosting, monitoring, security, retention, abuse prevention, and operational support.
- Direct police notification cannot be enabled until the Comune approves the workflow and provides an authorized integration channel.
- SQLite is suitable only for the local demo; a public deployment needs PostgreSQL/PostGIS and managed backups.

## Alternatives Considered

### Microsoft Fabric Eventstream

**Why rejected**: The product constraint is a custom community app with no Fabric dependency.

### Automatic dispatch from every incoming report

**Why rejected**: Unverified reports can be duplicates, abusive, inaccurate, or inappropriate for police dispatch. The MVP requires operator review.

### Kafka-first microservices

**Why rejected**: It adds operational complexity before the expected traffic and integration needs are known. Start with an outbox and SSE; add a broker when measured load justifies it.

## Implementation Notes

- Report states: pending review, verified, assigned, resolved, or rejected.
- Public responses expose only verified reports at coarse location precision; exact coordinates remain restricted to the operator workflow.
- Historical incident points are aggregated and suppressed below a minimum cell count; they are not treated as live signals.
- The application is not an emergency service; urgent danger must use official emergency channels.
