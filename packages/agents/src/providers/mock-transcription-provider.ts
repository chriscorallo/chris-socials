import type { TranscriptionProvider, TranscriptionResult } from "../transcription-provider";

/** Deterministic, zero-cost stand-in for tests — see mock-provider.ts's rationale. */
export class MockTranscriptionProvider implements TranscriptionProvider {
  private readonly responder: (filePath: string) => TranscriptionResult;
  public readonly calls: string[] = [];

  constructor(responder: (filePath: string) => TranscriptionResult) {
    this.responder = responder;
  }

  async transcribe(filePath: string): Promise<TranscriptionResult> {
    this.calls.push(filePath);
    return this.responder(filePath);
  }
}
