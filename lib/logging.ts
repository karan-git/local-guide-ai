/**
 * Minimal structured logger for guardrail events. In production this would go to
 * a real sink (Datadog, etc.); here it writes one JSON line to stderr so attempts
 * to push the assistant off its dataset are auditable.
 */

export type ViolationType =
  | 'unapproved-id' // a listing id not present in this turn's approved tool results
  | 'unapproved-url' // a URL not present in the approved dataset
  | 'invalid-id' // an id that does not exist in the dataset at all
  | 'out-of-scope-city' // a card for a location the user asked about that isn't covered
  | 'city-mismatch'; // a card whose city differs from the city the user named

export interface Violation {
  type: ViolationType;
  value: string;
  detail: string;
}

export function logViolation(v: Violation): void {
  console.warn(
    JSON.stringify({ level: 'warn', event: 'guardrail.violation', ...v, at: new Date().toISOString() }),
  );
}

export function logToolCall(tool: string, returnedIds: string[]): void {
  console.info(
    JSON.stringify({ level: 'info', event: 'tool.call', tool, returnedIds, at: new Date().toISOString() }),
  );
}
