import { describe, expect, it } from "vitest";
import { getDefaultDataDir, getDefaultEnvFile } from "../src/defaults.js";

describe("defaults", () => {
  it("uses Application Support on macOS", () => {
    const dataDir = getDefaultDataDir("darwin", {}, "/Users/test");
    expect(dataDir).toBe("/Users/test/Library/Application Support/AIMessenger");
    expect(getDefaultEnvFile("darwin", {}, "/Users/test")).toBe(`${dataDir}/env`);
  });

  it("uses XDG state on Linux", () => {
    const env = { XDG_STATE_HOME: "/tmp/state-home" };
    const dataDir = getDefaultDataDir("linux", env, "/home/test");
    expect(dataDir).toBe("/tmp/state-home/AIMessenger");
    expect(getDefaultEnvFile("linux", env, "/home/test")).toBe(`${dataDir}/env`);
  });

  it("falls back to .local/state on Linux", () => {
    const dataDir = getDefaultDataDir("linux", {}, "/home/test");
    expect(dataDir).toBe("/home/test/.local/state/AIMessenger");
  });
});
