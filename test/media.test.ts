import { createCipheriv } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { decryptAes128Ecb, parseAesKey } from "../src/core/aes.js";
import { isPublicHttps, resolveCdnUrl } from "../src/core/cdn.js";
import { handleBridgeRequest } from "../src/core/http.js";
import { idsToEvict, splitChunks } from "../src/core/media-store.js";
import { pcmToWav } from "../src/core/media.js";
import { normalizeInbound, sanitizeFileName } from "../src/core/normalize.js";
import { KEYS } from "../src/core/keys.js";
import { runPollStep } from "../src/core/poll.js";
import { writeSession } from "../src/core/state.js";
import { FileMediaStore } from "../src/node/file-media.js";
import { decodeSilkPcm } from "../src/node/silk.js";
import { makeApp } from "./support.js";
import type { BridgeApp } from "../src/core/app.js";

const NOW = 1_700_000_000_000;
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("aes-128-ecb", () => {
  it("round-trips plaintext and both key encodings", async () => {
    const key = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
    const samples = [Uint8Array.from([]), Uint8Array.from([1, 2, 3]), Uint8Array.from(Array.from({ length: 16 }, (_, i) => i)), jpegBytes(40)];
    for (const plain of samples) {
      const cipher = encryptEcb(plain, key);
      const out = await decryptAes128Ecb(cipher, key);
      expect(Buffer.from(out).equals(Buffer.from(plain))).toBe(true);
    }
    const rawKey = Buffer.from(key).toString("base64");
    const hexKey = Buffer.from(Buffer.from(key).toString("hex"), "utf8").toString("base64");
    expect(Buffer.from(parseAesKey(rawKey) ?? new Uint8Array()).equals(Buffer.from(key))).toBe(true);
    expect(Buffer.from(parseAesKey(hexKey) ?? new Uint8Array()).equals(Buffer.from(key))).toBe(true);
    expect(parseAesKey("@@@")).toBeNull();
    await expect(decryptAes128Ecb(Uint8Array.from([1, 2, 3]), key)).rejects.toThrow(/bad_ciphertext/);
  });
});

describe("cdn url", () => {
  it("prefers a public https full_url and otherwise builds the download url", () => {
    expect(
      resolveCdnUrl("https://cdn.example/c2c", {
        fullUrl: "https://cdn.example/obj",
        encryptQueryParam: "a b",
      }),
    ).toBe("https://cdn.example/obj");
    expect(
      resolveCdnUrl("https://cdn.example/c2c", {
        fullUrl: "http://127.0.0.1/secret",
        encryptQueryParam: "a b",
      }),
    ).toBe("https://cdn.example/c2c/download?encrypted_query_param=a%20b");
    expect(resolveCdnUrl("http://cdn.example/c2c", { fullUrl: null, encryptQueryParam: "a" })).toBeNull();
    expect(resolveCdnUrl("http://127.0.0.1:9/c2c", { fullUrl: null, encryptQueryParam: "a" })).toBe(
      "http://127.0.0.1:9/c2c/download?encrypted_query_param=a",
    );
    expect(isPublicHttps("https://169.254.169.254/latest")).toBe(false);
    expect(isPublicHttps("https://cdn.example/a")).toBe(true);
  });
});

