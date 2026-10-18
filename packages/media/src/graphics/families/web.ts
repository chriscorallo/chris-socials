import { lines, spec, type FamilySizer, type Spec } from "./types";

/**
 * SEARCH & WEB + NEWS & MEDIA family — generic search/browser/news/media UI (no search-engine,
 * browser, network or streaming-service marks, colours or layouts; outlet names in "As seen in"
 * are editable placeholders drawn as neutral type). Field mapping:
 *
 * SEARCH_BAR   title = the query (types itself) · subtitle = engine name (a neutral placeholder,
 *              default none) · items: TYPING = suggestions (text) · RESULTS = results (text =
 *              title, meta = URL, sub = snippet) · ASK = "People also ask" questions (text,
 *              sub = answer for the highlighted one, which expands) · SPOTLIGHT = command
 *              palette results (text, meta = kind, icon). highlight = the one that gets tapped.
 * BROWSER      meta = URL (types in) · subtitle = site name · title = page headline · body =
 *              page text. WINDOW · LOADING (progress) · ERROR (title "404", body) · COOKIE
 *              (cookie-banner gag: body = notice, items = buttons, highlight = tapped).
 * WEB_CARD     LINK (meta = domain, title, body, items[0].icon = image glyph) · WIKI (encyclopedia
 *              definition box: title = term, subtitle = pronunciation / kind, body = definition,
 *              items = facts text/sub) · REVIEW (title = reviewer, items[0].value = stars,
 *              body = review, meta = date) · PRODUCT (title, subtitle, items[0].value = price,
 *              items[1].value = rating).
 * NEWS         BREAKING (title = headline, subtitle = tag "BREAKING", meta = "LIVE · 9:41",
 *              items = ticker headlines) · HEADLINE (meta = kicker, title, subtitle = dek) ·
 *              FRONT_PAGE (meta = masthead, title = headline, subtitle = dateline, body = lead) ·
 *              ARTICLE (title, body, items[0].text = the phrase that gets highlighted, meta =
 *              source) · CLIPPINGS (items = headlines, meta = outlet) · AS_SEEN (title = "As seen
 *              in", items = outlet names as neutral wordmarks).
 * MEDIA_PLAYER PODCAST (title = episode, subtitle = show, meta = "EP 42 · 38 min", waveform) ·
 *              MUSIC (title = track, subtitle = artist, items[0].value = progress %) ·
 *              TITLE_CARD (title, subtitle, meta = "2026 · Limited series", items = badges) ·
 *              VOICE (voice memo: title, meta = timer).
 */
export const WEB_SPECS = {
  SEARCH_BAR: spec("SEARCH_BAR", "Search", "A query typing itself, suggestions, results, 'people also ask'", "SEARCH_WEB", [["TYPING", "Typing + suggestions"], ["RESULTS", "Results"], ["ASK", "People also ask"], ["SPOTLIGHT", "Command search"]], {
    title: true,
    subtitle: true,
    tone: true,
    quick: "QUERY",
    items: { count: [0, 6], sub: true, icon: true, meta: "URL / kind" },
    highlight: "ITEMS",
    titleRequired: true,
    labels: { title: "Search query", subtitle: "Search engine name (optional)", text: "Suggestion / result", sub: "Snippet / answer", entries: "Suggestions / results" },
  }, { preferY: 0.32, toneDefault: "LIGHT" }),
  BROWSER: spec("BROWSER", "Browser", "Browser window, loading, 404, cookie banner", "SEARCH_WEB", [["WINDOW", "Window"], ["LOADING", "Loading"], ["ERROR", "404"], ["COOKIE", "Cookie banner"]], {
    title: true,
    subtitle: true,
    body: true,
    meta: "URL",
    tone: true,
    items: { count: [0, 3] },
    highlight: "ITEMS",
    labels: { title: "Headline", subtitle: "Site name", body: "Page text", text: "Button", entries: "Buttons" },
  }, { preferY: 0.36, toneDefault: "LIGHT" }),
  WEB_CARD: spec("WEB_CARD", "Web card", "Link preview, encyclopedia box, review, product", "SEARCH_WEB", [["LINK", "Link preview"], ["WIKI", "Encyclopedia"], ["REVIEW", "Review"], ["PRODUCT", "Product"]], {
    title: true,
    subtitle: true,
    body: true,
    meta: "Domain / date",
    tone: true,
    items: { count: [0, 4], value: true, sub: true, icon: true },
    labels: { title: "Title / term", subtitle: "Second line", body: "Text", text: "Fact", sub: "Value", value: "Number", entries: "Facts" },
  }, { preferY: 0.36, toneDefault: "LIGHT" }),
  NEWS: spec("NEWS", "News", "Breaking bar + ticker, headline, front page, highlighted article", "NEWS_MEDIA", [["BREAKING", "Breaking"], ["HEADLINE", "Headline"], ["FRONT_PAGE", "Front page"], ["ARTICLE", "Article quote"], ["CLIPPINGS", "Clippings"], ["AS_SEEN", "As seen in"]], {
    title: true,
    subtitle: true,
    body: true,
    meta: "Source / kicker",
    tone: true,
    items: { count: [0, 6], meta: "Outlet" },
    labels: { title: "Headline", subtitle: "Tag / dek", body: "Article text", text: "Headline / outlet", entries: "Ticker / outlets" },
  }, { preferY: 0.4 }),
  MEDIA_PLAYER: spec("MEDIA_PLAYER", "Media player", "Podcast episode, now playing, title card, voice memo", "NEWS_MEDIA", [["PODCAST", "Podcast"], ["MUSIC", "Now playing"], ["TITLE_CARD", "Title card"], ["VOICE", "Voice memo"]], {
    title: true,
    subtitle: true,
    meta: "Details",
    tone: true,
    ownFormat: true,
    items: { count: [0, 4], value: true },
    labels: { title: "Title", subtitle: "Show / artist", text: "Badge", value: "Progress %", entries: "Badges" },
  }, { preferY: 0.38 }),
} satisfies Record<string, Spec>;

