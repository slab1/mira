/**
 * Provider System — Pricing (thin re-export).
 *
 * The single source of truth is `gateway/pricing.ts` (PRICING_TABLE + priceFor).
 * The former `costForModel` / `pricingForProvider` / `costCapCheck` /
 * `estimateCost` helpers were removed 2026-10-12: every one of them had zero
 * callers, and the cost math they duplicated is already inline in
 * `gateway/subgateway.ts` (per-task/per-session caps use priceFor directly).
 * The usage-stats re-exports (createUsageStats/record/GatewayStatsStore) went
 * with them — the live stats collector is `gateway/stats.ts`.
 */
export { priceFor, PRICING_TABLE } from '../gateway/pricing.js'
