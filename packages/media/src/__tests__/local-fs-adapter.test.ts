import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalFsStorageAdapter } from "../local-fs-adapter";

describe("LocalFsStorageAdapter", () => {
  let baseDir: string;
  let adapter: LocalFsStorageAdapter;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "chris-media-test-"));
    adapter = new LocalFsStorageAdapter({ baseDir });
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("writes and reads back a file, creating nested directories as needed", async () => {
    const data = Buffer.from("hello world");
    await adapter.put("raw/item-1/take-1.txt", data);
    const read = await adapter.get("raw/item-1/take-1.txt");
    expect(read.toString()).toBe("hello world");
  });

  it("deletes a file", async () => {
    await adapter.put("to-delete.txt", Buffer.from("bye"));
    await adapter.delete("to-delete.txt");
    await expect(adapter.get("to-delete.txt")).rejects.toThrow();
  });

  it("returns an app-route-based signedUrl with each segment encoded but slashes preserved", async () => {
    const url = await adapter.signedUrl("raw/item 1/take-1.mp4", 3600);
    expect(url).toBe("/api/media/raw/item%201/take-1.mp4");
  });

  it("rejects an absolute key", async () => {
    await expect(adapter.put("/etc/passwd", Buffer.from("x"))).rejects.toThrow();
  });

  it("rejects a key that attempts to escape the base directory", async () => {
    await expect(adapter.put("../../escape.txt", Buffer.from("x"))).rejects.toThrow();
  });

  it("rejects a key that resolves into a sibling directory sharing the base dir's prefix", async () => {
    const siblingName = `${baseDir.split("/").pop()}-sibling`;
    await expect(adapter.put(`../${siblingName}/x.txt`, Buffer.from("x"))).rejects.toThrow();
  });

  it("putFile copies an on-disk file into storage without the caller buffering it", async () => {
    const { writeFile } = await import("node:fs/promises");
    const src = join(baseDir, "..", `${baseDir.split("/").pop()}-src.bin`);
    await writeFile(src, Buffer.from("large-ish payload"));
    try {
      await adapter.putFile("raw/item-2/take.bin", src);
      expect((await adapter.get("raw/item-2/take.bin")).toString()).toBe("large-ish payload");
      expect(adapter.pathFor("raw/item-2/take.bin")).toBe(join(baseDir, "raw/item-2/take.bin"));
    } finally {
      await rm(src, { force: true });
    }
  });
});