export const webSize: FamilySizer = (p, v, head) => {
  const nI = p.items.length;
  switch (p.component) {
    case "SEARCH_BAR":
      if (v === "RESULTS") return { width: 960, height: 200 + p.items.reduce((a, it) => a + 104 + Math.min(2, lines(it.sub, 40, 2)) * 42 + 26, 0) };
      if (v === "ASK") return { width: 960, height: 150 + Math.max(1, nI) * 110 + Math.min(4, lines(p.items[p.highlight ?? 0]?.sub, 40, 4)) * 44 + 40 };
      if (v === "SPOTLIGHT") return { width: 920, height: 170 + Math.max(1, nI) * 104 + 30 };
      return { width: 940, height: (p.subtitle ? 110 : 0) + 170 + nI * 96 + 30 };
    case "BROWSER":
      if (v === "LOADING") return { width: 900, height: 420 };
      if (v === "COOKIE") return { width: 940, height: 200 + lines(p.body, 34, 4) * 46 + 120 };
      if (v === "ERROR") return { width: 900, height: 720 };
      return { width: 940, height: 900 };
    case "WEB_CARD":
      if (v === "WIKI") return { width: 920, height: 220 + lines(p.body, 34, 6) * 46 + nI * 70 + 40 };
      if (v === "REVIEW") return { width: 900, height: 250 + lines(p.body, 32, 5) * 48 };
      if (v === "PRODUCT") return { width: 860, height: 880 };
      return { width: 900, height: 470 + 70 + lines(p.title, 30, 2) * 54 + lines(p.body, 38, 2) * 42 + 30 };
    case "NEWS":
      if (v === "BREAKING") return { width: 1040, height: 330 };
      if (v === "FRONT_PAGE") return { width: 900, height: 1150 };
      if (v === "ARTICLE") return { width: 920, height: 230 + lines(p.title, 26, 2) * 60 + lines(p.body, 34, 7) * 52 };
      if (v === "CLIPPINGS") return { width: 980, height: 260 + Math.max(1, nI) * 170 };
      if (v === "AS_SEEN") return { width: 1000, height: (p.title ? 120 : 0) + Math.ceil(Math.max(1, nI) / 3) * 120 + 40 };
      return { width: 920, height: 520 + 60 + lines(p.title, 24, 3) * 64 + (p.subtitle ? 90 : 0) };
    case "MEDIA_PLAYER":
      if (v === "TITLE_CARD") return { width: 1000, height: 640 };
      if (v === "VOICE") return { width: 900, height: 400 };
      if (v === "MUSIC") return { width: 860, height: 1040 };
      return { width: 940, height: 420 };
    default:
      void head;
      return null;
  }
};