describe("inbound parsing", () => {
  it("keeps a caption with an image, and a quote beside the sender's text", () => {
    const mixed = normalizeInbound(
      {
        message_id: "1",
        from_user_id: "owner@im.wechat",
        item_list: [
          { type: 1, text_item: { text: "see this" } },
          { type: 2, image_item: { media: {} } },
        ],
      },
      "bot@im.wechat",
      "https://bridge.example",
    );
    expect(mixed.event.type).toBe("mixed");
    expect(mixed.event.text).toBe("see this");
    expect(mixed.event.media[0]).toMatchObject({ kind: "image", error: "no_reference", url: null });
    expect(mixed.downloads).toHaveLength(0);

    const quoted = normalizeInbound(
      {
        message_id: "2",
        from_user_id: "owner@im.wechat",
        item_list: [
          {
            type: 1,
            text_item: { text: "what about this?" },
            ref_msg: {
              title: "earlier photo",
              svr_id: "55",
              message_item: {
                type: 2,
                image_item: { media: { encrypt_query_param: "qq" }, aeskey: "ab".repeat(16) },
              },
            },
          },
        ],
      },
      "bot@im.wechat",
      "https://bridge.example",
    );
    expect(quoted.event.type).toBe("text");
    expect(quoted.event.text).toBe("what about this?");
    expect(quoted.event.quote).toMatchObject({
      title: "earlier photo",
      message_id: "55",
      text: null,
    });
    expect(quoted.event.quote?.media[0]?.kind).toBe("image");
    expect(quoted.downloads).toHaveLength(1);
    expect(quoted.downloads[0]?.target).toBe(quoted.event.quote?.media[0]);
    expect(sanitizeFileName("../etc/passwd", "file.bin")).toBe("passwd");
    expect(sanitizeFileName("..", "file.bin")).toBe("file.bin");
  });

  it("copies a quote into text only when the sender added none", () => {
    const built = normalizeInbound(
      {
        message_id: "3",
        from_user_id: "owner@im.wechat",
        item_list: [
          {
            type: 1,
            ref_msg: { message_item: { type: 1, text_item: { text: "quoted line" } } },
          },
        ],
      },
      "bot@im.wechat",
      "",
    );
    expect(built.event.text).toBe("quoted line");
    expect(built.event.quote?.text).toBe("quoted line");
    expect(built.event.type).toBe("text");
  });
});

