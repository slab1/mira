---
name: security-threat-model
description: STRIDE-based threat modeling for new systems and integrations.
triggers:
  - threat model
  - STRIDE
  - security design
  - risk assessment
  - attack surface
---
# Security Threat Model

## STRIDE categories
- Spoofing: identity theft, token replay.
- Tampering: unauthorized modification of data in transit/at rest.
- Repudiation: lack of auditability.
- Information disclosure: sensitive data leakage.
- Denial of service: availability degradation.
- Elevation of privilege: bypassing authorization.

## Process
1. Diagram system and trust boundaries.
2. Enumerate data flows and store locations.
3. For each flow, ask STRIDE questions.
4. Rate risks: Likelihood × Impact.
5. Define mitigations and owners.
6. Verify via tests and IaC.

## Common mitigations
- AuthN: mTLS or signed JWTs, short TTL, rotation.
- AuthZ: per-object checks, principle of least privilege.
- Secrecy: TLS 1.3, encryption at rest, KMS.
- Integrity: signatures, checksums, schema validation.
- Audit: immutable logs, correlation IDs.

## Deliverables
- Threat model doc with diagram, table of threats + mitigations.
- Open issues tracked in backlog with severity.
- Repeat on major changes.
