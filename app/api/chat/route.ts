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
import { buildSystemPrompt, validateOutput } from '@/lib/guardrails';
import { DISCLAIMER, type ChatUIMessage } from '@/lib/contract';
import { logToolCall } from '@/lib/logging';

export const maxDuration = 30;

const MODEL = process.env.CHAT_MODEL ?? 'gpt-4o-mini';

/**
 * Builds the per-request tool set. The tools close over `approved` — the set of
 * listings the model has retrieved this turn — which is the ONLY data the final
 * output is allowed to reference. Each tool records what it returns.
 */
function buildTools(approved: Map<string, Listing>) {
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
        const results = searchListings(params);
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

  // Per-turn approved set: the tools populate this; the validator enforces it.
  const approved = new Map<string, Listing>();
  const tools = buildTools(approved);

  const result = streamText({
    model: openai(MODEL),
    system: buildSystemPrompt(),
    messages: await convertToModelMessages(messages),
    tools,
    // Allow: tool call -> (optional) tool call -> final answer.
    stopWhen: stepCountIs(5),
    temperature: 0.2,
    // Force a fresh data lookup on the first step of EVERY turn. Without this,
    // gpt-4o-mini sometimes answers "no options" from chat history instead of
    // querying the dataset, so the same question succeeds or fails depending on
    // what was asked before. Requiring a tool call makes each turn self-contained.
    prepareStep: ({ stepNumber }) =>
      stepNumber === 0
        ? { toolChoice: { type: 'tool', toolName: 'searchListings' } }
        : {},
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
      const { references, violations } = validateOutput(finalText, approved);

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
