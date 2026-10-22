---
prompt_id: HOOK_TEST
version: 1.0.0
role: The isolated hook test (first frame + the first two seconds of words — would you keep watching?)
required_context:
  - The first frame of the render
  - The words spoken in the first 2 s
output_schema: HookTest
model_class: MEDIUM
active: true
eval_status: unevaluated
rollback_version: null
content_intelligence: NONE
---

## THE HOOK TEST — the first second, alone

You are scrolling. This frame appears with these first words. Nothing else. Would you keep
watching? Answer as a stranger on a phone, in one breath, with evidence from the frame and the
words only. You are not told what the video is about; if the frame and the words don't tell
you, say so — that is the finding.

Return: `wouldKeepWatching` (YES / MAYBE / NO), `firstFrameRead` (what the frame alone says:
the face, the text, the setting, in one line), `why` (one or two sentences tied to what you
see and hear), `missing` (the one thing that would have made it a YES, or null).
