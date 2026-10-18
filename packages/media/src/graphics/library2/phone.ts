import type { GraphicPreset } from "../presets";
import { I, ME, PCT, THEM, USD, preset } from "./kit";

/**
 * Library 2 — PHONE & APPS presets (DM_CHAT, NOTIFICATION, CALL, PHONE_APP, CLOCK_TIMER,
 * STATUS_ALERT, APP_GRID, KEYNOTE). Generic phone-style UI only: placeholder people and neutral
 * app names; numbers are illustrative placeholders.
 */
const P = "PHONE" as const;
const CHAT_TAGS = ["text message", "imessage", "texting", "chat", "conversation"];

export const PHONE_PRESETS: GraphicPreset[] = [
  // ------------------------------------------------------------------ DM_CHAT
  preset("chat-mom-raise", "Text thread: the raise", "A text thread with Mom — typing dots, replies and a tap-back heart.", P, [...CHAT_TAGS, "mom", "raise", "savings"], "DM_CHAT", {
    title: "Mom",
    subtitle: "mobile",
    meta: "Read 9:41 AM",
    tone: "LIGHT",
    items: [THEM("Did you get the raise??"), ME("I did. +$12k a year."), THEM("So you're finally getting the new car"), ME("Nope. Every dollar of it goes to savings."), THEM("Who raised you", { icon: "FACE_LAUGH" }), ME("You did.", { icon: "HEART" })],
  }, { seconds: 9, featured: true }),
  preset("chat-dm-landlord", "DM: rent going up", "A direct-message exchange with the landlord about a rent hike.", P, ["dm", "direct message", "texting", "rent", "landlord", "chat"], "DM_CHAT", {
    variant: "DM",
    title: "Landlord",
    subtitle: "Active now",
    tone: "DARK",
    items: [THEM("Rent's going up $300 in March."), ME("That's 14% in one year."), THEM("Market rate. Take it or leave it."), ME("Leaving it. Already signed somewhere cheaper.", { icon: "THUMBS_UP" })],
  }, { seconds: 8 }),
  preset("chat-group-gym", "Group chat: 6AM crew", "A group chat with sender names — the gym crew calling out a skip.", P, [...CHAT_TAGS, "group chat", "gym", "friends"], "DM_CHAT", {
    variant: "GROUP",
    title: "6AM Crew",
    subtitle: "Alex, Sam & Jordan",
    tone: "LIGHT",
    items: [THEM("Who's in tomorrow?", { sub: "Alex" }), THEM("In.", { sub: "Sam" }), THEM("Rest day lol", { sub: "Jordan" }), ME("Rest day was Sunday."), THEM("...fine. I'm in.", { sub: "Jordan", icon: "FACE_LAUGH" })],
  }, { seconds: 9 }),
  preset("chat-bubbles-save-la", "Floating texts: saving in LA", "Just the bubbles, floating over your footage — how to save $2k a month in LA.", P, [...CHAT_TAGS, "bubbles", "saving", "la"], "DM_CHAT", {
    variant: "BUBBLES",
    tone: "LIGHT",
    items: [THEM("How are you saving $2k a month in LA?"), ME("No car payment. Roommate. Cook at home."), THEM("That's it?"), ME("That's it. Boring works.")],
  }, { seconds: 8, enterSfx: null }),
  preset("chat-boss-comp", "Text the boss: comp talk", "Asking the boss for a comp conversation, with a delivered receipt.", P, [...CHAT_TAGS, "boss", "salary", "negotiation"], "DM_CHAT", {
    title: "Boss",
    tone: "DARK",
    meta: "Delivered",
    items: [ME("Can we talk comp this week?"), THEM("Sure. What are you thinking?"), ME("Market data says I'm 18% under."), THEM("Let's grab 30 minutes Thursday.", { icon: "THUMBS_UP" })],
  }, { seconds: 8 }),
  preset("chat-dm-exposure", "DM: paid in exposure", "A brand asking for free work in the DMs — and the reply.", P, ["dm", "direct message", "creator", "brand deal", "texting", "chat"], "DM_CHAT", {
    variant: "DM",
    title: "Brand Partnerships",
    subtitle: "Business account",
    tone: "LIGHT",
    items: [THEM("Love your content! Can we send you free product for a post?"), ME("What's the budget?"), THEM("It's a great exposure opportunity!"), ME("Exposure doesn't pay rent.", { icon: "HUNDRED" })],
  }, { seconds: 8 }),
  preset("chat-bubbles-dad-rent", "Floating texts: rent vs own", "Dad's classic rent-vs-own text, as floating bubbles.", P, [...CHAT_TAGS, "bubbles", "rent", "house", "dad"], "DM_CHAT", {
    variant: "BUBBLES",
    tone: "DARK",
    items: [THEM("Why rent when you could own?"), ME("Because owning here costs 2x renting."), THEM("Hm. Send me the math.")],
  }, { seconds: 7, enterSfx: null }),
  preset("chat-group-roommates", "Group chat: splitting bills", "Roommates splitting the utility bill in the group chat.", P, [...CHAT_TAGS, "group chat", "roommates", "bills"], "DM_CHAT", {
    variant: "GROUP",
    title: "Apt 4B",
    subtitle: "3 people",
    tone: "DARK",
    items: [THEM("Utilities came in. $186.", { sub: "Sam" }), THEM("I'll send my third tonight", { sub: "Alex" }), ME("Sent $62. Done.", { icon: "HUNDRED" }), THEM("Fastest roommate alive", { sub: "Sam" })],
  }, { seconds: 8 }),

  // ------------------------------------------------------------------ NOTIFICATION
  preset("notif-stack-payday", "Notifications: payday", "Push notifications stacking up — paycheck in, savings out, portfolio up.", P, ["notification", "push", "notifications", "bank alert", "payday", "money"], "NOTIFICATION", {
    tone: "LIGHT",
    meta: "now",
    items: [
      I("Payday", null, { sub: "Direct deposit: $3,250.00", meta: "Bank", icon: "BANK" }),
      I("Auto-transfer complete", null, { sub: "$800 moved to savings", meta: "Bank", icon: "PIGGY" }),
      I("Portfolio update", null, { sub: "Up 2.4% this month", meta: "Invest", icon: "CHART_UP" }),
    ],
  }, { seconds: 6 }),
  preset("notif-stack-creator", "Notifications: video taking off", "Creator notifications stacking — followers, views, payout.", P, ["notification", "push", "notifications", "creator", "views", "followers"], "NOTIFICATION", {
    tone: "DARK",
    meta: "now",
    items: [
      I("New follower", null, { sub: "Sam started following you", meta: "Social", icon: "USER" }),
      I("Your video is taking off", null, { sub: "10K views in the first hour", meta: "Creator", icon: "FIRE" }),
      I("Payout sent", null, { sub: "$1,240 is on the way", meta: "Creator", icon: "CASH" }),
    ],
  }, { seconds: 6 }),
  preset("notif-stack-subscriptions", "Notifications: subscription creep", "Renewal after renewal stacking up — death by subscriptions.", P, ["notification", "push", "subscriptions", "bank alert", "spending", "money"], "NOTIFICATION", {
    tone: "LIGHT",
    meta: "now",
    items: [
      I("Subscription renewed", null, { sub: "$15.99 · Streaming", meta: "Card", icon: "TV" }),
      I("Subscription renewed", null, { sub: "$11.99 · Music", meta: "Card", icon: "MUSIC" }),
      I("Subscription renewed", null, { sub: "$9.99 · Cloud storage", meta: "Card", icon: "CLOUD" }),
      I("Free trial ended", null, { sub: "$59.99 a year, charged today", meta: "Card", icon: "ALERT", color: "NEGATIVE" }),
    ],
  }, { seconds: 7 }),
  preset("notif-lock-morning", "Lock screen: 6AM", "A lock screen with the big clock and the morning's notifications.", P, ["lock screen", "notification", "push", "alarm", "morning", "phone"], "NOTIFICATION", {
    variant: "LOCK",
    tone: "DARK",
    title: "6:12",
    subtitle: "Monday, January 6",
    meta: "now",
    items: [
      I("Gym in 18 minutes", null, { sub: "Leg day. Don't be weird about it.", meta: "Reminders", icon: "DUMBBELL" }),
      I("Rent due tomorrow", null, { sub: "$2,100 · Auto-pay is off", meta: "Calendar", icon: "CALENDAR" }),
      I("Mom", null, { sub: "Call me when you're up", meta: "Messages", icon: "CHAT" }),
    ],
  }, { seconds: 7, featured: true }),
  preset("notif-lock-payday", "Lock screen: payday", "A light lock screen — the deposit lands, the card balance is zero.", P, ["lock screen", "notification", "push", "bank alert", "payday"], "NOTIFICATION", {
    variant: "LOCK",
    tone: "LIGHT",
    title: "9:41",
    subtitle: "Friday, March 28",
    meta: "now",
    items: [
      I("Payday", null, { sub: "Direct deposit $4,812.33", meta: "Bank", icon: "BANK" }),
      I("Statement ready", null, { sub: "Balance paid in full: $0.00", meta: "Card", icon: "CARD" }),
    ],
  }, { seconds: 6 }),
  preset("notif-banner-received", "Bank alert: you received $", "One big bank banner drops in — the amount counts up.", P, ["bank alert", "notification", "push", "money", "payment", "received"], "NOTIFICATION", {
    variant: "BANNER",
    tone: "LIGHT",
    meta: "now",
    items: [I("You received $2,500.00", null, { sub: "From Alex · Invoice #14, paid in full", meta: "Bank", icon: "BANK", color: "POSITIVE" })],
  }, { seconds: 4.5, featured: true, enterSfx: "CASH" }),
  preset("notif-banner-low-balance", "Bank alert: low balance", "A low-balance warning banner drops in.", P, ["bank alert", "notification", "push", "overdraft", "broke", "money"], "NOTIFICATION", {
    variant: "BANNER",
    tone: "DARK",
    meta: "now",
    items: [I("Low balance alert", null, { sub: "Your checking account is below $50.", meta: "Bank", icon: "ALERT", color: "NEGATIVE" })],
  }, { seconds: 4 }),
  preset("notif-banner-goal", "Savings goal reached", "A celebratory banner: the emergency fund is fully funded.", P, ["notification", "push", "savings", "goal", "bank alert", "emergency fund"], "NOTIFICATION", {
    variant: "BANNER",
    tone: "DARK",
    meta: "now",
    items: [I("Goal reached: $10,000", null, { sub: "Emergency fund fully funded. Six months covered.", meta: "Savings", icon: "TROPHY", color: "POSITIVE" })],
  }, { seconds: 4.5, enterSfx: "CASH" }),

  // ------------------------------------------------------------------ CALL
  preset("call-incoming-mom", "Incoming call: Mom", "A full incoming-call screen with a pulsing accept button.", P, ["call", "phone call", "incoming call", "facetime", "mom", "ringing"], "CALL", {
    tone: "DARK",
    title: "Mom",
    subtitle: "mobile",
  }, { seconds: 5, featured: true }),
  preset("call-incoming-landlord", "Incoming call: landlord", "A light incoming-call screen — the landlord on the 1st.", P, ["call", "phone call", "incoming call", "landlord", "rent"], "CALL", {
    tone: "LIGHT",
    title: "Landlord",
    subtitle: "Calling on the 1st",
  }, { seconds: 5 }),
  preset("call-banner-boss", "Call banner: the boss", "A compact incoming-call banner drops in from the top.", P, ["call", "phone call", "incoming call", "banner", "boss", "work"], "CALL", {
    variant: "BANNER",
    tone: "LIGHT",
    title: "Boss",
    subtitle: "mobile",
  }, { seconds: 4 }),
  preset("call-banner-unknown", "Call banner: unknown caller", "An unknown caller banner — the 'your car warranty' energy.", P, ["call", "phone call", "spam", "scam", "banner", "unknown"], "CALL", {
    variant: "BANNER",
    tone: "DARK",
    title: "Unknown Caller",
    subtitle: "Potential spam",
  }, { seconds: 4 }),
  preset("call-video-cofounder", "Video call: co-founder", "A video-call screen — caller tile, self view, controls and a running timer.", P, ["facetime", "video call", "call", "zoom", "cofounder", "startup"], "CALL", {
    variant: "VIDEO",
    tone: "DARK",
    title: "Sam",
    meta: "02:14",
  }, { seconds: 5 }),
  preset("call-missed-mom", "Missed calls: Mom (4)", "A missed-call card whose count ticks up — Mom called four times.", P, ["missed call", "call", "phone call", "mom", "notification"], "CALL", {
    variant: "MISSED",
    tone: "LIGHT",
    title: "Mom",
    subtitle: "mobile",
    meta: "7:02 AM",
    items: [I("Missed call", 4)],
  }, { seconds: 4 }),
  preset("call-missed-recruiter", "Missed call: recruiter", "A dark missed-call card from a recruiter.", P, ["missed call", "call", "recruiter", "job", "career"], "CALL", {
    variant: "MISSED",
    tone: "DARK",
    title: "Recruiter",
    subtitle: "mobile",
    meta: "Yesterday",
    items: [I("Missed call", 2)],
  }, { seconds: 4 }),

  // ------------------------------------------------------------------ PHONE_APP
  preset("app-notes-budget", "Notes: monthly budget", "A notes page typing out a monthly budget, line by line.", P, ["notes", "notes app", "budget", "typing", "list", "money"], "PHONE_APP", {
    variant: "NOTES",
    tone: "LIGHT",
    meta: "Today at 7:42 AM",
    title: "Monthly budget",
    items: [I("Savings: $1,200 (paid first)"), I("Rent: $1,850"), I("Food: $600"), I("Fun: $400, guilt-free")],
  }, { seconds: 7, featured: true }),
  preset("app-notes-goals", "Notes: goals checklist", "A notes checklist of yearly goals that types in and checks off.", P, ["notes", "notes app", "goals", "checklist", "new year", "typing"], "PHONE_APP", {
    variant: "NOTES",
    tone: "DARK",
    title: "2026 goals",
    items: [I("Emergency fund: 6 months", null, { state: "DONE" }), I("Max out retirement", null, { state: "TODO" }), I("Run a half marathon", null, { state: "DONE" }), I("Ship the app", null, { state: "TODO" })],
  }, { seconds: 7 }),
  preset("app-reminders-reset", "Reminders: Sunday reset", "A reminders list checking off in turn with a strike-through.", P, ["reminder", "reminders", "to do", "checklist", "sunday reset", "money"], "PHONE_APP", {
    variant: "REMINDERS",
    tone: "LIGHT",
    title: "Sunday reset",
    items: [
      I("Move $500 to savings", null, { state: "DONE" }),
      I("Cancel the unused subscription", null, { state: "DONE", sub: "Saves $180 a year" }),
      I("Check credit score", null, { state: "DONE" }),
      I("Meal prep for the week", null, { state: "TODO" }),
    ],
  }, { seconds: 6 }),
  preset("app-reminders-gym", "Reminders: today's non-negotiables", "A dark reminders list — gym, steps, protein, sleep.", P, ["reminder", "reminders", "gym", "habits", "to do", "fitness"], "PHONE_APP", {
    variant: "REMINDERS",
    tone: "DARK",
    title: "Today",
    items: [I("Gym at 6:00 AM", null, { state: "DONE", sub: "Leg day" }), I("10,000 steps", null, { state: "DONE" }), I("160g protein", null, { state: "TODO" }), I("In bed by 10:30", null, { state: "TODO" })],
  }, { seconds: 6 }),
  preset("app-inbox-offer", "Inbox: the offer letter", "An email inbox with unread dots — the offer letter on top.", P, ["email", "inbox", "mail", "job offer", "unread", "gmail"], "PHONE_APP", {
    variant: "INBOX",
    tone: "LIGHT",
    title: "Inbox",
    subtitle: "3 unread",
    highlight: 0,
    items: [
      I("Recruiting Team", null, { sub: "Offer letter: please review", meta: "9:12 AM", state: "TODO" }),
      I("Bank", null, { sub: "Your statement is ready", meta: "8:40 AM", state: "TODO" }),
      I("Property Management", null, { sub: "Lease renewal: new terms", meta: "Yesterday", state: "TODO" }),
      I("Alex", null, { sub: "Dinner Friday?", meta: "Mon" }),
    ],
  }, { seconds: 6 }),
  preset("app-inbox-creator", "Inbox: creator business", "A dark inbox — brand inquiry, edit, taxes.", P, ["email", "inbox", "mail", "creator", "brand deal", "taxes"], "PHONE_APP", {
    variant: "INBOX",
    tone: "DARK",
    title: "Inbox",
    items: [
      I("Brand Team", null, { sub: "Paid partnership inquiry", meta: "10:05 AM", state: "TODO" }),
      I("Editor", null, { sub: "v3 cut is ready for review", meta: "9:30 AM", state: "TODO" }),
      I("Accountant", null, { sub: "Quarterly taxes due the 15th", meta: "Tue" }),
      I("Weekly Digest", null, { sub: "Your numbers this week", meta: "Mon" }),
    ],
  }, { seconds: 6 }),
  preset("app-email-offer", "Email: the offer", "An opened email — subject, sender and the offer details, line by line.", P, ["email", "mail", "job offer", "salary", "inbox", "negotiation"], "PHONE_APP", {
    variant: "EMAIL",
    tone: "LIGHT",
    title: "Your offer from the team",
    subtitle: "Recruiting Team",
    meta: "9:12 AM",
    body: "We're excited to offer you the Senior Analyst role: $145,000 base, 10% bonus, equity vesting over 4 years. Please reply by Friday.",
  }, { seconds: 7, featured: true }),
  preset("app-email-rent", "Email: rent increase notice", "A dark opened email announcing a rent increase.", P, ["email", "mail", "rent", "landlord", "inbox", "notice"], "PHONE_APP", {
    variant: "EMAIL",
    tone: "DARK",
    title: "Rent increase notice",
    subtitle: "Property Management",
    meta: "Mon 8:03 AM",
    body: "Starting March 1, your monthly rent will increase from $2,400 to $2,750. Please confirm your renewal within 30 days.",
  }, { seconds: 7 }),
  preset("app-invite-money-date", "Calendar invite: money date", "A calendar invite that gets accepted — the weekly money date.", P, ["calendar", "invite", "calendar invite", "meeting", "budget", "couple"], "PHONE_APP", {
    variant: "INVITE",
    tone: "LIGHT",
    title: "Money date: review the budget",
    subtitle: "Sun, Jan 12 · 10:00 AM",
    meta: "Coffee shop on 3rd",
    items: [I("Sam"), I("You")],
  }, { seconds: 6 }),
  preset("app-invite-launch", "Calendar invite: launch day", "A dark calendar invite for launch day, attendees and accept.", P, ["calendar", "invite", "calendar invite", "launch", "startup", "meeting"], "PHONE_APP", {
    variant: "INVITE",
    tone: "DARK",
    title: "Launch day: ship v1",
    subtitle: "Fri, Oct 24 · 9:00 AM",
    meta: "Video call",
    items: [I("Alex"), I("Sam"), I("Jordan"), I("Riley"), I("Morgan"), I("Taylor")],
  }, { seconds: 6 }),

  // ------------------------------------------------------------------ CLOCK_TIMER
  preset("clock-alarm-5am", "Alarm: 5:00 AM", "A ringing alarm card — bell shaking, snooze or stop.", P, ["alarm", "clock", "morning", "5am", "wake up", "discipline"], "CLOCK_TIMER", {
    tone: "DARK",
    title: "5:00 AM",
    subtitle: "Gym. No excuses.",
  }, { seconds: 4, featured: true }),
  preset("clock-alarm-deep-work", "Alarm: deep work", "A light alarm card for an early deep-work block.", P, ["alarm", "clock", "morning", "productivity", "deep work"], "CLOCK_TIMER", {
    tone: "LIGHT",
    title: "6:30 AM",
    subtitle: "Deep work before email",
  }, { seconds: 4 }),
  preset("clock-timer-focus", "Timer: 25-minute focus", "A countdown ring draining from 25:00 to zero.", P, ["timer", "countdown", "focus", "pomodoro", "productivity", "clock"], "CLOCK_TIMER", {
    variant: "TIMER",
    tone: "DARK",
    title: "Focus block",
    subtitle: "Phone in the other room",
    items: [I("Start", 1500), I("End", 0)],
  }, { seconds: 5 }),
  preset("clock-timer-rest", "Timer: rest between sets", "A light 90-second rest timer counting down.", P, ["timer", "countdown", "gym", "rest", "workout", "clock"], "CLOCK_TIMER", {
    variant: "TIMER",
    tone: "LIGHT",
    title: "Rest between sets",
    items: [I("Start", 90), I("End", 0)],
  }, { seconds: 4 }),
  preset("clock-stopwatch-mile", "Stopwatch: mile time", "Running stopwatch digits landing on a mile time.", P, ["stopwatch", "timer", "running", "mile", "fitness", "clock"], "CLOCK_TIMER", {
    variant: "STOPWATCH",
    tone: "DARK",
    title: "Mile time",
    items: [I("Time", 412.36)],
  }, { seconds: 4 }),
  preset("clock-analog-deep-work", "Clock: 4 hours of deep work", "An analog clock time-lapse from 9 to 1.", P, ["clock", "time lapse", "deep work", "hours", "productivity", "time"], "CLOCK_TIMER", {
    variant: "CLOCK",
    tone: "LIGHT",
    title: "Deep work",
    items: [I("From", 9), I("To", 13)],
  }, { seconds: 5 }),
  preset("clock-analog-doomscroll", "Clock: where the night went", "A dark analog clock spinning from 10 PM to 1 AM.", P, ["clock", "time lapse", "doomscrolling", "screen time", "late night", "time"], "CLOCK_TIMER", {
    variant: "CLOCK",
    tone: "DARK",
    title: "Doomscrolling",
    items: [I("From", 22), I("To", 25)],
  }, { seconds: 5 }),

  // ------------------------------------------------------------------ STATUS_ALERT
  preset("status-battery-1", "Battery at 1%", "A low-battery alert draining to 1% — red and blinking.", P, ["battery", "low battery", "1%", "alert", "phone", "emergency fund"], "STATUS_ALERT", {
    tone: "LIGHT",
    title: "Battery at 1%",
    body: "Just like your emergency fund.",
    items: [I("", 1)],
  }, { seconds: 4, featured: true }),
  preset("status-battery-dark", "Low battery", "A dark low-battery card draining to 3%.", P, ["battery", "low battery", "alert", "phone", "sleep"], "STATUS_ALERT", {
    tone: "DARK",
    title: "Low battery",
    body: "Your phone needs a charger. You need sleep.",
    items: [I("", 3)],
  }, { seconds: 4 }),
  preset("status-no-signal", "No connection", "Signal bars and wifi dropping out one by one.", P, ["wifi", "no signal", "no wifi", "offline", "connection", "alert"], "STATUS_ALERT", {
    variant: "SIGNAL",
    tone: "DARK",
    title: "No connection",
    body: "Offline mode: the best productivity hack.",
  }, { seconds: 4.5 }),
  preset("status-alert-cart", "Alert: delete the cart?", "A system dialog — delete the impulse-buy cart; the button gets tapped.", P, ["alert", "dialog", "popup", "delete", "shopping", "impulse"], "STATUS_ALERT", {
    variant: "ALERT",
    tone: "LIGHT",
    title: "Delete “Impulse Buys”?",
    body: "This removes 47 items from your cart. This can't be undone.",
    items: [I("Cancel"), I("Delete", null, { state: "DONE", color: "NEGATIVE" })],
  }, { seconds: 4.5, featured: true }),
  preset("status-alert-subscription", "Alert: cancel subscription?", "A dark three-button dialog for cancelling a subscription.", P, ["alert", "dialog", "popup", "subscription", "cancel", "money"], "STATUS_ALERT", {
    variant: "ALERT",
    tone: "DARK",
    title: "Cancel subscription?",
    body: "You'll save $180 a year.",
    items: [I("Cancel subscription", null, { state: "DONE" }), I("Keep it"), I("Remind me later")],
  }, { seconds: 5 }),
  preset("status-toast-saved", "Toast: saved", "A small pill toast slides down — saved to a collection.", P, ["toast", "saved", "bookmark", "popup", "pill"], "STATUS_ALERT", {
    variant: "TOAST",
    tone: "DARK",
    title: "Saved to Money Moves",
    items: [I("", null, { icon: "BOOKMARK" })],
  }, { seconds: 3 }),
  preset("status-toast-transfer", "Toast: moved to savings", "A light pill toast confirming a savings transfer.", P, ["toast", "savings", "transfer", "popup", "bank alert"], "STATUS_ALERT", {
    variant: "TOAST",
    tone: "LIGHT",
    title: "$500 moved to savings",
    items: [I("", null, { icon: "CHECK", color: "POSITIVE" })],
  }, { seconds: 3, enterSfx: "CASH" }),

  // ------------------------------------------------------------------ APP_GRID
  preset("apps-grid-badges", "Home screen: badge overload", "Home-screen app icons popping in, badge counts ticking up.", P, ["app icons", "home screen", "badges", "notifications", "phone", "distraction"], "APP_GRID", {
    tone: "DARK",
    items: [
      I("Mail", 23, { icon: "MAIL" }),
      I("Messages", 9, { icon: "CHAT" }),
      I("Social", 99, { icon: "HEART" }),
      I("News", 14, { icon: "NEWS" }),
      I("Calendar", 2, { icon: "CALENDAR" }),
      I("Bank", null, { icon: "BANK" }),
      I("Photos", null, { icon: "CAMERA" }),
      I("Music", null, { icon: "MUSIC" }),
    ],
  }, { seconds: 5, featured: true }),
  preset("apps-grid-money", "Home screen: money apps", "A light row of money apps — the ones that actually matter.", P, ["app icons", "home screen", "money apps", "budget", "bank", "invest"], "APP_GRID", {
    tone: "LIGHT",
    highlight: 2,
    items: [I("Bank", null, { icon: "BANK" }), I("Budget", 1, { icon: "PIE" }), I("Invest", 3, { icon: "CHART_UP" }), I("Card", null, { icon: "CARD" })],
  }, { seconds: 4 }),
  preset("apps-dock", "App dock", "A frosted dock with four apps bouncing in, badges counting.", P, ["dock", "app icons", "home screen", "phone", "badges"], "APP_GRID", {
    variant: "DOCK",
    tone: "DARK",
    items: [I("Messages", 4, { icon: "CHAT" }), I("Mail", 12, { icon: "MAIL" }), I("Camera", null, { icon: "CAMERA" }), I("Music", null, { icon: "MUSIC" })],
  }, { seconds: 4 }),
  preset("apps-dock-social", "App dock: 1.2K notifications", "A light dock where one social app hits 1.2K badges.", P, ["dock", "app icons", "notifications", "social media", "badges", "addiction"], "APP_GRID", {
    variant: "DOCK",
    tone: "LIGHT",
    highlight: 0,
    items: [I("Social", 1200, { icon: "HEART" }), I("Video", 48, { icon: "PLAY" }), I("Messages", 6, { icon: "CHAT" }), I("Mail", null, { icon: "MAIL" })],
  }, { seconds: 4 }),
  preset("apps-store-budget", "App listing: budget app", "An app-store-style listing — stars fill, the Get button gets tapped.", P, ["app store", "app", "download", "rating", "stars", "budget"], "APP_GRID", {
    variant: "STORE",
    tone: "LIGHT",
    title: "Budget Coach",
    subtitle: "Track every dollar. Automatically.",
    items: [I("Rating", 4.8, { icon: "PIE", color: "POSITIVE" }), I("Ratings", 12400), I("in Finance", 3)],
  }, { seconds: 6, featured: true }),
  preset("apps-store-habits", "App listing: habit tracker", "A dark app listing for a habit tracker with a download.", P, ["app store", "app", "download", "habits", "rating", "fitness"], "APP_GRID", {
    variant: "STORE",
    tone: "DARK",
    title: "Daily Reps",
    subtitle: "Habits that compound.",
    items: [I("Rating", 4.9, { icon: "DUMBBELL" }), I("Ratings", 8200), I("in Health", 7)],
  }, { seconds: 6 }),

  // ------------------------------------------------------------------ KEYNOTE
  preset("keynote-number-million", "Keynote: $1M by 35", "Keynote-style stage: one huge number counting up, clean type.", P, ["keynote", "apple", "big number", "stage", "presentation", "millionaire"], "KEYNOTE", {
    tone: "DARK",
    screen: "FULL",
    subtitle: "The goal",
    title: "Saved by 35. One boring habit.",
    items: [I("", 1000000)],
    format: USD,
  }, { seconds: 4.5, featured: true, enterSfx: "RISER" }),
  preset("keynote-number-rate", "Keynote: 40% savings rate", "A white keynote stage with a giant percentage.", P, ["keynote", "apple", "big number", "percent", "savings rate", "presentation"], "KEYNOTE", {
    tone: "LIGHT",
    screen: "FULL",
    title: "Savings rate. Not salary.",
    items: [I("", 40)],
    format: PCT,
  }, { seconds: 4, enterSfx: "RISER" }),
  preset("keynote-title-income", "Keynote: big statement", "A keynote-style statement, word by word, on a black stage.", P, ["keynote", "apple", "title", "statement", "presentation", "quote"], "KEYNOTE", {
    variant: "TITLE",
    tone: "DARK",
    screen: "FULL",
    title: "Your salary isn't your income.",
    subtitle: "Your savings rate is.",
  }, { seconds: 4.5, featured: true, enterSfx: "WHOOSH" }),
  preset("keynote-title-rent", "Keynote: white-stage statement", "A white keynote stage with a big statement and a line under it.", P, ["keynote", "apple", "title", "statement", "rent", "presentation"], "KEYNOTE", {
    variant: "TITLE",
    tone: "LIGHT",
    screen: "FULL",
    title: "Renting isn't throwing money away.",
    subtitle: "Here's the math.",
  }, { seconds: 4.5, enterSfx: "WHOOSH" }),
  preset("keynote-specs-standard", "Keynote: spec columns", "Keynote-style spec columns — three numbers count up.", P, ["keynote", "apple", "specs", "stats", "numbers", "habits"], "KEYNOTE", {
    variant: "SPECS",
    tone: "DARK",
    screen: "FULL",
    title: "The weekly standard",
    subtitle: "Boring. Automatic. Relentless.",
    items: [I("workouts", 5), I("hours of deep work", 20), I("books a year", 24)],
  }, { seconds: 5, enterSfx: "TICK" }),
  preset("keynote-specs-paycheck", "Keynote: where $5k goes", "Spec-style columns of money on a light plate over your footage.", P, ["keynote", "apple", "specs", "budget", "paycheck", "money"], "KEYNOTE", {
    variant: "SPECS",
    tone: "LIGHT",
    title: "Where $5k goes",
    items: [I("Rent", 1850), I("Saved", 1200), I("Invested", 800)],
    format: USD,
  }, { seconds: 5, enterSfx: "TICK" }),
  preset("keynote-reveal-freedom", "Keynote: one-word reveal", "One word on a black stage with a light sweep across it.", P, ["keynote", "apple", "reveal", "one word", "light sweep", "cinematic"], "KEYNOTE", {
    variant: "REVEAL",
    tone: "DARK",
    screen: "FULL",
    title: "Freedom.",
    subtitle: "That's what the money buys.",
  }, { seconds: 4, enterSfx: "SHIMMER" }),
  preset("keynote-reveal-compound", "Keynote: white reveal", "A one-word reveal with a light sweep on a white stage.", P, ["keynote", "apple", "reveal", "one word", "compound interest", "investing"], "KEYNOTE", {
    variant: "REVEAL",
    tone: "LIGHT",
    screen: "FULL",
    title: "Compound.",
    subtitle: "Time does the heavy lifting.",
  }, { seconds: 4, enterSfx: "SHIMMER" }),
];
