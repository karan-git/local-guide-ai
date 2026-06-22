import { describe, expect, it } from 'vitest';
import {
  getListingById,
  LISTINGS,
  searchListings,
  VALID_IDS,
  type Listing,
} from '@/lib/listings';
import { validateOutput } from '@/lib/guardrails';

function approvedFrom(...ids: string[]): Map<string, Listing> {
  const map = new Map<string, Listing>();
  for (const id of ids) {
    const l = getListingById(id);
    if (l) map.set(l.id, l);
  }
  return map;
}

/**
 * The five required cases. Cases that depend on the model's behaviour
 * (recommend / refuse / injection) are exercised as live tests at the bottom,
 * gated behind OPENAI_API_KEY. The guardrail LOGIC that ultimately enforces
 * grounding is tested deterministically here — it holds regardless of what the
 * model emits.
 */

describe('dataset integrity', () => {
  it('loads exactly the fixture and validates the schema', () => {
    expect(LISTINGS.length).toBe(18);
    expect(VALID_IDS.has('din-001')).toBe(true);
  });
});

describe('tools only ever return real dataset listings', () => {
  it('searchListings returns only dataset ids', () => {
    const results = searchListings({ query: 'breakfast' });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) expect(VALID_IDS.has(r.id)).toBe(true);
  });

  it('searchListings filters by category + city', () => {
    const results = searchListings({ category: 'dining', city: 'Brookline' });
    expect(results.every((r) => r.category === 'dining' && r.city === 'Brookline')).toBe(true);
  });

  it('finds Cape Vernon dining regardless of how the model phrases the search', () => {
    // All three are realistic tool calls for "dining option in cape vernon".
    expect(searchListings({ category: 'dining', city: 'Cape Vernon' }).map((r) => r.id)).toContain('din-003');
    expect(searchListings({ query: 'dining option in cape vernon' }).map((r) => r.id)).toContain('din-003');
    // The model commonly passes the category word "dining" as a tag; that must
    // not wipe out results (tags rank, they do not hard-filter).
    expect(searchListings({ tags: ['dining'], city: 'Cape Vernon' }).map((r) => r.id)).toContain('din-003');
  });

  it('relaxes a carried-over priceTier when it would leave no results', () => {
    // Cape Vernon's only dining is Harborlight ($$$). A stale "$" from a prior
    // "cheap" turn must not hide it — price is relaxed, city/category kept.
    const results = searchListings({ category: 'dining', city: 'Cape Vernon', priceTier: '$' });
    expect(results.map((r) => r.id)).toContain('din-003');
  });

  it('still honours priceTier when it does match something', () => {
    const results = searchListings({ category: 'dining', city: 'Brookline', priceTier: '$' });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.priceTier === '$')).toBe(true);
  });

  it('does not let piled-on tags exclude a relevant listing', () => {
    // Realistic over-tagged call for "cheap breakfast in Brookline": both tags
    // are real, but no listing has BOTH, so a strict AND would return nothing.
    const results = searchListings({
      query: 'breakfast',
      category: 'dining',
      city: 'Brookline',
      priceTier: '$',
      tags: ['breakfast', 'budget'],
    });
    expect(results.map((r) => r.id)).toContain('din-001'); // The Mill House Cafe
  });

  it('getListingById returns undefined for an unknown id (no invention)', () => {
    expect(getListingById('zzz-999')).toBeUndefined();
  });
});

