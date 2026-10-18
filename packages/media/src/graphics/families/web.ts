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
 *              page text. WINDOW (skeleton → page) · LOADING (title = status, body = small line,
 *              items[0].value = where the bar stops, default 100 → check) · ERROR (title "404",
 *              body, items[0].text = button) · COOKIE (cookie-banner gag: title, body = notice,
 *              items = buttons — the highlighted one is the big one and gets tapped).
 * WEB_CARD     LINK (meta = domain, title, body, items[0].icon = image glyph) · WIKI (encyclopedia
 *              definition box: title = term, subtitle = pronunciation / kind, body = definition,
 *              items = facts text/sub) · REVIEW (title = reviewer, items[0].value = stars,
 *              subtitle = review headline, body = review, meta = date) · PRODUCT (title,
 *              subtitle, meta = badge, body = delivery line, items[0].value = price (+ sub = old
 *              price, icon = image glyph), items[1].value = rating (+ sub = rating count),
 *              items[2].text = button label).
 * NEWS         BREAKING (title = headline, subtitle = tag "BREAKING", meta = "LIVE · 9:41",
 *              items = ticker headlines) · HEADLINE (meta = kicker, title, subtitle = dek) ·
 *              FRONT_PAGE (meta = masthead, title = headline, subtitle = dateline, body = lead) ·
 *              ARTICLE (title, body, items[0].text = the phrase that gets highlighted, meta =
 *              source) · CLIPPINGS (title = header, items = headlines with meta =
 *              outlet; props.meta = default outlet) · AS_SEEN (title = "As seen
 *              in", items = outlet names as neutral wordmarks).
 * MEDIA_PLAYER PODCAST (title = episode, subtitle = show, meta = "EP 42 · 38 min", waveform) ·
 *              MUSIC (title = track, subtitle = artist, meta = "Playing from" line,
 *              items[0].value = progress %) · TITLE_CARD (title, subtitle = tagline, meta =
 *              "2026 · Limited series", items = badges) · VOICE (voice memo: title, meta = timer
 *              "m:ss" it counts up to).
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
    items: { count: [0, 3], value: true },
    highlight: "ITEMS",
    labels: { title: "Headline / status", subtitle: "Site name", body: "Page text", text: "Button", value: "Loading stops at %", entries: "Buttons" },
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
    case "SEARCH_BAR": {
      if (v === "RESULTS") return { width: 960, height: 226 + p.items.slice(0, 6).reduce((a, it) => a + 130 + lines(it.sub, 40, 2) * 42, 0) };
      if (v === "ASK") {
        const hl = p.items[p.highlight ?? -1];
        return { width: 960, height: 200 + Math.max(1, Math.min(6, nI)) * 110 + (hl?.sub ? lines(hl.sub, 40, 4) * 44 + 30 : 0) };
      }
      if (v === "SPOTLIGHT") return { width: 920, height: nI ? 160 + Math.min(6, nI) * 104 : 130 };
      return { width: 940, height: nI ? (p.subtitle ? 100 : 0) + 160 + Math.min(6, nI) * 96 : (p.subtitle ? 110 : 0) + 130 };
    }
    case "BROWSER":
      if (v === "LOADING") return { width: 900, height: 420 };
      if (v === "COOKIE") return { width: 940, height: 300 + lines(p.body, 40, 4) * 46 };
      if (v === "ERROR") return { width: 900, height: 116 + 46 + 226 + 26 + lines(p.body, 34, 3) * 46 + (p.items[0]?.text ? 122 : 0) + 44 };
      return { width: 940, height: 900 };
    case "WEB_CARD":
      if (v === "WIKI") return { width: 920, height: 48 + 80 + (p.subtitle ? 44 : 0) + 48 + Math.max(1, lines(p.body, 42, 6)) * 46 + (nI ? 22 + Math.min(4, nI) * 70 : 0) + 40 };
      if (v === "REVIEW") return { width: 900, height: 274 + lines(p.body, 40, 5) * 48 };
      if (v === "PRODUCT") {
        const it0 = p.items[0];
        const it1 = p.items[1];
        return { width: 860, height: 440 + Math.max(1, lines(p.title, 34, 2)) * 48 + (p.subtitle ? 44 : 0) + (it1?.value != null ? 60 : 0) + (it0?.value != null ? 96 : 0) + (p.body ? 48 : 0) + 152 };
      }
      return { width: 900, height: 400 + 36 + 44 + 12 + Math.max(1, lines(p.title, 30, 2)) * 53 + (p.body ? 10 + lines(p.body, 44, 2) * 42 : 0) + 36 };
    case "NEWS":
      if (v === "BREAKING") return { width: 1040, height: 320 };
      if (v === "FRONT_PAGE") return { width: 900, height: 1150 };
      if (v === "ARTICLE") return { width: 920, height: 48 + (p.meta ? 76 : 0) + lines(p.title, 30, 2) * 58 + 22 + lines(p.body, 38, 7) * 54 + 48 };
      if (v === "CLIPPINGS") return { width: 980, height: (p.title ? 110 : 30) + (Math.max(1, Math.min(5, nI)) - 1) * 182 + 196 + 30 };
      if (v === "AS_SEEN") {
        const n = Math.max(1, Math.min(6, nI));
        const cols = n <= 3 ? n : n === 4 ? 2 : 3;
        return { width: 1000, height: (p.title ? 110 : 30) + Math.ceil(n / cols) * 120 + 30 };
      }
      return { width: 920, height: 130 + Math.max(1, lines(p.title, 24, 3)) * 67 + (p.subtitle ? 20 + lines(p.subtitle, 44, 2) * 44 : 0) + 48 };
    case "MEDIA_PLAYER":
      if (v === "TITLE_CARD") return { width: 1000, height: 640 };
      if (v === "VOICE") return { width: 900, height: 400 };
      if (v === "MUSIC") return { width: 860, height: 1070 };
      return { width: 940, height: 420 };
    default:
      void head;
      return null;
  }
};
