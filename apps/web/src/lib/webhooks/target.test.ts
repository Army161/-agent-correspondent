import { describe, expect, it } from "vitest";

import { checkWebhookTarget, isPrivateAddress, type TargetPolicy } from "./target";

describe("isPrivateAddress", () => {
  it.each([
    "127.0.0.1",
    "127.255.255.254",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fe80::1",
    "fe80::1%eth0",
    "fd00::1",
    "fc12:3456::1",
    "ff02::1",
    "::ffff:127.0.0.1", // IPv4-mapped loopback
    "::ffff:7f00:1", // same, hex form
    "::ffff:169.254.169.254",
    "64:ff9b::a9fe:a9fe", // NAT64 of 169.254.169.254
    "not-an-ip",
  ])("ATTACK: refuses %s", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(["93.184.216.34", "8.8.8.8", "172.32.0.1", "172.15.255.255", "2606:4700:4700::1111", "::ffff:8.8.8.8"])(
    "allows public %s",
    (address) => {
      expect(isPrivateAddress(address)).toBe(false);
    },
  );
});

const dev: TargetPolicy = { production: false, allowPrivate: false, resolve: async () => ["93.184.216.34"] };
const prod: TargetPolicy = { ...dev, production: true };

describe("checkWebhookTarget", () => {
  it("accepts a public https host", async () => {
    expect(await checkWebhookTarget("https://hooks.example.com/x", prod)).toEqual({ ok: true });
  });

  it("requires https in production", async () => {
    expect((await checkWebhookTarget("http://hooks.example.com/x", prod)).ok).toBe(false);
    expect((await checkWebhookTarget("http://hooks.example.com/x", dev)).ok).toBe(true);
  });

  it("refuses non-http schemes and credentials in the URL", async () => {
    expect((await checkWebhookTarget("file:///etc/passwd", dev)).ok).toBe(false);
    expect((await checkWebhookTarget("gopher://example.com", dev)).ok).toBe(false);
    expect((await checkWebhookTarget("https://user:pass@hooks.example.com", dev)).ok).toBe(false);
  });

  it("ATTACK: refuses IP literals in private ranges, including bracketed IPv6", async () => {
    for (const url of [
      "http://127.0.0.1:5432/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
    ]) {
      expect((await checkWebhookTarget(url, dev)).ok, url).toBe(false);
    }
  });

  it("ATTACK: refuses a hostname that resolves to a private address", async () => {
    const policy = { ...dev, resolve: async () => ["10.0.0.5"] };
    const result = await checkWebhookTarget("https://internal.example.com/", policy);
    expect(result).toMatchObject({ ok: false });
  });

  it("ATTACK: refuses when any one of several resolved addresses is private", async () => {
    const policy = { ...dev, resolve: async () => ["93.184.216.34", "127.0.0.1"] };
    expect((await checkWebhookTarget("https://mixed.example.com/", policy)).ok).toBe(false);
  });

  it("refuses a host that does not resolve", async () => {
    const policy = {
      ...dev,
      resolve: async (): Promise<string[]> => {
        throw new Error("ENOTFOUND");
      },
    };
    expect((await checkWebhookTarget("https://nowhere.invalid/", policy)).ok).toBe(false);
  });

  it("the development opt-in allows loopback receivers", async () => {
    expect((await checkWebhookTarget("http://127.0.0.1:9000/hook", { ...dev, allowPrivate: true })).ok).toBe(true);
  });
});

describe("policyFromEnv", () => {
  it("ATTACK: ignores the private-target opt-in when ACOR_ENV=production", async () => {
    const { policyFromEnv } = await import("./target");
    const saved = { acor: process.env.ACOR_ENV, allow: process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS };
    try {
      process.env.ACOR_ENV = "production";
      process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS = "true";
      expect(policyFromEnv()).toEqual({ production: true, allowPrivate: false });
    } finally {
      if (saved.acor === undefined) delete process.env.ACOR_ENV;
      else process.env.ACOR_ENV = saved.acor;
      if (saved.allow === undefined) delete process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS;
      else process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS = saved.allow;
    }
  });
});
