import { lines, longest, spec, type FamilySizer, type Spec } from "./types";

/**
 * SOCIAL POSTS family — generic, brand-safe "-style" platform UI (never a real platform's logo,
 * wordmark, verification badge, exact layout, font or colours; display names/handles editable,
 * placeholder people by default). Field mapping per component (the edit sheet and quick entry
 * follow `uses`):
 *
 * SOCIAL_POST  title = display name · subtitle = handle / community · meta = time ("2h") ·
 *              body = the post · items = engagement counts (text label, value, icon) that count up.
 *              MICRO short-post card · PRO professional-network post (subtitle = headline) ·
 *              FORUM forum post with vote column (items[0] = votes, title = post title,
 *              subtitle = community, body = text) · PHOTO photo post (square image placeholder,
 *              body = caption, items = likes/comments).
 * COMMENT      items = comments (text, sub = name/handle, value = likes, meta = time);
 *              title = prompt/header. REPLY "Reply to …'s comment" sticker (items[0]) ·
 *              PINNED pinned comment card · CHAIN a reply thread (side ME = indented reply) ·
 *              QUESTION question-box sticker (title = prompt, items[0].text = the answer typed).
 * TRENDING     title = header ("Trending") · items = topics (text, sub = context line,
 *              value = posts count, meta = tag e.g. "#2 · Business"). LIST ranked list ·
 *              CHIPS hashtag chips · RISING one topic with a rising line + count.
 * VIDEO_CARD   title = video title · subtitle = channel · meta = "1.2M views · 3 days ago" ·
 *              items: TILE items[0].text = duration · PLAYER items = chapters (text, value =
 *              seconds) · SUBSCRIBE items[0].value = subscribers (button press + bell) ·
 *              VIEWS items[0].value = the view count ticking up.
 * STORY        story stickers (to sit on the video): title = question/prompt · items = options
 *              (text, value = % result, state DONE = correct). POLL · QUESTION (items[0].text =
 *              answer typed) · SLIDER (items[0].value 0–100, icon = the face) · QUIZ.
 * SOCIAL_COUNTER  MILESTONE items[0].value rolls up (title = "followers") + confetti · RAIL a
 *              vertical action rail (items icon + value) · PROFILE profile header (title name,
 *              subtitle handle, items = Posts/Followers/Following) · LIVE live pill + viewers
 *              (items[0].value).
 * BURST        items = icons that burst (faces render as flat original stickers); title =
 *              optional word. FLOAT hearts floating up · DOUBLE_TAP big heart pop · RAIN ·
 *              CONFETTI.
 */
export const SOCIAL_SPECS = {
  SOCIAL_POST: spec("SOCIAL_POST", "Social post", "A post card — name, handle, text, counts that tick up", "SOCIAL_POSTS", [["MICRO", "Short post"], ["PRO", "Pro network"], ["FORUM", "Forum"], ["PHOTO", "Photo post"]], {
    title: true,
    subtitle: true,
    body: true,
    meta: "Time",
    tone: true,
    ownFormat: true,
    items: { count: [0, 4], value: true, icon: true },
    labels: { title: "Display name", subtitle: "Handle", body: "Post", text: "Count label", value: "Count", entries: "Counts" },
  }, { preferY: 0.36, toneDefault: "LIGHT" }),
  COMMENT: spec("COMMENT", "Comment", "Comment reply sticker, pinned comment or a reply thread", "SOCIAL_POSTS", [["REPLY", "Reply sticker"], ["PINNED", "Pinned"], ["CHAIN", "Thread"], ["QUESTION", "Question box"]], {
    title: true,
    tone: true,
    ownFormat: true,
    quick: "CHAT",
    items: { count: [1, 5], value: true, sub: true, side: true, meta: "Time" },
    labels: { title: "Header / prompt", text: "Comment", sub: "Name", value: "Likes", entries: "Comments" },
  }, { preferY: 0.34, toneDefault: "LIGHT" }),
  TRENDING: spec("TRENDING", "Trending", "What's trending — ranked topics with post counts", "SOCIAL_POSTS", [["LIST", "Ranked list"], ["CHIPS", "Hashtags"], ["RISING", "Rising topic"]], {
    title: true,
    tone: true,
    ownFormat: true,
    quick: "LINES",
    items: { count: [1, 6], value: true, sub: true, meta: "Tag" },
    highlight: "ITEMS",
    labels: { title: "Header", text: "Topic", sub: "Context", value: "Posts", entries: "Topics" },
  }, { preferY: 0.36 }),
  VIDEO_CARD: spec("VIDEO_CARD", "Video card", "Video tile, player with chapters, subscribe press, view counter", "SOCIAL_POSTS", [["TILE", "Video tile"], ["PLAYER", "Player"], ["SUBSCRIBE", "Subscribe"], ["VIEWS", "View counter"]], {
    title: true,
    subtitle: true,
    meta: "Views · age",
    tone: true,
    ownFormat: true,
    items: { count: [0, 6], value: true },
    labels: { title: "Video / channel title", subtitle: "Channel / line 2", text: "Label", value: "Number", entries: "Chapters / numbers" },
  }, { preferY: 0.36 }),
  STORY: spec("STORY", "Story sticker", "Poll, question box, slider or quiz sticker", "SOCIAL_POSTS", [["POLL", "Poll"], ["QUESTION", "Question"], ["SLIDER", "Slider"], ["QUIZ", "Quiz"]], {
    title: true,
    tone: true,
    ownFormat: true,
    quick: "QUERY",
    items: { count: [0, 4], value: true, icon: true, state: true },
    labels: { title: "Question", text: "Option / answer", value: "Result %", entries: "Options" },
  }, { preferY: 0.4, toneDefault: "LIGHT" }),
  SOCIAL_COUNTER: spec("SOCIAL_COUNTER", "Social counter", "Follower milestone, action rail, profile stats, LIVE", "SOCIAL_POSTS", [["MILESTONE", "Milestone"], ["RAIL", "Action rail"], ["PROFILE", "Profile"], ["LIVE", "Live"]], {
    title: true,
    subtitle: true,
    tone: true,
    ownFormat: true,
    items: { count: [0, 5], value: true, icon: true },
    labels: { title: "Label / name", subtitle: "Handle", text: "Label", value: "Count", entries: "Counts" },
  }, { preferY: 0.36 }),
  BURST: spec("BURST", "Reaction burst", "Hearts, faces or confetti bursting", "REACTIONS", [["FLOAT", "Floating"], ["DOUBLE_TAP", "Double tap"], ["RAIN", "Rain"], ["CONFETTI", "Confetti"]], {
    title: true,
    items: { count: [0, 8], icon: true },
    labels: { title: "Word (optional)", entries: "Icons" },
  }, { preferY: 0.45 }),
} satisfies Record<string, Spec>;