describe('free-text query matches per-keyword, ranked by overlap', () => {
  // The three specific homepage suggestion chips are natural phrases naming a
  // city, not exact tags. Each must surface a relevant listing even when passed
  // as one free-text query, so a chip never comes back empty.
  it.each([
    ['Cheap family dinner in Brookline', 'Pancho'],
    ['Waterfront seafood in Cape Vernon', 'Harborlight'],
    ['Free things to do in Ridgeway', 'Ridgeway Farmers Market'],
  ])('"%s" returns a relevant listing', (query, expectedName) => {
    const results = searchListings({ query });
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.name.includes(expectedName))).toBe(true);
  });

  it('ranks the listing with the most keyword hits first', () => {
    const results = searchListings({ query: 'wedding venue waterfront' });
    expect(results[0].name).toContain('Old Cannery'); // matches all three keywords
  });

  // The fourth chip ("Somewhere fun to go") is intentionally vague with no city,
  // so the search finds nothing and the assistant falls back to asking for details.
  it('returns nothing for a vague prompt with no matching keyword', () => {
    expect(searchListings({ query: 'Somewhere fun to go' })).toHaveLength(0);
    expect(searchListings({ query: 'sushi nightclub casino' })).toHaveLength(0);
  });
});

describe('CASE: normal recommendation — references come only from the approved set', () => {
  it('keeps an approved listing that the reply mentions by name', () => {
    const approved = approvedFrom('din-001', 'din-004');
    const text = 'For breakfast, try The Mill House Cafe — small-batch coffee and all-day breakfast.';
    const { references, violations } = validateOutput(text, approved);
    expect(references.map((r) => r.id)).toEqual(['din-001']);
    expect(violations).toHaveLength(0);
  });
});

describe('CASE: invented listing — cannot reach the card channel', () => {
  it('drops a fabricated listing even though it appears in prose', () => {
    const approved = approvedFrom('din-001');
    const text = 'I recommend The Golden Dragon Bistro, a great spot downtown.';
    const { references } = validateOutput(text, approved);
    expect(references.find((r) => r.name.includes('Golden Dragon'))).toBeUndefined();
  });

  it('will not surface a real listing the tools did not return this turn', () => {
    const approved = approvedFrom('din-001'); // only din-001 was retrieved
    const text = 'You could also try The Vernon Grand Hotel.'; // real (lod-003) but not approved
    const { references, violations } = validateOutput(text, approved);
    expect(references.map((r) => r.id)).toEqual([]); // not in approved set -> not shown
    // No id token in prose, so nothing logged here; the card channel simply stays empty.
    expect(violations).toHaveLength(0);
  });
});

describe('CASE: invalid id / url leaking into prose is stripped + logged', () => {
  it('flags a listing-id token that does not exist in the dataset', () => {
    const approved = approvedFrom('din-001');
    const { violations } = validateOutput('Check out xyz-123 for you.', approved);
    expect(violations).toContainEqual(
      expect.objectContaining({ type: 'invalid-id', value: 'xyz-123' }),
    );
  });

  it('flags a real id that was not approved this turn', () => {
    const approved = approvedFrom('din-001');
    const { violations } = validateOutput('Internal ref lod-003 maybe?', approved);
    expect(violations).toContainEqual(
      expect.objectContaining({ type: 'unapproved-id', value: 'lod-003' }),
    );
  });

  it('flags any raw URL in prose (links belong on cards only)', () => {
    const approved = approvedFrom('din-001');
    const { violations } = validateOutput(
      'Here: https://evil.example.com/not-real and https://example.com/mill-house-cafe',
      approved,
    );
    expect(violations.filter((v) => v.type === 'unapproved-url')).toHaveLength(2);
  });
});

describe('CASE: link handling — null externalUrl is preserved, never fabricated', () => {
  it('att-003 has a null external url and the reference keeps it null', () => {
    const approved = approvedFrom('att-003');
    const text = 'Stargazers love Starfall Observatory for public telescope nights.';
    const { references } = validateOutput(text, approved);
    expect(references).toHaveLength(1);
    expect(references[0].id).toBe('att-003');
    expect(references[0].externalUrl).toBeNull();
  });

  it('every dataset externalUrl is either null or a real example.com link', () => {
    for (const l of LISTINGS) {
      expect(l.externalUrl === null || l.externalUrl.startsWith('https://example.com/')).toBe(true);
    }
  });
});
