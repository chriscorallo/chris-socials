import Link from "next/link";
import { requireSession } from "../../lib/session";
import { storageMode } from "../../lib/storage";
import { NavBar } from "../components/NavBar";
import { PageShell, PageHeader, Panel } from "../components/ui";
import { FootageUpload } from "./FootageUpload";
import { FilmingCard } from "../components/FilmingCard";

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
        <FilmingCard className="mt-4" />
        <Link href="/plan/upload" className="btn btn-ghost mt-4 w-full !min-h-[52px] !text-[16px]">
          Upload many clips — matched to your plan
        </Link>
        <p className="mt-3 text-[13px] text-[var(--color-text-faint)]">
          Filmed videos you already planned? Use “Upload many clips” and each one lands on its planned video.
        </p>
      </PageShell>
    </>
  );
}
