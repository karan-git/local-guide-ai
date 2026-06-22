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
 * Pure, deterministic filter over the dataset. No model, no network.
 * Returns whole listings so the model never has to reconstruct any field.
 */
export function searchListings(params: SearchParams): Listing[] {
  const q = params.query ? norm(params.query) : undefined;
  const category = params.category ? norm(params.category) : undefined;
  const city = params.city ? norm(params.city) : undefined;
  const priceTier = params.priceTier ? norm(params.priceTier) : undefined;
  const wantedTags = params.tags?.map(norm) ?? [];
  const limit = params.limit && params.limit > 0 ? params.limit : 8;

  const scored = LISTINGS.filter((l) => {
    if (category && norm(l.category) !== category) return false;
    if (city && norm(l.city) !== city) return false;
    if (priceTier && norm(l.priceTier) !== priceTier) return false;
    if (wantedTags.length && !wantedTags.every((t) => l.tags.map(norm).includes(t))) {
      return false;
    }
    if (q) {
      const haystack = norm(`${l.name} ${l.blurb} ${l.tags.join(' ')} ${l.city} ${l.category}`);
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  return scored.slice(0, limit);
}
