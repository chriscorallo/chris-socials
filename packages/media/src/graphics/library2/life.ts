import type { GraphicPreset } from "../presets";
import { I, S, preset } from "./kit";

/**
 * Library 2 — LIFE & PLACES presets: maps, weather, screen time, payments, rides / deliveries /
 * boarding passes, calendars, trackers and two-column lists. Generic "-style" UIs only (no app
 * names, logos or signature colours); places are generic LA neighbourhoods / cities and every
 * number is an illustrative placeholder.
 */
const DONE = { state: "DONE" as const };
const NO = { state: "NO" as const };
/** Payments read as exact amounts: full digits, cents where the amounts have them. */
const USD = { kind: "CURRENCY" as const, compact: "NONE" as const };
const CENTS = { kind: "CURRENCY" as const, compact: "NONE" as const, decimals: 2 };

export const LIFE_PRESETS: GraphicPreset[] = [
  // ------------------------------------------------------------------ MAP_NAV
  preset("map-route-gym", "Route to the gym", "A route draws across an original street map to the gym, with an ETA and a GO button.", "LIFE", ["map", "route", "directions", "gym", "location", "navigation", "eta"], "MAP_NAV", {
    variant: "ROUTE",
    title: "The gym",
    subtitle: "7 min · 1.2 mi",
    items: [I("Home", null, { sub: "Silver Lake" }), I("Gym", null, { sub: "Echo Park" })],
    tone: "DARK",
  }, { seconds: 5, featured: true, enterSfx: "WHOOSH" }),
  preset("map-route-commute", "The LA commute tax", "A light-mode route card: 52 minutes to go 14 miles, the real cost of the commute.", "LIFE", ["map", "route", "directions", "commute", "los angeles", "traffic", "location"], "MAP_NAV", {
    variant: "ROUTE",
    title: "Office, Downtown",
    subtitle: "52 min · 14 mi",
    items: [I("Home", null, { sub: "Venice" }), I("Office", null, { sub: "Downtown" })],
    tone: "LIGHT",
  }, { seconds: 5, enterSfx: "WHOOSH" }),
  preset("map-pin-los-angeles", "Pin drop: Los Angeles", "A pin drops onto an abstract map with a ripple and a place card.", "LIFE", ["map", "pin", "location", "los angeles", "place", "city"], "MAP_NAV", {
    variant: "PIN",
    title: "Los Angeles",
    subtitle: "California",
    tone: "DARK",
  }, { seconds: 3.5, featured: true, enterSfx: "SOFT_POP" }),
  preset("map-pin-rent", "Where the rent went", "A light pin drop for a neighbourhood callout.", "LIFE", ["map", "pin", "location", "rent", "neighborhood", "los angeles"], "MAP_NAV", {
    variant: "PIN",
    title: "Venice Beach",
    subtitle: "$3,400 for a 1-bed",
    tone: "LIGHT",
  }, { seconds: 3.5, enterSfx: "SOFT_POP" }),
  preset("map-flight-red-eye", "Red-eye to New York", "A flight arc between two cities with a plane gliding along it.", "LIFE", ["map", "flight", "travel", "plane", "trip", "airport"], "MAP_NAV", {
    variant: "FLIGHT",
    title: "Red-eye to New York",
    subtitle: "5h 20m · nonstop",
    items: [I("Los Angeles", null, { sub: "LAX" }), I("New York", null, { sub: "JFK" })],
    tone: "DARK",
  }, { seconds: 4.5, enterSfx: "WHOOSH" }),
  preset("map-flight-moved", "Moved for the taxes", "A light flight card: the move people make for a lower tax bill.", "LIFE", ["map", "flight", "travel", "moving", "taxes", "relocation"], "MAP_NAV", {
    variant: "FLIGHT",
    title: "Moved for the taxes",
    subtitle: "3h 05m · one way",
    items: [I("Los Angeles", null, { sub: "LAX" }), I("Austin", null, { sub: "AUS" })],
    tone: "LIGHT",
  }, { seconds: 4.5, enterSfx: "WHOOSH" }),
  preset("map-cities-trip", "4 cities, 1 carry-on", "A multi-stop trip drawn stop by stop across a dotted world.", "LIFE", ["map", "travel", "trip", "itinerary", "cities", "flight", "route"], "MAP_NAV", {
    variant: "CITIES",
    title: "4 cities, 1 carry-on",
    subtitle: "Worked the whole way",
    items: [I("Los Angeles", null, { sub: "Mar 2" }), I("Mexico City", null, { sub: "Mar 6" }), I("Lisbon", null, { sub: "Mar 13" }), I("Tokyo", null, { sub: "Mar 24" })],
    tone: "DARK",
  }, { seconds: 6, enterSfx: "WHOOSH" }),
  preset("map-cities-full", "Remote year (full screen)", "A full-screen light trip map for a travel recap.", "LIFE", ["map", "travel", "trip", "remote work", "cities", "location"], "MAP_NAV", {
    variant: "CITIES",
    title: "One laptop, three cities",
    items: [I("Los Angeles", null, { sub: "Jan" }), I("Bali", null, { sub: "Apr" }), I("Barcelona", null, { sub: "Aug" })],
    tone: "LIGHT",
    screen: "FULL",
  }, { seconds: 5.5, enterSfx: "WHOOSH" }),

  // ------------------------------------------------------------------ WEATHER
  preset("weather-la-sunny", "72° and sunny", "A sky-gradient weather card with temperature, condition and an hourly strip.", "LIFE", ["weather", "temperature", "sunny", "los angeles", "forecast", "la"], "WEATHER", {
    variant: "CARD",
    title: "Los Angeles",
    items: [I("Sunny", 72, { icon: "SUN", sub: "H:78°  L:61°" }), I("Now", 72, { icon: "SUN" }), I("1 PM", 75, { icon: "SUN" }), I("3 PM", 77, { icon: "SUN" }), I("5 PM", 74, { icon: "CLOUD" }), I("7 PM", 68, { icon: "MOON" })],
    tone: "LIGHT",
  }, { seconds: 4.5, featured: true, enterSfx: "SOFT_POP" }),
  preset("weather-may-gray", "May gray", "A moody cloudy-day card, no hourly strip.", "LIFE", ["weather", "temperature", "cloudy", "los angeles", "may gray"], "WEATHER", {
    variant: "CARD",
    title: "Santa Monica",
    items: [I("Cloudy all day", 64, { icon: "CLOUD", sub: "Still paying beach rent" })],
    tone: "DARK",
  }, { seconds: 3.5, enterSfx: "SOFT_POP" }),
  preset("weather-rain-la", "It rained once", "A rainy-night card with an hourly strip (LA panics).", "LIFE", ["weather", "rain", "temperature", "los angeles", "storm"], "WEATHER", {
    variant: "CARD",
    title: "Los Angeles",
    items: [I("Rain", 58, { icon: "RAIN", sub: "Traffic: apocalyptic" }), I("6 PM", 59, { icon: "RAIN" }), I("7 PM", 58, { icon: "STORM" }), I("8 PM", 57, { icon: "RAIN" }), I("9 PM", 57, { icon: "CLOUD" })],
    tone: "DARK",
  }, { seconds: 4.5, enterSfx: "SOFT_POP" }),
  preset("weather-week-la", "LA week forecast", "A week of days with icons, lows, highs and range bars.", "LIFE", ["weather", "forecast", "week", "temperature", "los angeles"], "WEATHER", {
    variant: "WEEK",
    title: "Los Angeles",
    items: [I("Mon", 78, { icon: "SUN", sub: "61" }), I("Tue", 81, { icon: "SUN", sub: "63" }), I("Wed", 84, { icon: "SUN", sub: "65" }), I("Thu", 76, { icon: "CLOUD", sub: "60" }), I("Fri", 72, { icon: "CLOUD", sub: "58" }), I("Sat", 74, { icon: "SUN", sub: "59" }), I("Sun", 79, { icon: "SUN", sub: "62" })],
    tone: "DARK",
  }, { seconds: 5, enterSfx: "SOFT_POP" }),
  preset("weather-week-light", "Rainy week", "A light five-day forecast card.", "LIFE", ["weather", "forecast", "rain", "temperature", "week"], "WEATHER", {
    variant: "WEEK",
    title: "This week",
    items: [I("Mon", 66, { icon: "CLOUD", sub: "55" }), I("Tue", 61, { icon: "RAIN", sub: "52" }), I("Wed", 59, { icon: "STORM", sub: "50" }), I("Thu", 63, { icon: "RAIN", sub: "53" }), I("Fri", 70, { icon: "SUN", sub: "56" })],
    tone: "LIGHT",
  }, { seconds: 4.5, enterSfx: "SOFT_POP" }),

  // ------------------------------------------------------------------ SCREEN_TIME
  preset("screen-time-report", "6h 42m a day", "A screen-time report: daily average counting up, bars per day, top apps.", "LIFE", ["screen time", "phone addiction", "phone", "habits", "apps", "productivity"], "SCREEN_TIME", {
    variant: "REPORT",
    title: "6h 42m",
    subtitle: "Daily average",
    series: [S("Hours", [5.8, 6.4, 7.1, 6.2, 5.9, 8.6, 6.9])],
    categories: ["M", "T", "W", "T", "F", "S", "S"],
    items: [I("Short videos", 154, { icon: "PLAY" }), I("Social", 96, { icon: "CAMERA" }), I("Messages", 48, { icon: "CHAT" })],
    tone: "DARK",
  }, { seconds: 5.5, featured: true, enterSfx: "SOFT_POP" }),
  preset("screen-time-down", "Cut it to 2 hours", "A light screen-time report after the detox.", "LIFE", ["screen time", "phone addiction", "digital detox", "habits", "discipline"], "SCREEN_TIME", {
    variant: "REPORT",
    title: "2h 05m",
    subtitle: "Daily average · down 68%",
    series: [S("Hours", [2.4, 1.9, 2.2, 1.8, 2.0, 2.6, 1.7])],
    categories: ["M", "T", "W", "T", "F", "S", "S"],
    items: [I("Maps", 31, { icon: "MAP" }), I("Music", 28, { icon: "MUSIC" })],
    tone: "LIGHT",
  }, { seconds: 5, enterSfx: "SOFT_POP" }),
  preset("screen-time-apps", "Where 6 hours went", "A ranked list of apps with time bars.", "LIFE", ["screen time", "apps", "phone addiction", "time", "habits"], "SCREEN_TIME", {
    variant: "APPS",
    title: "Where 6 hours went",
    subtitle: "Yesterday",
    items: [I("Short videos", 154, { icon: "PLAY" }), I("Social", 96, { icon: "CAMERA" }), I("Messages", 48, { icon: "CHAT" }), I("News", 37, { icon: "NEWS" }), I("Banking", 4, { icon: "BANK" })],
    tone: "DARK",
  }, { seconds: 5, enterSfx: "SOFT_POP" }),
  preset("screen-time-full", "Your phone's real salary", "A full-screen screen-time reveal for a hard-hitting hook.", "LIFE", ["screen time", "phone addiction", "hook", "time", "productivity"], "SCREEN_TIME", {
    variant: "REPORT",
    title: "9h 14m",
    subtitle: "Daily average. That's a job.",
    series: [S("Hours", [8.7, 9.2, 9.9, 8.4, 9.1, 10.6, 8.8])],
    categories: ["M", "T", "W", "T", "F", "S", "S"],
    tone: "DARK",
    screen: "FULL",
  }, { seconds: 4.5, enterSfx: "IMPACT" }),

  // ------------------------------------------------------------------ PAYMENT
  preset("pay-received-500", "You received $500", "A payment-received card: check burst, amount counting up, sender and memo.", "LIFE", ["payment", "money received", "venmo", "paid", "cash", "transfer"], "PAYMENT", {
    variant: "RECEIVED",
    title: "You received",
    subtitle: "from Alex",
    items: [I("Amount", 500)],
    body: "Rent split. Thanks for covering.",
    format: USD,
    tone: "LIGHT",
  }, { seconds: 4.5, featured: true, enterSfx: "CASH" }),
  preset("pay-client-paid", "Client paid", "A dark payment-received card for a freelance win.", "LIFE", ["payment", "money received", "paid", "freelance", "invoice", "client"], "PAYMENT", {
    variant: "RECEIVED",
    title: "Client paid",
    subtitle: "from Sam's Studio",
    items: [I("Amount", 2400)],
    body: "Invoice 014: logo + site",
    format: USD,
    tone: "DARK",
  }, { seconds: 4.5, enterSfx: "CASH" }),
  preset("pay-feed-week", "Where the money went", "A payment-app-style feed: who you paid, who paid you, memos and times.", "LIFE", ["payment", "venmo", "feed", "spending", "paid", "money"], "PAYMENT", {
    variant: "FEED",
    items: [I("You paid Alex", -45, { sub: "Sushi", meta: "2h" }), I("Sam paid you", 120, { sub: "Concert tickets", meta: "5h" }), I("You paid Landlord", -2350, { sub: "October rent", meta: "1d" }), I("You paid Coach Mia", -89, { sub: "Gym membership", meta: "2d" })],
    format: USD,
    tone: "LIGHT",
  }, { seconds: 5.5, enterSfx: "SOFT_POP" }),
  preset("pay-feed-subscriptions", "Death by subscriptions", "A dark feed of small recurring payments that add up.", "LIFE", ["payment", "subscriptions", "spending", "money", "budget", "feed"], "PAYMENT", {
    variant: "FEED",
    title: "This week",
    items: [I("You paid Streaming", -22.99, { sub: "Monthly", meta: "Mon" }), I("You paid Cloud Storage", -9.99, { sub: "Monthly", meta: "Tue" }), I("You paid Music", -11.99, { sub: "Monthly", meta: "Thu" })],
    format: CENTS,
    tone: "DARK",
  }, { seconds: 5, enterSfx: "SOFT_POP" }),
  preset("pay-receipt-coffee", "The $16 coffee", "A receipt prints out of a slot, line by line, ending on the total.", "LIFE", ["receipt", "coffee", "spending", "latte", "money", "budget"], "PAYMENT", {
    variant: "RECEIPT",
    title: "COFFEE BAR",
    subtitle: "Every weekday at 8:40 AM",
    items: [I("Oat milk latte", 7.5), I("Almond croissant", 6), I("Tip", 2.7)],
    showTotal: true,
    format: CENTS,
    tone: "DARK",
  }, { seconds: 5, featured: true, enterSfx: "TICK" }),
  preset("pay-receipt-dinner", "Dinner in WeHo", "A light receipt for a night-out bill.", "LIFE", ["receipt", "dinner", "spending", "money", "restaurant"], "PAYMENT", {
    variant: "RECEIPT",
    title: "DINNER FOR TWO",
    subtitle: "Saturday · West Hollywood",
    items: [I("Two cocktails", 38), I("Shared plates", 64), I("Pasta", 32), I("Tax + tip", 39)],
    showTotal: true,
    format: USD,
    tone: "LIGHT",
  }, { seconds: 5.5, enterSfx: "TICK" }),
  preset("pay-declined", "Card declined", "A card graphic processes, then gets declined with a shake.", "LIFE", ["declined", "card", "payment", "broke", "insufficient funds", "money"], "PAYMENT", {
    variant: "DECLINED",
    title: "Card declined",
    subtitle: "Insufficient funds",
    items: [I("Amount", 84.5)],
    format: CENTS,
    tone: "LIGHT",
  }, { seconds: 4, enterSfx: "CLICK" }),
  preset("pay-declined-rent", "Rent day, declined", "A dark declined card for the end-of-month reality check.", "LIFE", ["declined", "payment", "rent", "broke", "money", "budget"], "PAYMENT", {
    variant: "DECLINED",
    title: "Payment failed",
    subtitle: "Rent was due yesterday",
    items: [I("Amount", 2350)],
    format: USD,
    tone: "DARK",
  }, { seconds: 4, enterSfx: "CLICK" }),

  // ------------------------------------------------------------------ TRAVEL
  preset("travel-ride-arriving", "Your ride, 3 min away", "A ride-app-style card: mini map with the car on its way, driver, rating, plate.", "LIFE", ["uber", "ride", "rideshare", "car", "driver", "eta"], "TRAVEL", {
    variant: "RIDE",
    title: "Marcus",
    subtitle: "Gray Sedan · 8XYZ214",
    meta: "3 min away",
    items: [I("Rating", 4.9)],
    tone: "LIGHT",
  }, { seconds: 4.5, featured: true, enterSfx: "SOFT_POP" }),
  preset("travel-ride-night", "Ride home, 1 AM", "A dark ride card for the late-night ride home.", "LIFE", ["uber", "ride", "rideshare", "night", "car", "driver"], "TRAVEL", {
    variant: "RIDE",
    title: "Priya",
    subtitle: "White Hybrid · 9LMN552",
    meta: "Arriving now",
    items: [I("Rating", 5)],
    tone: "DARK",
  }, { seconds: 4.5, enterSfx: "SOFT_POP" }),
  preset("travel-delivery-tracker", "Arriving by 8 PM", "A delivery tracker: progress bar with a truck and the stages checked off.", "LIFE", ["delivery", "tracking", "package", "order", "shipping"], "TRAVEL", {
    variant: "DELIVERY",
    title: "Arriving by 8 PM",
    subtitle: "Order #4471 · 2 items",
    items: [I("Ordered", null, { sub: "Mon 9:12 AM", ...DONE }), I("Shipped", null, { sub: "Tue 2:40 PM", ...DONE }), I("Out for delivery", null, { sub: "Today", ...DONE }), I("Delivered", null, { sub: "By 8 PM" })],
    tone: "LIGHT",
  }, { seconds: 5, enterSfx: "SOFT_POP" }),
  preset("travel-delivery-food", "Dinner's 12 min out", "A dark food-delivery tracker.", "LIFE", ["delivery", "tracking", "food", "order", "takeout"], "TRAVEL", {
    variant: "DELIVERY",
    title: "12 min away",
    subtitle: "Third takeout this week",
    items: [I("Order placed", null, { sub: "7:02 PM", ...DONE }), I("Preparing", null, { sub: "7:05 PM", ...DONE }), I("On the way", null, { sub: "ETA 7:38" }), I("Delivered", null)],
    tone: "DARK",
  }, { seconds: 5, enterSfx: "SOFT_POP" }),
  preset("travel-boarding-pass", "Boarding pass", "A boarding pass with codes, a plane crossing, details, perforation and barcode.", "LIFE", ["boarding pass", "flight", "travel", "airport", "trip", "plane"], "TRAVEL", {
    variant: "BOARDING",
    title: "Your Name",
    meta: "Flight 2207",
    items: [I("LAX", null, { sub: "Los Angeles" }), I("JFK", null, { sub: "New York" }), I("Gate", null, { sub: "52B" }), I("Seat", null, { sub: "14A" }), I("Boards", null, { sub: "9:40 PM" }), I("Group", null, { sub: "3" })],
    tone: "LIGHT",
  }, { seconds: 5, featured: true, enterSfx: "WHOOSH" }),
  preset("travel-boarding-tokyo", "One-way to Tokyo", "A dark boarding pass for the big trip.", "LIFE", ["boarding pass", "flight", "travel", "tokyo", "trip"], "TRAVEL", {
    variant: "BOARDING",
    title: "Your Name",
    meta: "Flight 0011",
    items: [I("LAX", null, { sub: "Los Angeles" }), I("HND", null, { sub: "Tokyo" }), I("Gate", null, { sub: "148" }), I("Seat", null, { sub: "31K" }), I("Boards", null, { sub: "11:15 AM" })],
    tone: "DARK",
  }, { seconds: 5, enterSfx: "WHOOSH" }),
  preset("travel-ticket-show", "Concert ticket", "An event ticket with a tear-off stub, date, venue and seat details.", "LIFE", ["ticket", "concert", "event", "show", "admission"], "TRAVEL", {
    variant: "TICKET",
    title: "Sold-out show, worth it",
    subtitle: "Sat, Nov 14 · 8:00 PM",
    meta: "Downtown LA",
    items: [I("Section", null, { sub: "112" }), I("Row", null, { sub: "F" }), I("Seat", null, { sub: "9" })],
    tone: "DARK",
  }, { seconds: 4.5, enterSfx: "SOFT_POP" }),
  preset("travel-ticket-light", "Game day ticket", "A light event ticket for a game or a big night.", "LIFE", ["ticket", "game", "event", "sports", "admission"], "TRAVEL", {
    variant: "TICKET",
    title: "Game day",
    subtitle: "Sun, Dec 6 · 1:05 PM",
    meta: "Inglewood, CA",
    items: [I("Gate", null, { sub: "C" }), I("Row", null, { sub: "22" }), I("Seat", null, { sub: "4" })],
    tone: "LIGHT",
  }, { seconds: 4.5, enterSfx: "SOFT_POP" }),

  // ------------------------------------------------------------------ DATE
  preset("date-flip-two-weeks", "Two weeks later", "A tear-off calendar flips page by page from one day to another.", "LIFE", ["calendar", "date", "days", "time passing", "later"], "DATE", {
    variant: "FLIP",
    title: "Mar",
    subtitle: "Monday",
    items: [I("From", 1), I("To", 15)],
    tone: "LIGHT",
  }, { seconds: 4.5, featured: true, enterSfx: "TICK" }),
  preset("date-flip-payday", "Payday finally", "A dark tear-off calendar flipping to the 1st.", "LIFE", ["calendar", "date", "payday", "days", "money"], "DATE", {
    variant: "FLIP",
    title: "Oct",
    subtitle: "Friday",
    items: [I("From", 24), I("To", 31)],
    tone: "DARK",
  }, { seconds: 4, enterSfx: "TICK" }),
  preset("date-month-no-eating-out", "18 days, no eating out", "A month grid with each day crossed off and today ringed.", "LIFE", ["calendar", "date", "days", "streak", "challenge", "habit"], "DATE", {
    variant: "MONTH",
    title: "October",
    subtitle: "18 days without eating out",
    items: [I("Days", 18)],
    tone: "LIGHT",
  }, { seconds: 5, enterSfx: "TICK" }),
  preset("date-month-no-spend", "No-spend November", "A dark month grid for a no-spend challenge.", "LIFE", ["calendar", "no spend", "challenge", "days", "budget", "date"], "DATE", {
    variant: "MONTH",
    title: "November",
    subtitle: "No-spend month: day 21",
    items: [I("Days", 21)],
    tone: "DARK",
  }, { seconds: 5, enterSfx: "TICK" }),
  preset("date-years-building", "7 years of building", "An odometer rolls from one year to another.", "LIFE", ["years", "date", "odometer", "time", "journey", "building in public"], "DATE", {
    variant: "YEARS",
    title: "Started with $0",
    subtitle: "Every year compounding",
    items: [I("From", 2019), I("To", 2026)],
    tone: "DARK",
  }, { seconds: 4.5, enterSfx: "TICK" }),
  preset("date-years-age", "28 to 35", "A light odometer counting ages or years.", "LIFE", ["years", "age", "odometer", "time", "date"], "DATE", {
    variant: "YEARS",
    title: "The age you start investing",
    items: [I("From", 28), I("To", 35)],
    tone: "LIGHT",
  }, { seconds: 4, enterSfx: "TICK" }),
  preset("date-until-payday", "9 days until payday", "A big count of days until something.", "LIFE", ["days", "countdown", "payday", "calendar", "date", "until"], "DATE", {
    variant: "UNTIL",
    title: "days until payday",
    subtitle: "Budget like it's 30",
    items: [I("Days", 9)],
    tone: "LIGHT",
  }, { seconds: 3.5, featured: true, enterSfx: "SOFT_POP" }),
  preset("date-until-marathon", "42 days until race day", "A dark days-until card for a goal date.", "LIFE", ["days", "countdown", "marathon", "goal", "calendar", "until"], "DATE", {
    variant: "UNTIL",
    title: "days until the marathon",
    subtitle: "Long run Sunday",
    items: [I("Days", 42)],
    tone: "DARK",
  }, { seconds: 3.5, enterSfx: "SOFT_POP" }),

  // ------------------------------------------------------------------ TRACKER
  preset("tracker-habit-gym", "Gym streak grid", "A contribution grid fills day by day with the streak and total counting up.", "LIFE", ["habit", "streak", "gym", "consistency", "tracker", "discipline"], "TRACKER", {
    variant: "HABIT",
    title: "Gym",
    subtitle: "5 weeks, no excuses",
    items: [I("Days", 29)],
    tone: "DARK",
  }, { seconds: 5, featured: true, enterSfx: "SOFT_POP" }),
  preset("tracker-habit-writing", "Wrote every morning", "A light habit grid for a daily practice.", "LIFE", ["habit", "streak", "writing", "routine", "tracker"], "TRACKER", {
    variant: "HABIT",
    title: "Morning pages",
    subtitle: "500 words before the phone",
    items: [I("Days", 32)],
    tone: "LIGHT",
  }, { seconds: 5, enterSfx: "SOFT_POP" }),
  preset("tracker-sets-bench", "Bench press sets", "A workout set counter: reps fill in, sets check off, the current set pulses.", "LIFE", ["workout", "gym", "sets", "reps", "bench press", "lifting"], "TRACKER", {
    variant: "SETS",
    title: "Bench press",
    subtitle: "185 lb · last set is the one",
    items: [I("Set 1", 8, DONE), I("Set 2", 8, DONE), I("Set 3", 7, DONE), I("Set 4", 6)],
    tone: "DARK",
  }, { seconds: 5.5, featured: true, enterSfx: "CLICK" }),
  preset("tracker-sets-pullups", "Pull-up ladder", "A light set counter for bodyweight work.", "LIFE", ["workout", "gym", "sets", "pull-ups", "calisthenics", "reps"], "TRACKER", {
    variant: "SETS",
    title: "Pull-ups",
    subtitle: "Bodyweight · rest 90 s",
    items: [I("Set 1", 12, DONE), I("Set 2", 10, DONE), I("Set 3", 8)],
    tone: "LIGHT",
  }, { seconds: 5, enterSfx: "CLICK" }),
  preset("tracker-mood-portfolio", "Me checking my portfolio", "A mood meter: the needle swings to a face.", "LIFE", ["mood", "meter", "feelings", "reaction", "stocks", "portfolio"], "TRACKER", {
    variant: "MOOD",
    title: "Me checking my portfolio",
    items: [I("Down bad", 14)],
    tone: "DARK",
  }, { seconds: 4, enterSfx: "SWOOSH_UP" }),
  preset("tracker-mood-payday", "Payday mood", "A light mood meter swinging all the way up.", "LIFE", ["mood", "meter", "payday", "happy", "reaction"], "TRACKER", {
    variant: "MOOD",
    title: "Mood on payday",
    items: [I("Untouchable", 94)],
    tone: "LIGHT",
  }, { seconds: 4, enterSfx: "SWOOSH_UP" }),

  // ------------------------------------------------------------------ LIST_SPLIT
  preset("list-pros-cons-la", "Living in LA: pros & cons", "Two columns of pros and cons with check and cross badges.", "LISTS", ["pros and cons", "list", "los angeles", "comparison", "decision"], "LIST_SPLIT", {
    variant: "PROS_CONS",
    title: "Living in LA",
    items: [I("Sun 280 days a year", null, DONE), I("Rent eats your raise", null, NO), I("Ambitious people everywhere", null, DONE), I("You live in your car", null, NO), I("Beach after work", null, DONE), I("Everything costs $18", null, NO)],
    tone: "DARK",
  }, { seconds: 6, featured: true, enterSfx: "SOFT_POP" }),
  preset("list-pros-cons-rent", "Renting: pros & cons", "A light pros and cons list for a money decision.", "LISTS", ["pros and cons", "renting", "buying", "money", "decision", "list"], "LIST_SPLIT", {
    variant: "PROS_CONS",
    title: "Renting in your 20s",
    items: [I("Freedom to move for a job", null, DONE), I("No equity", null, NO), I("No surprise repairs", null, DONE), I("Rent goes up every year", null, NO)],
    tone: "LIGHT",
  }, { seconds: 5.5, enterSfx: "SOFT_POP" }),
  preset("list-dos-donts-10k", "Your first $10k: do's & don'ts", "Two columns of do's and don'ts.", "LISTS", ["dos and donts", "money", "list", "saving", "investing", "tips"], "LIST_SPLIT", {
    variant: "DOS_DONTS",
    title: "Your first $10k",
    items: [I("Automate the transfer", null, DONE), I("Buy a car with it", null, NO), I("Index funds, boring", null, DONE), I("Chase a hot tip", null, NO), I("Keep 3 months cash", null, DONE), I("Tell everyone", null, NO)],
    tone: "DARK",
  }, { seconds: 6, enterSfx: "SOFT_POP" }),
  preset("list-dos-donts-gym", "Gym do's & don'ts", "A light do / don't list for training.", "LISTS", ["dos and donts", "gym", "workout", "fitness", "tips", "list"], "LIST_SPLIT", {
    variant: "DOS_DONTS",
    title: "First year lifting",
    items: [I("Progressive overload", null, DONE), I("Ego lift", null, NO), I("Sleep 8 hours", null, DONE), I("Skip leg day", null, NO)],
    tone: "LIGHT",
  }, { seconds: 5.5, enterSfx: "SOFT_POP" }),
  preset("list-myth-fact-money", "Money myths vs facts", "Each myth gets struck through, then the fact slides in.", "LISTS", ["myth vs fact", "myths", "money", "facts", "finance", "debunk"], "LIST_SPLIT", {
    variant: "MYTH_FACT",
    title: "Money myths",
    items: [I("A high salary makes you rich", null, NO), I("Your savings rate does", null, DONE), I("Renting is throwing money away", null, NO), I("Rent buys flexibility; run the math", null, DONE), I("You need a lot to start investing", null, NO), I("You need $50 and a habit", null, DONE)],
    tone: "DARK",
  }, { seconds: 7, featured: true, enterSfx: "SOFT_POP" }),
  preset("list-myth-fact-gym", "Gym myths vs facts", "A light myth → fact list for fitness takes.", "LISTS", ["myth vs fact", "gym", "fitness", "myths", "facts", "workout"], "LIST_SPLIT", {
    variant: "MYTH_FACT",
    title: "Gym myths",
    items: [I("Cardio kills gains", null, NO), I("It helps you recover between sets", null, DONE), I("You need 2 hours a day", null, NO), I("45 focused minutes beats 2 lazy hours", null, DONE)],
    tone: "LIGHT",
  }, { seconds: 6, enterSfx: "SOFT_POP" }),
];
