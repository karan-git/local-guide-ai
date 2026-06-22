import { z } from 'zod';
import rawData from '@/sample-listings.json';

/**
 * The dataset is the ONLY source of truth the assistant may use. Everything in
 * this module is derived from `sample-listings.json` at load time. Nothing here
 * reaches out to the network or invents data.
 */

export const CATEGORIES = ['dining', 'lodging', 'attraction', 'venue'] as const;
export const PRICE_TIERS = ['free', '$', '$$', '$$$', '$$$$'] as const;

export const ListingSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.enum(CATEGORIES),
  city: z.string(),
  tags: z.array(z.string()),
  priceTier: z.enum(PRICE_TIERS),
  blurb: z.string(),
  // Some listings legitimately have no external link (e.g. att-003).
  externalUrl: z.string().url().nullable(),
});

export type Listing = z.infer<typeof ListingSchema>;
export type Category = (typeof CATEGORIES)[number];
export type PriceTier = (typeof PRICE_TIERS)[number];

const DatasetSchema = z.object({
  listings: z.array(ListingSchema),
});

// Fail fast at startup if the fixture is malformed or drifts from the schema.
const dataset = DatasetSchema.parse(rawData);

/** Immutable, validated source of truth. */
export const LISTINGS: readonly Listing[] = Object.freeze(dataset.listings);

const BY_ID = new Map(LISTINGS.map((l) => [l.id, l]));

/** Facets derived from the data, used to describe the dataset to the model. */
export const FACETS = {
  categories: [...new Set(LISTINGS.map((l) => l.category))].sort(),
  cities: [...new Set(LISTINGS.map((l) => l.city))].sort(),
  priceTiers: [...new Set(LISTINGS.map((l) => l.priceTier))],
  tags: [...new Set(LISTINGS.flatMap((l) => l.tags))].sort(),
};

/** Every listing id that exists in the approved dataset. */
export const VALID_IDS: ReadonlySet<string> = new Set(BY_ID.keys());

/** Every external URL that exists in the approved dataset (nulls excluded). */
export const VALID_URLS: ReadonlySet<string> = new Set(
  LISTINGS.map((l) => l.externalUrl).filter((u): u is string => u !== null),
);

export function getListingById(id: string): Listing | undefined {
  return BY_ID.get(id);
}

export interface SearchParams {
  query?: string;
  category?: string;
  city?: string;
  priceTier?: string;
  tags?: string[];
  limit?: number;
}

const norm = (s: string) => s.trim().toLowerCase();

/**
 * Filler words that carry no listing signal. Dropped from free-text queries so a
 * natural phrase like "somewhere romantic for date night" matches on its content
 * words ("romantic", "date", "night") instead of failing on the whole string.
 */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'near', 'around', 'something', 'somewhere',
  'place', 'places', 'spot', 'spots', 'thing', 'things', 'some', 'any',
  'good', 'nice', 'best', 'find', 'show', 'want', 'looking', 'need', 'where',
  'what', 'that', 'this', 'have', 'about', 'from', 'into',
]);

/**
 * Split a free-text query into meaningful keyword tokens: lowercase words of at
 * least three characters that aren't filler. Used for partial / multi-word
 * matching against listings.
 */
function tokenize(query: string): string[] {
  return [
    ...new Set(
      norm(query)
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 3 && !STOP_WORDS.has(t)),
    ),
  ];
}

/**
 * Pure, deterministic filter over the dataset. No model, no network.
 * Returns whole listings so the model never has to reconstruct any field.
 *
 * Free-text `query` matches per-keyword (not as one contiguous string): a
 * listing is kept if ANY query token appears in its searchable text, and results
 * are ranked by how many distinct tokens match so the most relevant come first.
 */
export function searchListings(params: SearchParams): Listing[] {
  const category = params.category ? norm(params.category) : undefined;
  const city = params.city ? norm(params.city) : undefined;
  const priceTier = params.priceTier ? norm(params.priceTier) : undefined;
  const wantedTags = params.tags?.map(norm) ?? [];
  const tokens = params.query ? tokenize(params.query) : [];
  const limit = params.limit && params.limit > 0 ? params.limit : 8;

  const matched = LISTINGS.map((l, index) => {
    if (category && norm(l.category) !== category) return null;
    if (city && norm(l.city) !== city) return null;
    if (priceTier && norm(l.priceTier) !== priceTier) return null;
    if (wantedTags.length && !wantedTags.every((t) => l.tags.map(norm).includes(t))) {
      return null;
    }

    let score = 0;
    if (tokens.length) {
      const haystack = norm(`${l.name} ${l.blurb} ${l.tags.join(' ')} ${l.city} ${l.category}`);
      score = tokens.filter((t) => haystack.includes(t)).length;
      // With keywords given, a listing must match at least one to be relevant.
      if (score === 0) return null;
    }

    return { listing: l, score, index };
  }).filter((m): m is { listing: Listing; score: number; index: number } => m !== null);

  // Highest token-overlap first; stable by dataset order for equal scores.
  matched.sort((a, b) => b.score - a.score || a.index - b.index);

  return matched.slice(0, limit).map((m) => m.listing);
}
