import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, expectTypeOf, it } from "vitest";
import { metadata } from "../../app/layout";
import CanonicalHome from "../../app/page";
import PublicFeed from "../../components/feed/PublicFeed";
import {
  projectFeedEvent,
  type FeedEvent,
  type PublicFeedDto,
} from "../../lib/server/dal/feed";

const protectedFixture = "private thesis text";
const ciphertextFixture = "ciphertext:private-thesis-envelope";

const protectedEvent: FeedEvent = {
  id: "event-private-source",
  accountId: "account-private",
  type: "brain.response.completed",
  createdAt: "2026-08-12T14:30:00.000Z",
  topic: "Market structure",
  protectedText: protectedFixture,
};

describe("public homepage", () => {
  it("serves the protected-word-safe shell from the canonical root route", async () => {
    const markup = renderToStaticMarkup(await CanonicalHome());

    expect(markup).toContain("Sample public activity");
    expect(markup).toContain("Freshness: static sample (not live)");
    expect(markup).not.toContain("The live market conversation");
    expect(markup).toContain('data-testid="feed-placeholder"');
    expect(markup).toContain("How memory works");
    expect(markup).not.toContain(protectedFixture);
    expect(markup).not.toContain(ciphertextFixture);
  });

  it("publishes the canonical production URL", () => {
    expect(metadata).toMatchObject({
      alternates: { canonical: "/" },
      metadataBase: new URL("https://gustavo.lol"),
    });
  });

  it("shows Gustavo and safe activity placeholders without protected words", async () => {
    const markup = renderToStaticMarkup(await CanonicalHome());

    expect(markup).toContain("<main");
    expect(markup).toContain("<h1>Gustavo</h1>");
    expect(markup).toContain("The market thinks out loud.");
    expect(markup).toContain("https://gustavo.lol");
    expect(
      markup.match(/data-testid="feed-placeholder"/g)?.length ?? 0,
    ).toBeGreaterThan(0);
    expect(markup).toContain("Educational market commentary");
    expect(markup).toContain("software memory");
    expect(markup).toContain("not sentient");
    expect(markup).not.toContain(protectedFixture);
  });

  it("renders only the public DTO boundary into text, attributes, and serialized markup", () => {
    const publicEvent = projectFeedEvent({ role: "PUBLIC" }, protectedEvent);
    const markup = renderToStaticMarkup(<PublicFeed events={[publicEvent]} />);
    const serializedBoundary = JSON.stringify({ publicEvent, markup });

    expectTypeOf<ComponentProps<typeof PublicFeed>["events"]>()
      .toEqualTypeOf<readonly PublicFeedDto[]>();
    expect(serializedBoundary).not.toContain(protectedFixture);
    expect(serializedBoundary).not.toContain(ciphertextFixture);
    expect(serializedBoundary).not.toContain("protectedText");
    expect(markup).not.toMatch(/<script\b/i);
    expect(markup).toContain("width:65%");
    expect(markup).toContain('aria-labelledby="public-activity-heading"');
    expect(markup).toContain('<time dateTime="2026-08-12T14:30:00.000Z"');
    expect(markup).toContain('aria-label="Activity placeholder for Market structure"');
  });

  it("keeps loading and empty states safe and accessible", () => {
    const loadingMarkup = renderToStaticMarkup(
      <PublicFeed events={[]} status="loading" />,
    );
    const emptyMarkup = renderToStaticMarkup(<PublicFeed events={[]} />);

    expect(loadingMarkup).toContain('aria-busy="true"');
    expect(loadingMarkup).toContain("Loading public activity");
    expect(emptyMarkup).toContain("No public activity yet");
    expect(`${loadingMarkup}${emptyMarkup}`).not.toContain(protectedFixture);
    expect(`${loadingMarkup}${emptyMarkup}`).not.toContain(ciphertextFixture);
  });
});