describe("media endpoint", () => {
  it("stores a decrypted image and requires the bearer token", async () => {
    const key = Uint8Array.from({ length: 16 }, (_, index) => index + 3);
    const plain = jpegBytes(80);
    const cipher = encryptEcb(plain, key);
    const wrong = Uint8Array.from({ length: 16 }, () => 9);
    const { fetchImpl, urls } = scriptedFetch({
      updates: () => ({
        ret: 0,
        get_updates_buf: "c-img",
        msgs: [
          message({
            message_id: "7",
            item_list: [
              {
                type: 2,
                image_item: {
                  aeskey: Buffer.from(key).toString("hex"),
                  media: {
                    full_url: "https://cdn.example/pic",
                    aes_key: Buffer.from(wrong).toString("base64"),
                    encrypt_query_param: "do-not-log-this-param",
                  },
                },
              },
            ],
          }),
        ],
      }),
      cdn: () => cipher,
    });
    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map((item) => String(item)).join(" "));
    };
    const app = makeApp(fetchImpl, { allowFrom: ["owner@im.wechat"], sendTyping: false });
    await seed(app);
    try {
      await runPollStep(app);
    } finally {
      console.log = original;
    }
    const event = webhook(urls, fetchImpl);
    expect(event.type).toBe("image");
    const media = event.media[0];
    expect(media).toMatchObject({
      kind: "image",
      mime_type: "image/jpeg",
      size: plain.byteLength,
      file_name: "image.jpg",
      error: null,
    });
    expect(media?.url).toMatch(/^https:\/\/bridge\.example\/media\/[0-9a-f]{32}$/);
    expect(media?.expires_at_ms).toBe(NOW + app.config.mediaTtlMs);
    expect(JSON.stringify(event)).not.toContain("do-not-log-this-param");
    expect(JSON.stringify(event)).not.toContain(Buffer.from(key).toString("hex"));
    expect(logs.join("\n")).not.toContain("do-not-log-this-param");
    expect(logs.join("\n")).not.toContain(Buffer.from(key).toString("hex"));

    const id = media?.url?.split("/").pop() ?? "";
    const open = await handleBridgeRequest(new Request(`https://bridge.example/media/${id}`), app);
    expect(open.status).toBe(401);
    const wrongToken = await handleBridgeRequest(
      new Request(`https://bridge.example/media/${id}`, { headers: { Authorization: "Bearer nope" } }),
      app,
    );
    expect(wrongToken.status).toBe(401);
    const saved = await handleBridgeRequest(
      new Request(`https://bridge.example/media/${id}`, { headers: { Authorization: "Bearer test-token" } }),
      app,
    );
    expect(saved.status).toBe(200);
    expect(saved.headers.get("content-type")).toBe("image/jpeg");
    expect(saved.headers.get("content-disposition")).toContain("image.jpg");
    expect(saved.headers.get("cache-control")).toContain("no-store");
    expect(Buffer.from(await saved.arrayBuffer()).equals(Buffer.from(plain))).toBe(true);

    app.now = () => NOW + app.config.mediaTtlMs;
    const expired = await handleBridgeRequest(
      new Request(`https://bridge.example/media/${id}`, { headers: { Authorization: "Bearer test-token" } }),
      app,
    );
    expect(expired.status).toBe(404);
    expect(urls.some((url) => url.includes("127.0.0.1") || url.includes("169.254.169.254"))).toBe(false);
  });

  it("exposes a file and a video, and skips an oversized file without fetching it", async () => {
    const key = Uint8Array.from({ length: 16 }, (_, index) => 20 + index);
    const pdf = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 1, 2, 3, 4]);
    const mp4 = new Uint8Array(32);
    mp4.set(Uint8Array.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]), 0);
    let downloads = 0;
    const { fetchImpl } = scriptedFetch({
      updates: () => ({
        ret: 0,
        get_updates_buf: "c-file",
        msgs: [
          message({
            message_id: "8",
            item_list: [
              { type: 1, text_item: { text: "notes" } },
              {
                type: 4,
                file_item: {
                  file_name: "report.pdf",
                  len: String(pdf.byteLength),
                  media: { full_url: "https://cdn.example/report.pdf", aes_key: hexKeyBase64(key) },
                },
              },
              {
                type: 5,
                video_item: {
                  video_size: encryptEcb(mp4, key).byteLength,
                  media: { full_url: "https://cdn.example/clip.mp4", aes_key: Buffer.from(key).toString("base64") },
                },
              },
              {
                type: 4,
                file_item: {
                  file_name: "huge.bin",
                  len: "999999999",
                  media: { full_url: "https://cdn.example/huge.bin", aes_key: hexKeyBase64(key) },
                },
              },
            ],
          }),
        ],
      }),
      cdn: (url) => {
        downloads += 1;
        if (url.pathname.endsWith("report.pdf")) return encryptEcb(pdf, key);
        if (url.pathname.endsWith("clip.mp4")) return encryptEcb(mp4, key);
        throw new Error("unexpected cdn fetch");
      },
    });
    const app = makeApp(fetchImpl, { allowFrom: ["owner@im.wechat"], sendTyping: false, mediaMaxBytes: 64 * 1024 });
    await seed(app);
    await runPollStep(app);
    const event = webhook([], fetchImpl);
    expect(event.type).toBe("mixed");
    expect(event.text).toBe("notes");
    expect(downloads).toBe(2);
    const file = event.media.find((item) => item.file_name === "report.pdf");
    const video = event.media.find((item) => item.kind === "video");
    const huge = event.media.find((item) => item.file_name === "huge.bin");
    expect(file).toMatchObject({ mime_type: "application/pdf", size: pdf.byteLength, error: null });
    expect(video).toMatchObject({ mime_type: "video/mp4", file_name: "video.mp4", size: mp4.byteLength, error: null });
    expect(huge).toMatchObject({ error: "too_large", url: null });
    const saved = await authedGet(app, file?.url ?? "");
    expect(Buffer.from(await saved.arrayBuffer()).equals(Buffer.from(pdf))).toBe(true);
    expect(saved.headers.get("content-disposition")).toContain("attachment");
  });

  it("puts a voice transcript in text and stores wav or raw silk", async () => {
    const key = Uint8Array.from({ length: 16 }, (_, index) => 40 + index);
    const pcm = tone(2400);
    const silk = (await import("silk-wasm")).encode(pcm, 24_000);
    const encoded = (await silk).data;
    const cipher = encryptEcb(encoded, key);
    const { fetchImpl } = scriptedFetch({
      updates: () => ({
        ret: 0,
        get_updates_buf: "c-voice",
        msgs: [
          message({
            message_id: "11",
            item_list: [
              {
                type: 3,
                voice_item: {
                  text: "transcribed hello",
                  encode_type: 6,
                  playtime: 100,
                  sample_rate: 24_000,
                  media: { full_url: "https://cdn.example/voice", aes_key: hexKeyBase64(key) },
                },
              },
            ],
          }),
        ],
      }),
      cdn: () => cipher,
    });
    const rawApp = makeApp(fetchImpl, { allowFrom: ["owner@im.wechat"], sendTyping: false });
    await seed(rawApp);
    await runPollStep(rawApp);
    const rawEvent = lastWebhook(fetchImpl);
    expect(rawEvent.text).toBe("transcribed hello");
    expect(rawEvent.media[0]).toMatchObject({
      kind: "voice",
      transcript: "transcribed hello",
      mime_type: "audio/silk",
      file_name: "voice.silk",
      duration_ms: 100,
      error: null,
    });
    const rawBody = Buffer.from(await (await authedGet(rawApp, rawEvent.media[0]?.url ?? "")).arrayBuffer());
    expect(rawBody.equals(Buffer.from(encoded))).toBe(true);

    const wavApp = makeApp(fetchImpl, { allowFrom: ["owner@im.wechat"], sendTyping: false });
    wavApp.decodeSilk = decodeSilkPcm;
    await seed(wavApp);
    await runPollStep(wavApp);
    const wavEvent = lastWebhook(fetchImpl);
    expect(wavEvent.media[0]).toMatchObject({ mime_type: "audio/wav", file_name: "voice.wav", error: null });
    const wavBody = Buffer.from(await (await authedGet(wavApp, wavEvent.media[0]?.url ?? "")).arrayBuffer());
    expect(wavBody.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wavBody.byteLength).toBeGreaterThan(44);
  });

  it("does not fetch a private full_url", async () => {
    const { fetchImpl, urls } = scriptedFetch({
      updates: () => ({
        ret: 0,
        get_updates_buf: "c-ssrf",
        msgs: [
          message({
            message_id: "12",
            item_list: [
              { type: 2, image_item: { media: { full_url: "http://127.0.0.1/secret" } } },
              { type: 2, image_item: { media: { full_url: "https://169.254.169.254/latest" } } },
            ],
          }),
        ],
      }),
      cdn: () => new Uint8Array(),
    });
    const app = makeApp(fetchImpl, { allowFrom: ["owner@im.wechat"], sendTyping: false });
    await seed(app);
    await runPollStep(app);
    const event = lastWebhook(fetchImpl);
    expect(urls.every((url) => url.includes("/ilink/bot/getupdates") || url.includes("routine.example"))).toBe(true);
    expect(event.media.map((item) => item.error)).toEqual(["download_failed", "download_failed"]);
  });

  it("wraps pcm in a wav container", () => {
    const pcm = tone(8);
    const wav = pcmToWav(pcm, 16_000);
    expect(Buffer.from(wav.subarray(0, 4)).toString("ascii")).toBe("RIFF");
    expect(wav.byteLength).toBe(44 + pcm.byteLength);
  });
});

