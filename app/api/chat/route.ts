import { openai } from '@ai-sdk/openai';
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  stepCountIs,
  streamText,
  tool,
  type InferUITools,
  type UIDataTypes,
  type UIMessage,
} from 'ai';
import { z } from 'zod';
import {
  CATEGORIES,
  getListingById,
  PRICE_TIERS,
  searchListings,
  VALID_TAGS,
  type Listing,
} from '@/lib/listings';
import {
  buildSystemPrompt,
  citiesNamedIn,
  hasPriceIntent,
  namesUncoveredLocation,
  validateOutput,
} from '@/lib/guardrails';
import { DISCLAIMER, type ChatUIMessage } from '@/lib/contract';
import { logToolCall } from '@/lib/logging';

export const maxDuration = 30;

const MODEL = process.env.CHAT_MODEL ?? 'gpt-4o-mini';

/** Per-turn scope flags the tools set and the validator reads. */
interface TurnScope {
  /** A search filtered by a city the user never asked about (out-of-scope location). */
  requestedUnavailableCity: boolean;
}

/**
 * Builds the per-request tool set. The tools close over `approved` — the set of
 * listings the model has retrieved this turn — which is the ONLY data the final
 * output is allowed to reference. Each tool records what it returns.
 */
function buildTools(approved: Map<string, Listing>, userText: string, scope: TurnScope) {
  const remember = (results: Listing[]) => {
    for (const l of results) approved.set(l.id, l);
  };

  return {
    searchListings: tool({
      description:
        'Search the fixed local listings dataset. This is the ONLY way to find places. ' +
        'Returns whole listings. Never recommend anything not returned here.',
      inputSchema: z.object({
        query: z.string().optional().describe('Free-text keywords (name, cuisine, vibe). Put the category/cuisine here, NOT in tags.'),
        category: z.enum(CATEGORIES).optional().describe('Filter by listing category (dining, lodging, attraction, venue).'),
        city: z.string().optional().describe('Filter by city, e.g. Brookline, Cape Vernon, Ridgeway.'),
        priceTier: z.enum(PRICE_TIERS).optional().describe('Filter by price tier.'),
        tags: z.array(z.string()).optional().describe(
          `Preferred tags to match and rank by (not all are required). Known dataset tags: ${[...VALID_TAGS].sort().join(', ')}. Put the category/cuisine in query or category, not here.`,
        ),
        limit: z.number().int().positive().max(18).optional(),
      }),
      execute: async (params) => {
        const named = citiesNamedIn(userText);

        // Out-of-scope location: the user named a place we don't cover (e.g.
        // "dinner in Paris"). Flag it and return nothing so the model refuses
        // instead of showing other cities' listings.
        if (named.length === 0 && namesUncoveredLocation(userText)) {
          scope.requestedUnavailableCity = true;
          logToolCall('searchListings', []);
          return { count: 0, listings: [] };
        }

        // Effective city: the city the user actually named (one of them), or none
        // — meaning search across EVERY city. When the user doesn't name a city we
        // don't guess or ask; we just search all of them.
        const city =
          named.length === 1
            ? named[0]
            : named.length > 1 && params.city &&
                named.some((c) => c.toLowerCase() === params.city!.toLowerCase())
              ? params.city
              : undefined;

        // The model also tends to add a price filter the user never asked for
        // (e.g. "$"), which silently narrows results. Honor it only when the user
        // actually expressed a price preference.
        const priceTier = hasPriceIntent(userText) ? params.priceTier : undefined;

        const results = searchListings({ ...params, city, priceTier });
        remember(results);
        logToolCall('searchListings', results.map((l) => l.id));
        return { count: results.length, listings: results };
      },
    }),

    getListingById: tool({
      description: 'Fetch a single listing by its exact id. Returns null if the id is not in the dataset.',
      inputSchema: z.object({ id: z.string().describe('A listing id, e.g. "din-001".') }),
      execute: async ({ id }) => {
        const listing = getListingById(id) ?? null;
        if (listing) remember([listing]);
        logToolCall('getListingById', listing ? [listing.id] : []);
        return { found: listing !== null, listing };
      },
    }),
  };
}

export type ChatTools = InferUITools<ReturnType<typeof buildTools>>;
export type AppUIMessage = UIMessage<never, UIDataTypes, ChatTools>;

export async function POST(req: Request) {
  const { messages }: { messages: ChatUIMessage[] } = await req.json();

  // The latest user message, used to keep recommendations on the requested city.
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const userText = (lastUser?.parts ?? [])
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join(' ');

  // Per-turn approved set: the tools populate this; the validator enforces it.
  const approved = new Map<string, Listing>();
  const scope: TurnScope = { requestedUnavailableCity: false };
  const tools = buildTools(approved, userText, scope);

  const result = streamText({
    model: openai(MODEL),
    system: buildSystemPrompt(),
    messages: await convertToModelMessages(messages),
    tools,
    // Allow: tool call -> (optional) tool call -> final answer.
    stopWhen: stepCountIs(5),
    temperature: 0.2,
  });

  const stream = createUIMessageStream<ChatUIMessage>({
    execute: async ({ writer }) => {
      // Stream the conversational text live. Hold back the message-finish so we
      // can append the validated listing data as the final part of the message.
      writer.merge(
        result.toUIMessageStream<ChatUIMessage>({ sendFinish: false, sendReasoning: false }),
      );

      // Wait for generation to complete, then validate against the approved set.
      const finalText = await result.text;
      const { references, violations } = validateOutput(finalText, approved, {
        userText,
        requestedUnavailableCity: scope.requestedUnavailableCity,
      });

      writer.write({
        type: 'data-listings',
        data: { references, disclaimer: DISCLAIMER, violations },
      });

      // We suppressed the model's message-finish above so the data part lands
      // last; emit the terminal finish now that the message is complete.
      writer.write({ type: 'finish' });
    },
    onError: (error) => {
      console.error('chat stream error', error);
      return 'Something went wrong while generating a recommendation. Please try again.';
    },
  });

  return createUIMessageStreamResponse({ stream });
}
