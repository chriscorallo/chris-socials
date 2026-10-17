import { prisma, getTodoData } from "@chris/domain";
import { getVoiceSamplesText } from "@chris/agents";
import { APP_TZ } from "./calendar-data";

/** The to-do / Stay-on-course gather with this app's environment signals filled in. */
export async function loadTodo(now: Date = new Date()) {
  const data = await getTodoData(prisma, {
    now,
    tz: APP_TZ,
    anthropicKeyConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
    voiceSamplesEmpty: getVoiceSamplesText() === "",
  });
  return { ...data, now, tz: APP_TZ };
}
