import { NotImplementedError } from "../errors.js";
import { BmadAdapter } from "./bmad/index.js";
/**
 * Registered planning adapters, in declaration order. The workspace
 * resolver (Story 1.2) iterates this list for first-run `detect()`.
 * Story 3.1 implements `getActiveAdapter()` on top.
 */
export const adapters = [BmadAdapter];
/**
 * Resolve the active planning adapter for the current repo.
 *
 * Real implementation lands in Story 3.1.
 */
export function getActiveAdapter() {
    throw new NotImplementedError("adapter registry: getActiveAdapter lands in Story 3.1");
}
