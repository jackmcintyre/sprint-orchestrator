import type { PlanningAdapter } from "./adapter.js";
/**
 * Registered planning adapters, in declaration order. The workspace
 * resolver (Story 1.2) iterates this list for first-run `detect()`.
 * Story 3.1 implements `getActiveAdapter()` on top.
 */
export declare const adapters: PlanningAdapter[];
/**
 * Resolve the active planning adapter for the current repo.
 *
 * Real implementation lands in Story 3.1.
 */
export declare function getActiveAdapter(): PlanningAdapter;