export const socialSize: FamilySizer = (p, v, head) => {
  const nI = p.items.length;
  switch (p.component) {
    case "SOCIAL_POST": {
      const bodyLines = lines(p.body, v === "PHOTO" ? 34 : 30, 6);
      if (v === "PHOTO") return { width: 860, height: 140 + 760 + 110 + bodyLines * 48 + 40 };
      if (v === "FORUM") return { width: 940, height: 150 + (p.title ? 70 * lines(p.title, 26, 2) : 0) + bodyLines * 50 + 130 };
      return { width: 940, height: 170 + (v === "PRO" ? 20 : 0) + bodyLines * 54 + (nI ? 110 : 30) };
    }
    case "COMMENT":
      if (v === "REPLY") return { width: 820, height: 150 + lines(p.items[0]?.text, 26, 4) * 52 };
      if (v === "QUESTION") return { width: 760, height: 200 + Math.max(1, lines(p.items[0]?.text, 24, 4)) * 54 + 60 };
      if (v === "PINNED") return { width: 920, height: 120 + lines(p.items[0]?.text, 32, 4) * 50 + 60 };
      return { width: 940, height: head + p.items.reduce((a, it) => a + 92 + lines(it.text, 30, 4) * 46 + 20, 0) + 40 };
    case "TRENDING":
      if (v === "CHIPS") return { width: 960, height: head + Math.ceil(Math.max(1, nI) / 2) * 120 + 60 };
      if (v === "RISING") return { width: 900, height: head + 460 };
      return { width: 920, height: head + Math.max(1, nI) * 132 + 60 };
    case "VIDEO_CARD":
      if (v === "SUBSCRIBE") return { width: 940, height: 240 };
      if (v === "VIEWS") return { width: 820, height: 340 };
      if (v === "PLAYER") return { width: 980, height: 551 + 170 + (nI ? 70 : 0) };
      return { width: 900, height: 506 + 60 + Math.min(2, lines(p.title, 28, 2)) * 56 + 70 };
    case "STORY":
      if (v === "SLIDER") return { width: 760, height: 360 };
      if (v === "QUESTION") return { width: 760, height: 360 + Math.max(1, lines(p.items[0]?.text, 24, 4)) * 50 };
      return { width: 780, height: 170 + lines(p.title, 22, 3) * 54 + Math.max(2, nI) * 112 + 30 };
    case "SOCIAL_COUNTER":
      if (v === "RAIL") return { width: 260, height: Math.max(1, nI) * 190 + 40 };
      if (v === "PROFILE") return { width: 960, height: 440 };
      if (v === "LIVE") return { width: 560, height: 160 };
      return { width: 860, height: 520 };
    case "BURST":
      if (v === "FLOAT") return { width: 520, height: 1100 };
      if (v === "DOUBLE_TAP") return { width: 760, height: 760 };
      return { width: 1000, height: 1500 };
    default:
      return null;
  }
};

void longest;
