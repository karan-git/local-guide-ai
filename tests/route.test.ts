import { describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { simulateReadableStream } from 'ai';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';

/**
 * Route-level contract test with a MOCK model — runs without an API key.
 * It drives /api/chat through a realistic two-step flow (tool call -> text),
 * and asserts the streaming contract:
 *   1. the conversational text streams,
 *   2. a single `data-listings` part is appended AFTER the text,
 *   3. its references are exactly the validated, tool-approved listings.
 */

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 8, text: 8, reasoning: 0 },
};

function streamOf(parts: LanguageModelV3StreamPart[]) {
  return { stream: simulateReadableStream({ chunks: parts }) };
}

// Step 1: the model calls searchListings. Step 2: it answers, naming a result.
const step1: LanguageModelV3StreamPart[] = [
  { type: 'stream-start', warnings: [] },
  {
    type: 'tool-call',
    toolCallId: 'call-1',
    toolName: 'searchListings',
    input: JSON.stringify({ query: 'breakfast', city: 'Brookline' }),
  },
  { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
];

const step2: LanguageModelV3StreamPart[] = [
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: 't1' },
  { type: 'text-delta', id: 't1', delta: 'For breakfast, try The Mill House Cafe — ' },
  { type: 'text-delta', id: 't1', delta: 'small-batch coffee and all-day breakfast.' },
  { type: 'text-end', id: 't1' },
  { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
];

vi.mock('@ai-sdk/openai', () => ({
  openai: () =>
    new MockLanguageModelV3({
      doStream: vi.fn().mockResolvedValueOnce(streamOf(step1)).mockResolvedValueOnce(streamOf(step2)),
    }),
}));

interface Chunk {
  type: string;
  delta?: string;
  data?: { references: { id: string; externalUrl: string | null }[]; disclaimer: string };
}

async function drive(text: string) {
  const { POST } = await import('@/app/api/chat/route');
  const res = await POST(
    new Request('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text }] }] }),
    }),
  );

  const order: string[] = [];
  let answer = '';
  let listings: NonNullable<Chunk['data']> | undefined;
  for (const line of (await res.text()).split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6).trim();
    if (!payload || payload === '[DONE]') continue;
    const chunk = JSON.parse(payload) as Chunk;
    order.push(chunk.type);
    if (chunk.type === 'text-delta' && chunk.delta) answer += chunk.delta;
    if (chunk.type === 'data-listings' && chunk.data) listings = chunk.data;
  }
  return { order, answer, listings };
}

describe('/api/chat streaming contract (mock model)', () => {
  it('streams text, then appends validated listing references', async () => {
    const { order, answer, listings } = await drive('cheap breakfast in Brookline');

    expect(answer).toContain('The Mill House Cafe');
    expect(listings?.references.map((r) => r.id)).toEqual(['din-001']);
    expect(listings?.disclaimer).toMatch(/verify/i);

    // data-listings must come AFTER the last text-delta and BEFORE the message finish.
    const lastText = order.lastIndexOf('text-delta');
    const dataAt = order.indexOf('data-listings');
    const finishAt = order.lastIndexOf('finish');
    expect(dataAt).toBeGreaterThan(lastText);
    expect(finishAt).toBeGreaterThan(dataAt);
  });
});
