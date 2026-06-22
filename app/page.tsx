"use client";

import { useChat } from "@ai-sdk/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatUIMessage, ListingReference } from "@/lib/contract";

const SUGGESTIONS = [
  // Three specific prompts (with a city) that return listings...
  "Cheap family dinner in Brookline",
  "Waterfront seafood in Cape Vernon",
  "Free things to do in Ridgeway",
  // ...and one vague prompt with no city, so the assistant asks for details.
  "Somewhere fun to go",
];

export default function Home() {
  const { messages, sendMessage, status, error } = useChat<ChatUIMessage>();
  const [input, setInput] = useState("");
  const busy = status === "submitted" || status === "streaming";

  // Whether the viewport is parked near the bottom. When it is, we keep it
  // pinned as content streams in; when the user scrolls up to read, we leave
  // them alone.
  const stickToBottom = useRef(true);

  const scrollToBottom = useCallback((behavior: ScrollBehavior) => {
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior });
  }, []);

  // Track how close to the bottom the user is.
  useEffect(() => {
    const onScroll = () => {
      const { scrollHeight, scrollTop, clientHeight } =
        document.documentElement;
      stickToBottom.current = scrollHeight - (scrollTop + clientHeight) < 120;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Follow new messages / streaming tokens only while pinned to the bottom.
  useEffect(() => {
    if (stickToBottom.current) scrollToBottom("auto");
  }, [messages, status, scrollToBottom]);

  function submit(text: string) {
    const value = text.trim();
    if (!value || busy) return;
    sendMessage({ text: value });
    setInput("");
    // Sending always returns you to the bottom of the conversation.
    stickToBottom.current = true;
    requestAnimationFrame(() => scrollToBottom("smooth"));
  }

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 p-4">
      <header className="border-b border-black/10 pb-3 dark:border-white/15">
        <h1 className="text-xl font-semibold">Local Guide</h1>
        <p className="text-sm opacity-70">
          Recommends only from a fixed set of local listings. It won’t book,
          check availability, or talk about anything outside the dataset.
        </p>
      </header>

      {/* Always-visible disclaimer */}
      <p
        role="note"
        className="rounded-md bg-amber-100 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/60 dark:text-amber-200"
      >
        ⚠️ AI can be wrong — verify details (hours, prices, availability) on
        each listing’s own site before relying on them.
      </p>

      <section className="flex flex-1 flex-col gap-4" aria-live="polite">
        {messages.length === 0 && (
          <div className="flex flex-wrap gap-2">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                onClick={() => submit(s)}
                className="rounded-full border border-black/15 px-3 py-1 text-sm hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10 cursor-pointer"
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {messages.map((message, i) => (
          <Message
            key={message.id}
            message={message}
            streaming={
              busy && i === messages.length - 1 && message.role === "assistant"
            }
          />
        ))}

        {/* Waiting for the assistant's message to start (no assistant bubble yet). */}
        {status === "submitted" &&
          messages[messages.length - 1]?.role === "user" && (
            <div className="self-start">
              <div className="rounded-2xl bg-black/5 px-4 py-2.5 dark:bg-white/10">
                <ThinkingIndicator label="Thinking" />
              </div>
            </div>
          )}
        {error && (
          <p className="text-sm text-red-600">
            Something went wrong. Please try again.
          </p>
        )}
      </section>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(input);
        }}
        className="sticky bottom-0 flex gap-2 bg-[var(--background)] py-2"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask for a recommendation…"
          className="flex-1 rounded-md border border-black/15 px-3 py-2 text-sm outline-none focus:border-black/40 dark:border-white/20"
        />
        <button
          type="submit"
          disabled={busy || input.trim().length === 0}
          className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-40"
        >
          Send
        </button>
      </form>
    </main>
  );
}

function Message({
  message,
  streaming,
}: {
  message: ChatUIMessage;
  streaming: boolean;
}) {
  const isUser = message.role === "user";

  // The conversational text answer...
  const text = message.parts
    .map((p) => (p.type === "text" ? p.text : ""))
    .join("");

  // ...and the structured, server-validated cards (the authoritative listing channel).
  const references: ListingReference[] = message.parts.flatMap((p) =>
    p.type === "data-listings" ? p.data.references : [],
  );

  // Before any text arrives, show what the assistant is doing: thinking, then
  // "searching" once it has started calling a listing tool.
  const toolActive =
    !isUser && message.parts.some((p) => p.type.startsWith("tool-"));
  const showThinking = !isUser && text.length === 0;

  return (
    <div className={isUser ? "self-end" : "self-start"}>
      <div
        className={
          isUser
            ? "rounded-2xl bg-foreground px-4 py-2 text-sm text-background"
            : "rounded-2xl bg-black/5 px-4 py-2 text-sm dark:bg-white/10"
        }
      >
        {isUser ? (
          text
        ) : showThinking ? (
          <ThinkingIndicator
            label={toolActive ? "Searching the local listings" : ""}
          />
        ) : (
          <span>
            {text}
            {streaming && (
              <span
                aria-hidden
                className="ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 bg-current align-middle"
                style={{ animation: "caret-blink 1s step-end infinite" }}
              />
            )}
          </span>
        )}
      </div>

      {references.length > 0 && (
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {references.map((ref) => (
            <ListingCard key={ref.id} listing={ref} />
          ))}
        </div>
      )}
    </div>
  );
}

function ThinkingIndicator({ label }: { label: string }) {
  return (
    <span
      className="flex items-center gap-2 text-sm opacity-70"
      aria-label={`${label}…`}
    >
      <span>{label}</span>
      <span className="flex gap-1 py-2">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            aria-hidden
            className="inline-block h-1.5 w-1.5 rounded-full bg-current"
            style={{
              animation: "typing-bounce 1.2s ease-in-out infinite",
              animationDelay: `${i * 0.16}s`,
            }}
          />
        ))}
      </span>
    </span>
  );
}

function ListingCard({ listing }: { listing: ListingReference }) {
  return (
    <article className="rounded-lg border border-black/10 p-3 text-sm dark:border-white/15">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="font-semibold">{listing.name}</h3>
        <span className="shrink-0 text-xs opacity-60">{listing.priceTier}</span>
      </div>
      <p className="mt-0.5 text-xs uppercase tracking-wide opacity-60">
        {listing.category} · {listing.city}
      </p>
      <p className="mt-1 opacity-90">{listing.blurb}</p>
      {listing.tags.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1">
          {listing.tags.map((t) => (
            <li
              key={t}
              className="rounded bg-black/5 px-1.5 py-0.5 text-[10px] dark:bg-white/10 uppercase"
            >
              {t}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2">
        {listing.externalUrl ? (
          <a
            href={listing.externalUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs font-medium underline underline-offset-2"
          >
            Visit listing ↗
          </a>
        ) : (
          <span className="text-xs italic opacity-50">
            No external link available
          </span>
        )}
      </div>
    </article>
  );
}
