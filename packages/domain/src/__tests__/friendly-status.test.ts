import { describe, it, expect } from "vitest";
import { ContentState } from "@prisma/client";
import { FRIENDLY_STATE_LABEL, friendlyStateLabel, flowStepFor, homeGroupFor, nextActionFor, FLOW_STEPS } from "../friendly-status";

const ALL = Object.values(ContentState);

describe("plain-language status", () => {
  it("has a friendly label for every state, with no enum-looking text", () => {
    for (const s of ALL) {
      const label = friendlyStateLabel(s);
      expect(label, s).toBeTruthy();
      expect(label).not.toMatch(/[A-Z]{2,}|_/);
    }
    expect(Object.keys(FRIENDLY_STATE_LABEL).sort()).toEqual([...ALL].sort());
  });

  it("uses the agreed words", () => {
    expect(friendlyStateLabel("MEDIA_INGESTED")).toBe("Editing");
    expect(friendlyStateLabel("FILMED")).toBe("Filmed — upload footage");
    expect(friendlyStateLabel("QC_BLOCKED")).toBe("Needs a fix");
    expect(friendlyStateLabel("READY")).toBe("Ready to post");
    expect(friendlyStateLabel("MEASURING")).toBe("Posted");
  });

  it("maps every state onto the five steps", () => {
    expect(FLOW_STEPS).toEqual(["Plan", "Write", "Film", "Edit", "Post"]);
    expect(flowStepFor("IDEA").index).toBe(0);
    expect(flowStepFor("SCRIPTED").index).toBe(1);
    expect(flowStepFor("FILMED").index).toBe(2);
    expect(flowStepFor("EDIT_PLANNED").index).toBe(3);
    expect(flowStepFor("SCHEDULED")).toEqual({ index: 4, done: false });
    expect(flowStepFor("PUBLISHED")).toEqual({ index: 4, done: true });
  });

  it("groups the home page", () => {
    expect(homeGroupFor("IDEA")).toBe("IDEA");
    expect(homeGroupFor("EDIT_PLANNED")).toBe("IN_PROGRESS");
    expect(homeGroupFor("QC_BLOCKED")).toBe("IN_PROGRESS");
    expect(homeGroupFor("SCHEDULED")).toBe("READY");
    expect(homeGroupFor("MEASURING")).toBe("POSTED");
    expect(homeGroupFor("CANCELLED")).toBe("HIDDEN");
  });

  it("gives every state exactly one next action", () => {
    for (const s of ALL) expect(nextActionFor(s).label, s).toBeTruthy();
    expect(nextActionFor("MEDIA_INGESTED").kind).toBe("START_EDIT");
    expect(nextActionFor("TAKE_SELECTED").kind).toBe("START_EDIT");
    expect(nextActionFor("EDIT_PLANNED").kind).toBe("EDIT");
    expect(nextActionFor("FILMED").kind).toBe("UPLOAD");
    expect(nextActionFor("READY_TO_FILM").kind).toBe("FILM");
    expect(nextActionFor("READY").kind).toBe("SCHEDULE");
    expect(nextActionFor("PUBLISHED").kind).toBe("VIEW_POST");
    expect(nextActionFor("QC_BLOCKED").kind).toBe("FIX");
  });
});