describe("media budget", () => {
  it("evicts expired rows first and then the oldest live row", () => {
    const records = [
      row("a", 10, 50, 1),
      row("b", 10, 500, 2),
      row("c", 10, 500, 3),
    ];
    expect(idsToEvict(records, 100, 15, 25).sort()).toEqual(["a", "b"]);
  });

  it("splits chunks on the given boundary", () => {
    const bytes = Uint8Array.from([1, 2, 3, 4, 5]);
    const chunks = splitChunks(bytes, 2);
    expect(chunks.map((chunk) => [...chunk])).toEqual([[1, 2], [3, 4], [5]]);
  });
});

describe("file media store", () => {
  it("writes mode 0600 files and drops them after expiry", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "grokbot-weixin-media-"));
    dirs.push(dir);
    const store = new FileMediaStore(dir);
    const saved = await store.put({
      bytes: Uint8Array.from([1, 2, 3, 4]),
      mimeType: "image/png",
      fileName: "image.png",
      expiresAtMs: 100,
      createdAtMs: 1,
      maxTotalBytes: 100,
    });
    const directory = await stat(dir);
    const file = await stat(path.join(dir, `${saved.id}.bin`));
    expect(directory.mode & 0o777).toBe(0o700);
    expect(file.mode & 0o777).toBe(0o600);
    expect((await store.get(saved.id))?.bytes).toEqual(Uint8Array.from([1, 2, 3, 4]));
    await store.deleteExpired(100);
    expect(await store.get(saved.id)).toBeNull();
  });
});

