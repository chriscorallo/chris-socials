import { requireSession } from "../../lib/session";
import { storageMode } from "../../lib/storage";
import { NavBar } from "../components/NavBar";
import { PageShell, PageHeader, Panel } from "../components/ui";
import { FootageUpload } from "./FootageUpload";

export const maxDuration = 300;

/** The one place to upload footage — no planning steps required first. */
export default async function UploadPage() {
  await requireSession();
  return (
    <>
      <NavBar />
      <PageShell maxWidth={640}>
        <PageHeader
          eyebrow="Upload"
          title="Upload a video"
          description="Pick the video you filmed. It goes straight into the editor, with captions — no setup first."
        />
        <Panel>
          <FootageUpload mode={storageMode} />
        </Panel>
        <p className="mt-4 text-[13px] text-[var(--color-text-faint)]">
          Filmed something for a video you already planned? Open it from Videos and tap “Upload footage” there instead.
        </p>
      </PageShell>
    </>
  );
}
