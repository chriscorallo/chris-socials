import type { GraphicPreset } from "../presets";
import { I, ME, THEM, k, preset } from "./kit";

/**
 * Library 2 — social family presets (generic "-style" platform UI; placeholder people, never a
 * real platform name/logo on screen — platform words live only in the search tags). Numbers are
 * illustrative placeholders.
 */

const P = "SOCIAL_POSTS" as const;

export const SOCIAL_PRESETS: GraphicPreset[] = [
  // ------------------------------------------------------------------ SOCIAL_POST · MICRO
  preset("post-short-savings-rate", "Short post — savings rate", "A short-post card that lands one line, then the counts tick up and the heart gets liked.", P, ["tweet", "x", "post", "viral", "likes", "social", "savings", "hot take"], "SOCIAL_POST", {
    variant: "MICRO",
    tone: "LIGHT",
    title: "Your Name",
    subtitle: "@yourhandle",
    meta: "2h",
    body: "Your salary isn't your income. Your savings rate is.",
    items: [I("Replies", 1200, { icon: "CHAT" }), I("Reposts", 8400, { icon: "REPOST" }), I("Likes", k(64), { icon: "HEART" }), I("Views", 2_100_000, { icon: "EYE" })],
  }, { seconds: 5, featured: true }),
  preset("post-short-car-payment", "Short post — dark hot take", "Dark short-post card for a skeptical one-liner with engagement counts.", P, ["tweet", "x", "post", "thread", "hot take", "dark", "car", "money"], "SOCIAL_POST", {
    variant: "MICRO",
    tone: "DARK",
    title: "Your Name",
    subtitle: "@yourhandle",
    meta: "5h",
    body: "Nobody talks about how a $1,200 car payment is basically a second rent.",
    items: [I("Replies", 840, { icon: "CHAT" }), I("Reposts", 3100, { icon: "REPOST" }), I("Likes", k(27), { icon: "HEART" }), I("Views", 980_000, { icon: "EYE" })],
  }, { seconds: 5 }),
  preset("post-short-build-public", "Short post — build in public", "A building-in-public update as a short post: revenue, costs, the honest margin.", P, ["tweet", "x", "post", "build in public", "startup", "revenue", "founder", "social"], "SOCIAL_POST", {
    variant: "MICRO",
    tone: "LIGHT",
    title: "Your Name",
    subtitle: "@yourhandle",
    meta: "1h",
    body: "Month 7 building in public: $4,180 revenue, $3,900 costs. Profitable by $280. I'll take it.",
    items: [I("Replies", 212, { icon: "CHAT" }), I("Reposts", 460, { icon: "REPOST" }), I("Likes", 5300, { icon: "HEART" })],
  }, { seconds: 5.5 }),
  preset("post-short-full-401k", "Short post — full screen", "A short post on a full-screen stage for a hook that deserves the whole frame.", P, ["tweet", "x", "post", "full screen", "401k", "hook", "viral", "retirement"], "SOCIAL_POST", {
    variant: "MICRO",
    tone: "DARK",
    title: "Your Name",
    subtitle: "@yourhandle",
    meta: "Just now",
    body: "Your 401(k) match is the only guaranteed 50% return you'll ever get. Stop leaving it on the table.",
    items: [I("Replies", 2400, { icon: "CHAT" }), I("Reposts", k(12), { icon: "REPOST" }), I("Likes", k(88), { icon: "HEART" }), I("Views", 3_400_000, { icon: "EYE" })],
    screen: "FULL",
  }, { seconds: 6, enterSfx: "WHOOSH" }),

  // ------------------------------------------------------------------ SOCIAL_POST · PRO
  preset("post-pro-left-job", "Pro post — quit my job", "A professional-network post with headline, reactions and an action bar that gets a like.", P, ["linkedin", "post", "career", "job", "founder", "professional", "quit", "salary"], "SOCIAL_POST", {
    variant: "PRO",
    tone: "LIGHT",
    title: "Your Name",
    subtitle: "Founder · ex-finance analyst",
    meta: "1d",
    body: "I left a $140k job to build a business. Year one I paid myself $31k. Nobody posts that part of the 'freedom' story.",
    items: [I("reactions", 2400), I("comments", 312), I("reposts", 88)],
  }, { seconds: 6, featured: true }),
  preset("post-pro-hiring-lesson", "Pro post — hiring lesson (dark)", "Dark professional-network post for a career lesson with reactions and comments.", P, ["linkedin", "post", "hiring", "career", "business", "dark", "professional"], "SOCIAL_POST", {
    variant: "PRO",
    tone: "DARK",
    title: "Your Name",
    subtitle: "Building a money newsletter",
    meta: "3h",
    body: "Best candidate we interviewed asked how we make money before asking about PTO. Hired on the spot.",
    items: [I("reactions", 960), I("comments", 74)],
  }, { seconds: 5.5 }),

  // ------------------------------------------------------------------ SOCIAL_POST · FORUM
  preset("post-forum-la-rent", "Forum post — LA rent", "A forum thread with a vote column that ticks up and gets upvoted.", P, ["reddit", "forum", "post", "thread", "rent", "los angeles", "upvote", "budget"], "SOCIAL_POST", {
    variant: "FORUM",
    tone: "LIGHT",
    title: "Is spending 45% of my income on rent in LA actually insane?",
    subtitle: "c/moneytalk",
    meta: "5h",
    body: "Make $72k, rent is $2,700 for a 1-bed. Everyone quotes the 30% rule like it wasn't invented in 1969.",
    items: [I("votes", 4800), I("Comments", 1200, { icon: "CHAT" }), I("Share", null, { icon: "SHARE" })],
  }, { seconds: 6 }),
  preset("post-forum-gym-cost", "Forum post — gym cost per visit", "Dark forum post: a question, the math, votes and comments.", P, ["reddit", "forum", "post", "thread", "gym", "fitness", "dark", "upvote"], "SOCIAL_POST", {
    variant: "FORUM",
    tone: "DARK",
    title: "Anyone else track gym cost per visit?",
    subtitle: "c/fitness",
    meta: "2h",
    body: "$89 a month. 22 visits in October = $4.05 a visit. 3 visits in December = $29.67. December me is expensive.",
    items: [I("votes", 1300), I("Comments", 248, { icon: "CHAT" }), I("Save", null, { icon: "BOOKMARK" })],
  }, { seconds: 6 }),

  // ------------------------------------------------------------------ SOCIAL_POST · PHOTO
  preset("post-photo-sunset-run", "Photo post — sunset run", "A photo post: the picture gets a double-tap heart, likes count up, the caption reads in.", P, ["instagram", "photo", "post", "likes", "double tap", "lifestyle", "los angeles", "run"], "SOCIAL_POST", {
    variant: "PHOTO",
    tone: "LIGHT",
    title: "Your Name",
    subtitle: "Los Angeles, CA",
    meta: "2 hours ago",
    body: "Sunset run. Free. Best thing I do all week for my wallet and my head.",
    items: [I("likes", 12_481)],
  }, { seconds: 5.5 }),
  preset("post-photo-first-place", "Photo post — first place (dark)", "Dark photo post celebrating a win, with a double-tap heart and the likes counting.", P, ["instagram", "photo", "post", "likes", "apartment", "milestone", "dark", "saving"], "SOCIAL_POST", {
    variant: "PHOTO",
    tone: "DARK",
    title: "Your Name",
    subtitle: "Silver Lake",
    body: "First place with no roommates. Took 6 years of saving 22% of every paycheck.",
    items: [I("likes", 8_920)],
  }, { seconds: 5.5 }),

  // ------------------------------------------------------------------ COMMENT
  preset("comment-reply-rent-half", "Reply to comment — rent", "The reply-to-comment sticker that opens a video answering a viewer.", P, ["tiktok", "comment", "reply", "sticker", "question", "rent", "hook", "viewer"], "COMMENT", {
    variant: "REPLY",
    tone: "LIGHT",
    items: [I("How do you save anything when rent is half your paycheck??", null, { sub: "Alex" })],
  }, { seconds: 4, featured: true }),
  preset("comment-reply-index-boring", "Reply to comment — dark", "Dark reply-to-comment sticker for clapping back at a comment.", P, ["tiktok", "comment", "reply", "sticker", "index funds", "dark", "hook"], "COMMENT", {
    variant: "REPLY",
    tone: "DARK",
    items: [I("Bro said index funds are boring like that's a bad thing", null, { sub: "Sam" })],
  }, { seconds: 4 }),
  preset("comment-pinned-breakdown", "Pinned comment — breakdown", "A pinned creator comment with a like that lands.", P, ["comment", "pinned", "youtube", "tiktok", "creator", "link in bio", "likes"], "COMMENT", {
    variant: "PINNED",
    tone: "LIGHT",
    title: "Pinned by Your Name",
    items: [I("Full breakdown of the $4,180 month is in the link in bio. Every line item, no hiding.", 2300, { sub: "Your Name", meta: "1d" })],
  }, { seconds: 4.5 }),
  preset("comment-pinned-correction", "Pinned comment — correction (dark)", "Dark pinned comment for a correction or clarification.", P, ["comment", "pinned", "correction", "youtube", "tiktok", "dark", "401k"], "COMMENT", {
    variant: "PINNED",
    tone: "DARK",
    title: "Pinned by Your Name",
    items: [I("Correction: my match is 50% up to 6% of salary, not 100%. Still free money.", 940, { sub: "Your Name", meta: "4h" })],
  }, { seconds: 4.5 }),
  preset("comment-chain-roth", "Comment thread — the math", "A comment thread: a doubter, the creator's reply with the math, a convert.", P, ["comment", "thread", "reply", "comments section", "roth ira", "investing", "debate"], "COMMENT", {
    variant: "CHAIN",
    tone: "LIGHT",
    title: "Comments",
    items: [
      THEM("You can't retire on $500 a month, that's nothing", { sub: "Alex", meta: "3h", value: 214 }),
      ME("At 8% for 35 years that's about $1.1M. Boring math, real money.", { sub: "Your Name", meta: "2h", value: 1800 }),
      THEM("ok I just opened a Roth", { sub: "Sam", meta: "1h", value: 96 }),
    ],
  }, { seconds: 7 }),
  preset("comment-chain-gym-dark", "Comment thread — dark", "Dark comment thread with the creator replying under a viewer.", P, ["comment", "thread", "reply", "comments section", "gym", "dark", "fitness"], "COMMENT", {
    variant: "CHAIN",
    tone: "DARK",
    items: [
      THEM("$89 a month for a gym is crazy when running is free", { sub: "Jordan", meta: "6h", value: 88 }),
      ME("Running is free. Physical therapy for my knees is not.", { sub: "Your Name", meta: "5h", value: 1200 }),
    ],
  }, { seconds: 6 }),
  preset("comment-qa-step-one", "Q&A sticker — step one", "A question sticker where the creator's answer types out under the question.", P, ["q&a", "question", "comment", "tiktok", "instagram", "answer", "ask me", "sticker"], "COMMENT", {
    variant: "QUESTION",
    tone: "LIGHT",
    title: "Starting from $0 at 27. What's step one?",
    items: [I("Automate $50 a week to savings before you ever see it.", null, { sub: "Sam" })],
  }, { seconds: 6 }),
  preset("comment-qa-credit-dark", "Q&A sticker — credit (dark)", "Dark Q&A sticker: a viewer's question, an answer that types in.", P, ["q&a", "question", "comment", "tiktok", "credit score", "dark", "answer"], "COMMENT", {
    variant: "QUESTION",
    tone: "DARK",
    title: "Does checking my credit score hurt it?",
    items: [I("No. Checking your own score is a soft pull. Zero impact.", null, { sub: "Alex" })],
  }, { seconds: 6 }),

  // ------------------------------------------------------------------ TRENDING
  preset("trending-list-money", "Trending list — money topics", "What's trending: ranked topics with post counts, the top one glows.", P, ["trending", "viral", "topics", "x", "tweet", "explore", "news", "ranking"], "TRENDING", {
    variant: "LIST",
    tone: "DARK",
    title: "Trending",
    items: [
      I("Rent vs buy", k(128), { meta: "1 · Finance · Trending" }),
      I("#NoSpendMonth", 42_100, { meta: "2 · Lifestyle" }),
      I("401(k) match", 18_700, { meta: "3 · Money" }),
      I("LA rent prices", 9_800, { meta: "4 · Los Angeles" }),
    ],
    highlight: 0,
  }, { seconds: 5.5, featured: true }),
  preset("trending-list-light", "Trending list — light", "Light trending panel with three ranked topics and context lines.", P, ["trending", "viral", "topics", "x", "explore", "light", "for you"], "TRENDING", {
    variant: "LIST",
    tone: "LIGHT",
    title: "Trending for you",
    items: [
      I("High-yield savings", 64_200, { meta: "1 · Money · Trending", sub: "Rates" }),
      I("Side hustle taxes", 21_300, { meta: "2 · Business" }),
      I("Leg day", 8_400, { meta: "3 · Fitness" }),
    ],
    highlight: 1,
  }, { seconds: 5 }),
  preset("trending-hashtags-dark", "Trending hashtags", "Hashtag chips popping in with post counts; one fills with the accent.", P, ["hashtags", "trending", "tiktok", "instagram", "viral", "tags", "explore"], "TRENDING", {
    variant: "CHIPS",
    tone: "DARK",
    title: "Trending hashtags",
    items: [I("#buildinpublic", 182_000), I("#savingsrate", 48_300), I("#nospendmonth", 96_100), I("#indexfunds", 31_800), I("#LAliving", 74_500), I("#legday", 260_000)],
    highlight: 0,
  }, { seconds: 5 }),
  preset("trending-hashtags-light", "Trending hashtags — light", "Light hashtag chips with counts for a quick trend explainer.", P, ["hashtags", "trending", "tiktok", "instagram", "viral", "light", "tags"], "TRENDING", {
    variant: "CHIPS",
    tone: "LIGHT",
    title: "This week's tags",
    items: [I("#moneytips", 412_000), I("#debtfree", 88_000), I("#firstapartment", 23_400), I("#budgeting", 156_000)],
    highlight: 1,
  }, { seconds: 4.5 }),
  preset("trending-rising-hysa", "Rising topic", "One topic going vertical: the count climbs and a rising line draws itself.", P, ["trending", "rising", "viral", "topic", "growth", "chart", "breaking"], "TRENDING", {
    variant: "RISING",
    tone: "DARK",
    title: "Trending in Finance",
    items: [I("High-yield savings", 86_400, { meta: "Rising · Finance", sub: "up 312% this week" })],
  }, { seconds: 5, featured: true }),
  preset("trending-rising-light", "Rising topic — light", "Light rising-topic card with the count and a line that shoots up.", P, ["trending", "rising", "viral", "topic", "light", "growth", "side hustle"], "TRENDING", {
    variant: "RISING",
    tone: "LIGHT",
    title: "Trending in Business",
    items: [I("Side hustle taxes", 21_300, { meta: "Rising · Business", sub: "Tax season" })],
  }, { seconds: 5 }),

  // ------------------------------------------------------------------ VIDEO_CARD
  preset("video-tile-365-days", "Video tile — 365 days", "A video thumbnail tile with duration badge, channel and views.", P, ["youtube", "video", "thumbnail", "views", "channel", "watch", "creator"], "VIDEO_CARD", {
    variant: "TILE",
    tone: "DARK",
    title: "I tracked every dollar I spent for 365 days",
    subtitle: "Your Name",
    meta: "1.2M views · 3 days ago",
    items: [I("18:42")],
  }, { seconds: 4.5 }),
  preset("video-tile-100k-la", "Video tile — light", "Light video tile for teasing your next video or a reference.", P, ["youtube", "video", "thumbnail", "views", "light", "salary", "los angeles"], "VIDEO_CARD", {
    variant: "TILE",
    tone: "LIGHT",
    title: "What a $100k salary actually looks like in LA",
    subtitle: "Your Name",
    meta: "486K views · 2 weeks ago",
    items: [I("12:07")],
  }, { seconds: 4.5 }),
  preset("video-player-chapters", "Video player — chapters", "A player whose playhead runs through chapters to the one you're talking about.", P, ["youtube", "video", "player", "chapters", "progress", "timestamp", "watch"], "VIDEO_CARD", {
    variant: "PLAYER",
    tone: "DARK",
    title: "How I'd invest my first $10k",
    subtitle: "Your Name",
    meta: "412K views",
    items: [I("Intro", 0), I("Emergency fund first", 45), I("The 401(k) match", 170), I("Index funds", 330), I("What I'd skip", 520)],
    highlight: 2,
  }, { seconds: 5.5, featured: true }),
  preset("video-player-light", "Video player — light", "Light player card with a chapter bar filling up.", P, ["youtube", "video", "player", "chapters", "light", "progress", "tutorial"], "VIDEO_CARD", {
    variant: "PLAYER",
    tone: "LIGHT",
    title: "Credit scores explained in 9 minutes",
    subtitle: "Your Name",
    meta: "88K views · 1 week ago",
    items: [I("What it is", 0), I("The 5 factors", 80), I("Fixing it fast", 300)],
  }, { seconds: 5 }),
  preset("video-subscribe-press", "Subscribe button press", "The subscribe button gets pressed, flips to Subscribed and the bell rings.", P, ["youtube", "subscribe", "button", "bell", "cta", "channel", "followers"], "VIDEO_CARD", {
    variant: "SUBSCRIBE",
    tone: "LIGHT",
    title: "Your Name",
    items: [I("subscribers", 248_000)],
  }, { seconds: 4, enterSfx: "CLICK" }),
  preset("video-subscribe-dark", "Subscribe button — dark", "Dark subscribe card with the press, the check and the ringing bell.", P, ["youtube", "subscribe", "button", "bell", "dark", "cta", "channel"], "VIDEO_CARD", {
    variant: "SUBSCRIBE",
    tone: "DARK",
    title: "Your Name",
    items: [I("subscribers", 31_400)],
  }, { seconds: 4, enterSfx: "CLICK" }),
  preset("video-views-ticking", "View counter ticking", "A view counter that keeps rolling up digit by digit.", P, ["youtube", "views", "counter", "viral", "odometer", "video", "live count"], "VIDEO_CARD", {
    variant: "VIEWS",
    tone: "DARK",
    title: "I tracked every dollar for 365 days",
    subtitle: "Still climbing",
    items: [I("views", 1_284_392)],
  }, { seconds: 5, enterSfx: "TICK" }),
  preset("video-views-light", "View counter — light", "Light view counter rolling toward the number.", P, ["youtube", "views", "counter", "viral", "light", "odometer"], "VIDEO_CARD", {
    variant: "VIEWS",
    tone: "LIGHT",
    items: [I("views", 486_210)],
  }, { seconds: 4.5, enterSfx: "TICK" }),

  // ------------------------------------------------------------------ STORY
  preset("story-poll-remote-pay", "Story poll — remote vs office", "A story poll sticker: one option gets tapped and the results fill in.", P, ["instagram", "story", "poll", "sticker", "vote", "career", "remote work"], "STORY", {
    variant: "POLL",
    tone: "LIGHT",
    title: "$90k remote or $120k in-office?",
    items: [I("$90k remote", 64), I("$120k office", 36)],
  }, { seconds: 5, featured: true }),
  preset("story-poll-renting-dark", "Story poll — dark", "Dark poll sticker with results bars counting up.", P, ["instagram", "story", "poll", "sticker", "vote", "rent", "dark"], "STORY", {
    variant: "POLL",
    tone: "DARK",
    title: "Renting forever: smart or scary?",
    items: [I("Smart", 41), I("Scary", 59)],
  }, { seconds: 5 }),
  preset("story-question-saved-30", "Story question box", "A question sticker: the prompt, then a viewer's question typing in.", P, ["instagram", "story", "question", "sticker", "ask me anything", "q&a", "ama"], "STORY", {
    variant: "QUESTION",
    tone: "LIGHT",
    title: "Ask me anything about money",
    items: [I("How much should I have saved by 30?", null, { sub: "Your Name" })],
  }, { seconds: 5.5 }),
  preset("story-question-dark", "Story question box — dark", "Dark question sticker with the answer typed into the field.", P, ["instagram", "story", "question", "sticker", "q&a", "dark", "business"], "STORY", {
    variant: "QUESTION",
    tone: "DARK",
    title: "What's your business making right now?",
    items: [I("$4,180 last month. $280 of it was profit.", null, { sub: "Your Name" })],
  }, { seconds: 5.5 }),
  preset("story-slider-surprise-bill", "Story slider — surprise bill", "A slider sticker: a flat sticker face slides to the answer.", P, ["instagram", "story", "slider", "sticker", "emoji slider", "rating", "emergency fund"], "STORY", {
    variant: "SLIDER",
    tone: "LIGHT",
    title: "How ready are you for a $1,000 surprise bill?",
    items: [I("", 22, { icon: "FACE_WOW" })],
  }, { seconds: 4.5 }),
  preset("story-slider-leg-day", "Story slider — dark", "Dark slider sticker with a sticker face gliding along the track.", P, ["instagram", "story", "slider", "sticker", "rating", "gym", "dark"], "STORY", {
    variant: "SLIDER",
    tone: "DARK",
    title: "How hyped are you for leg day?",
    items: [I("", 88, { icon: "FACE_COOL" })],
  }, { seconds: 4.5 }),
  preset("story-quiz-apr", "Story quiz — credit card APR", "A quiz sticker: lettered options, the right answer gets tapped and turns green.", P, ["instagram", "story", "quiz", "sticker", "trivia", "credit card", "test"], "STORY", {
    variant: "QUIZ",
    tone: "LIGHT",
    title: "Average credit card APR right now?",
    items: [I("12%"), I("17%"), I("22%", null, { state: "DONE" })],
  }, { seconds: 5 }),
  preset("story-quiz-compound-dark", "Story quiz — dark", "Dark quiz sticker with results percentages for each option.", P, ["instagram", "story", "quiz", "sticker", "compound interest", "dark", "trivia"], "STORY", {
    variant: "QUIZ",
    tone: "DARK",
    title: "Which grows more over 30 years?",
    items: [I("$500/mo at 4%", 38), I("$300/mo at 9%", 62, { state: "DONE" })],
  }, { seconds: 5 }),

  // ------------------------------------------------------------------ SOCIAL_COUNTER
  preset("counter-milestone-100k", "Follower milestone — 100K", "The follower count rolls up to 100,000 and confetti fires.", P, ["followers", "milestone", "100k", "subscribers", "celebration", "confetti", "growth"], "SOCIAL_COUNTER", {
    variant: "MILESTONE",
    tone: "DARK",
    title: "followers",
    subtitle: "@yourhandle",
    items: [I("100K club", k(100))],
  }, { seconds: 5, featured: true, enterSfx: "RISER" }),
  preset("counter-milestone-10k-light", "Subscriber milestone — light", "Light milestone card: the count rolls to 10,000 with a burst.", P, ["subscribers", "milestone", "10k", "followers", "celebration", "light", "youtube"], "SOCIAL_COUNTER", {
    variant: "MILESTONE",
    tone: "LIGHT",
    title: "subscribers",
    items: [I("New milestone", k(10))],
  }, { seconds: 5, enterSfx: "RISER" }),
  preset("counter-rail-viral", "Action rail — likes, comments", "A vertical like / comment / save / share rail counting up, the heart gets tapped.", P, ["tiktok", "likes", "hearts", "comments", "shares", "saves", "viral", "rail"], "SOCIAL_COUNTER", {
    variant: "RAIL",
    tone: "DARK",
    items: [I("Likes", k(248), { icon: "HEART" }), I("Comments", 3100, { icon: "CHAT" }), I("Saves", 18_400, { icon: "BOOKMARK" }), I("Shares", 9200, { icon: "SHARE" })],
  }, { seconds: 4.5 }),
  preset("counter-rail-light", "Action rail — light", "Frosted action rail with counts for likes, comments and shares.", P, ["tiktok", "reels", "likes", "comments", "shares", "light", "rail"], "SOCIAL_COUNTER", {
    variant: "RAIL",
    tone: "LIGHT",
    items: [I("Likes", 12_400, { icon: "HEART" }), I("Comments", 380, { icon: "CHAT" }), I("Shares", 1100, { icon: "SHARE" })],
  }, { seconds: 4.5 }),
  preset("counter-profile-follow", "Profile header — follow", "A profile header: stats count up and the Follow button gets tapped.", P, ["profile", "followers", "follow", "instagram", "tiktok", "bio", "stats"], "SOCIAL_COUNTER", {
    variant: "PROFILE",
    tone: "LIGHT",
    title: "Your Name",
    subtitle: "@yourhandle · money, LA, building in public",
    items: [I("Posts", 312), I("Followers", 48_200), I("Following", 180)],
  }, { seconds: 5, enterSfx: "CLICK" }),
  preset("counter-profile-dark", "Profile header — dark", "Dark profile header with follower stats and a follow tap.", P, ["profile", "followers", "follow", "instagram", "tiktok", "dark", "stats"], "SOCIAL_COUNTER", {
    variant: "PROFILE",
    tone: "DARK",
    title: "Your Name",
    subtitle: "@yourhandle",
    items: [I("Posts", 1040), I("Followers", 1_200_000), I("Likes", 18_600_000)],
  }, { seconds: 5, enterSfx: "CLICK" }),
  preset("counter-live-viewers", "LIVE pill — viewers", "A LIVE badge with a pulsing ring and the viewer count ticking.", P, ["live", "livestream", "viewers", "streaming", "badge", "tiktok", "watching"], "SOCIAL_COUNTER", {
    variant: "LIVE",
    tone: "DARK",
    title: "Your Name",
    items: [I("watching", 2400)],
  }, { seconds: 4 }),
  preset("counter-live-light", "LIVE badge — compact", "A compact light LIVE badge with the viewer count.", P, ["live", "livestream", "viewers", "badge", "light", "streaming"], "SOCIAL_COUNTER", {
    variant: "LIVE",
    tone: "LIGHT",
    items: [I("watching", 860)],
  }, { seconds: 3.5 }),

  // ------------------------------------------------------------------ BURST
  preset("burst-float-hearts", "Floating hearts", "Live-stream style hearts floating up the side of the frame.", "REACTIONS", ["hearts", "likes", "live", "floating", "reaction", "love", "tiktok"], "BURST", {
    variant: "FLOAT",
    items: [I("", null, { icon: "HEART" })],
  }, { seconds: 4, enterSfx: null, featured: true }),
  preset("burst-float-faces", "Floating reactions mix", "A mix of sticker faces, hearts and fire floating up.", "REACTIONS", ["reactions", "faces", "hearts", "fire", "live", "floating", "emoji"], "BURST", {
    variant: "FLOAT",
    items: [I("", null, { icon: "FACE_LOVE" }), I("", null, { icon: "HEART" }), I("", null, { icon: "FACE_LAUGH" }), I("", null, { icon: "FIRE" })],
  }, { seconds: 4, enterSfx: null }),
  preset("burst-double-tap", "Double-tap heart", "A big heart pops with a ring and mini hearts — the double-tap like.", "REACTIONS", ["double tap", "heart", "like", "instagram", "love", "pop", "likes"], "BURST", {
    variant: "DOUBLE_TAP",
    items: [I("", null, { icon: "HEART" })],
  }, { seconds: 2.5, enterSfx: "SOFT_POP" }),
  preset("burst-double-tap-word", "Double-tap heart + word", "The double-tap heart with a word under it.", "REACTIONS", ["double tap", "heart", "like", "love", "obsessed", "reaction", "hearts"], "BURST", {
    variant: "DOUBLE_TAP",
    title: "Obsessed",
    items: [I("", null, { icon: "HEART" })],
  }, { seconds: 3, enterSfx: "SOFT_POP" }),
  preset("burst-rain-laughing", "Laughing faces rain", "Laughing faces, skulls and 100s raining down for a funny beat.", "REACTIONS", ["laughing", "faces", "rain", "skull", "100", "funny", "reaction", "emoji"], "BURST", {
    variant: "RAIN",
    items: [I("", null, { icon: "FACE_LAUGH" }), I("", null, { icon: "SKULL" }), I("", null, { icon: "HUNDRED" }), I("", null, { icon: "FACE_LAUGH" })],
  }, { seconds: 4, enterSfx: null }),
  preset("burst-rain-payday", "Payday rain", "Coins and cash raining behind a word — payday energy.", "REACTIONS", ["money", "rain", "payday", "cash", "coins", "celebration", "reaction"], "BURST", {
    variant: "RAIN",
    title: "Payday",
    items: [I("", null, { icon: "COIN" }), I("", null, { icon: "CASH" }), I("", null, { icon: "STAR" })],
  }, { seconds: 4, enterSfx: "CASH" }),
  preset("burst-confetti-debt-free", "Confetti — debt free", "Confetti cannons fire from both corners behind a word.", "REACTIONS", ["confetti", "celebration", "debt free", "party", "win", "milestone"], "BURST", {
    variant: "CONFETTI",
    title: "Debt free",
  }, { seconds: 4, enterSfx: "IMPACT" }),
  preset("burst-confetti-stars", "Confetti with stars", "A confetti burst mixed with stars and hearts, no text.", "REACTIONS", ["confetti", "celebration", "stars", "party", "hearts", "win"], "BURST", {
    variant: "CONFETTI",
    items: [I("", null, { icon: "STAR" }), I("", null, { icon: "HEART" })],
  }, { seconds: 4, enterSfx: "SHIMMER" }),
];