/** AES-128-ECB PKCS#7, the same transform the CDN applies. */
function encryptEcb(plain: Uint8Array, key: Uint8Array): Uint8Array {
  const cipher = createCipheriv("aes-128-ecb", Buffer.from(key), null);
  return new Uint8Array(Buffer.concat([cipher.update(Buffer.from(plain)), cipher.final()]));
}

/** base64 of the 32-character hex key, which is how file and voice keys arrive. */
function hexKeyBase64(key: Uint8Array): string {
  return Buffer.from(Buffer.from(key).toString("hex"), "utf8").toString("base64");
}

/** JPEG magic plus filler, long enough to cross a block boundary. */
function jpegBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  bytes[size - 2] = 0xff;
  bytes[size - 1] = 0xd9;
  return bytes;
}

/** Mono s16le tone. */
function tone(samples: number): Uint8Array {
  const pcm = new Int16Array(samples);
  for (let i = 0; i < samples; i += 1) pcm[i] = Math.round(Math.sin(i / 8) * 8000);
  return new Uint8Array(pcm.buffer.slice(0));
}

/** Minimal inbound message. */
function message(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    message_id: "1",
    from_user_id: "owner@im.wechat",
    create_time_ms: NOW,
    message_type: 1,
    message_state: 2,
    context_token: "ctx-1",
    ...overrides,
  };
}

/** Record a fetch and answer iLink, the webhook, or the CDN. */
function scriptedFetch(options: {
  updates: () => unknown;
  cdn: (url: URL) => Uint8Array;
}): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const bodies: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    urls.push(url.toString());
    if (init?.signal?.aborted) throw new Error("aborted");
    if (url.hostname === "routine.example") {
      bodies.push(typeof init?.body === "string" ? init.body : "");
      (fetchImpl as FetchWithBodies).bodies = bodies;
      return new Response("", { status: 200 });
    }
    if (url.pathname === "/ilink/bot/msg/notifystart") return new Response(JSON.stringify({ ret: 0 }), { status: 200 });
    if (url.pathname === "/ilink/bot/getupdates") {
      return new Response(JSON.stringify(options.updates()), { status: 200 });
    }
    if (url.hostname === "cdn.example" || url.pathname.endsWith("/download")) {
      const bytes = options.cdn(url);
      return new Response(bytes, { status: 200 });
    }
    return new Response("no", { status: 404 });
  };
  return { fetchImpl, urls };
}

interface FetchWithBodies {
  bodies?: string[];
}

/** Last webhook JSON captured by scriptedFetch. */
function lastWebhook(fetchImpl: typeof fetch): WebhookEvent {
  const bodies = (fetchImpl as FetchWithBodies).bodies ?? [];
  return JSON.parse(bodies[bodies.length - 1] ?? "{}") as WebhookEvent;
}

/** Compatibility wrapper for the image test, which already has the urls list. */
function webhook(_urls: string[], fetchImpl: typeof fetch): WebhookEvent {
  return lastWebhook(fetchImpl);
}

interface WebhookMedia {
  kind: string;
  file_name: string | null;
  transcript: string | null;
  mime_type: string | null;
  size: number | null;
  url: string | null;
  expires_at_ms: number | null;
  duration_ms: number | null;
  error: string | null;
}

interface WebhookEvent {
  type: string;
  text: string;
  media: WebhookMedia[];
}

/** Authenticated media GET. */
function authedGet(app: BridgeApp, mediaUrl: string): Promise<Response> {
  const id = mediaUrl.split("/").pop() ?? "";
  return handleBridgeRequest(
    new Request(`https://bridge.example/media/${id}`, { headers: { Authorization: "Bearer test-token" } }),
    app,
  );
}

/** Seed the bot session the poll requires. */
async function seed(app: BridgeApp): Promise<void> {
  await writeSession(app.storage, { botToken: "bot-secret", accountId: "bot@im.wechat", savedAt: 1 });
  await app.storage.set(KEYS.notifyStarted, "bot@im.wechat");
}

/** One budget row. */
function row(id: string, size: number, expiresAtMs: number, createdAtMs: number) {
  return { id, mimeType: "image/png", fileName: "a.png", size, expiresAtMs, createdAtMs };
}
