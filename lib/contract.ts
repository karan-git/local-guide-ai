import type { UIMessage } from 'ai';
import type { Category, Listing, PriceTier } from './listings';

/**
 * ============================================================================
 * STREAMING CONTRACT (documented in README)
 * ----------------------------------------------------------------------------
 * The /api/chat route streams an AI SDK v6 UI message stream (SSE). A response
 * message is made of ordered `parts`:
 *   - `{ type: 'text', text }`        -> the conversational answer (streamed).
 *   - `{ type: 'data-listings', data }` -> the structured, server-validated
 *                                          listing references for card rendering.
 *
 * The `data-listings` part is emitted ONCE, after the text, and is the ONLY
 * authoritative source of listing ids/links. It is built server-side purely
 * from the approved tool-result set for that turn, so it can never contain an
 * invented listing or an off-dataset URL.
 * ============================================================================
 */

/** A single card-ready listing reference. Mirrors the dataset, never invented. */
export interface ListingReference {
  id: string;
  name: string;
  category: Category;
  city: string;
  priceTier: PriceTier;
  tags: string[];
  blurb: string;
  /** null when the listing has no external link in the dataset (e.g. att-003). */
  externalUrl: string | null;
}

/** Payload of the `data-listings` part. */
export interface ListingsData {
  references: ListingReference[];
  /** Always-on "AI can be wrong" notice for the UI to render. */
  disclaimer: string;
  /** Anything the validator stripped/flagged this turn (usually empty). */
  violations: { type: string; value: string; detail: string }[];
}

/** Map of custom data parts: key `listings` -> part type `data-listings`. */
export type ChatDataParts = {
  listings: ListingsData;
};

/** The fully-typed UI message used on both server and client. */
export type ChatUIMessage = UIMessage<never, ChatDataParts>;

export const DISCLAIMER =
  'AI can be wrong — please verify details (hours, prices, availability) on the listing’s own site before relying on them.';

export function toReference(l: Listing): ListingReference {
  return {
    id: l.id,
    name: l.name,
    category: l.category,
    city: l.city,
    priceTier: l.priceTier,
    tags: l.tags,
    blurb: l.blurb,
    externalUrl: l.externalUrl,
  };
}
