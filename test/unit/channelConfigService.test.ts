/**
 * ChannelConfigService 单元测试
 *
 * 验证：
 *   - AES-256-GCM 加解密 roundtrip（与 sync-channels.mjs 同格式 iv.tag.data）
 *   - 从 Turso（本地 file: 临时库）拉取加密配置并解密
 *   - CHANNELS_JSON 兜底与未加载时的空快照
 * 不依赖线上 Turso（无网络、无凭据）。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createClient } from "@libsql/client";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChannelConfigService,
  encryptChannelConfig,
  decryptChannelConfig,
} from "../../server/core/services/channelConfigService";

const KEY = "a".repeat(64); // 32 字节
const SAMPLE = {
  version: 1,
  priorityChannels: ["pri1", "pri2"],
  defaultChannels: ["ch1", "ch2", "ch3"],
};

describe("channelConfig 加解密", () => {
  it("AES-256-GCM roundtrip 还原明文", () => {
    const plain = JSON.stringify(SAMPLE);
    const encrypted = encryptChannelConfig(plain, KEY);
    expect(encrypted.split(".").length).toBe(3);
    expect(decryptChannelConfig(encrypted, KEY)).toBe(plain);
  });

  it("错误密钥解密失败（GCM 认证失败）", () => {
    const encrypted = encryptChannelConfig(JSON.stringify(SAMPLE), KEY);
    expect(() => decryptChannelConfig(encrypted, "b".repeat(64))).toThrow();
  });

  it("非法密钥长度抛错", () => {
    expect(() => encryptChannelConfig("x", "not-hex")).toThrow();
    expect(() => decryptChannelConfig("a.b.c", "not-hex")).toThrow();
  });

  it("非法密文格式抛错", () => {
    expect(() => decryptChannelConfig("bad-format", KEY)).toThrow();
  });
});

describe("ChannelConfigService", () => {
  let dbPath: string;
  let client: ReturnType<typeof createClient>;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `channel-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    client = createClient({ url: `file:${dbPath}` });
    await client.execute(
      `CREATE TABLE channel_config (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version INTEGER NOT NULL,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`
    );
  });

  afterEach(() => {
    client.close();
    if (existsSync(dbPath)) unlinkSync(dbPath);
  });

  it("从 Turso 拉取加密配置并解密（优先级/默认频道）", async () => {
    const encrypted = encryptChannelConfig(JSON.stringify(SAMPLE), KEY);
    await client.execute(
      "INSERT INTO channel_config (version, payload, updated_at) VALUES (?, ?, ?)",
      [1, encrypted, Date.now()]
    );

    const service = new ChannelConfigService({
      tursoUrl: `file:${dbPath}`,
      channelKey: KEY,
    });
    await service.ensureLoaded();
    const snap = service.getSnapshot();
    expect(snap.version).toBe(1);
    expect(snap.priorityChannels).toEqual(["pri1", "pri2"]);
    expect(snap.defaultChannels).toEqual(["ch1", "ch2", "ch3"]);
  });

  it("多版本时取最新版", async () => {
    const insert = async (version: number, channels: string[]) => {
      const encrypted = encryptChannelConfig(
        JSON.stringify({ version, priorityChannels: [], defaultChannels: channels }),
        KEY
      );
      await client.execute(
        "INSERT INTO channel_config (version, payload, updated_at) VALUES (?, ?, ?)",
        [version, encrypted, Date.now()]
      );
    };
    await insert(1, ["old"]);
    await insert(2, ["new1", "new2"]);

    const service = new ChannelConfigService({
      tursoUrl: `file:${dbPath}`,
      channelKey: KEY,
    });
    await service.ensureLoaded();
    expect(service.getSnapshot().version).toBe(2);
    expect(service.getSnapshot().defaultChannels).toEqual(["new1", "new2"]);
  });

  it("未加载且无兜底时返回空快照", () => {
    const service = new ChannelConfigService({});
    expect(service.getSnapshot()).toEqual({
      version: 0,
      priorityChannels: [],
      defaultChannels: [],
    });
  });

  it("CHANNELS_JSON 兜底（无 Turso）", async () => {
    const service = new ChannelConfigService({
      envJson: JSON.stringify({ ...SAMPLE, version: 7 }),
    });
    await service.ensureLoaded();
    expect(service.getSnapshot().version).toBe(7);
    expect(service.getSnapshot().defaultChannels).toEqual(SAMPLE.defaultChannels);
  });

  it("Turso 无配置时降级到 CHANNELS_JSON 兜底", async () => {
    const service = new ChannelConfigService({
      tursoUrl: `file:${dbPath}`,
      channelKey: KEY,
      envJson: JSON.stringify({ ...SAMPLE, version: 3 }),
    });
    await service.ensureLoaded();
    expect(service.getSnapshot().version).toBe(3);
  });
});
