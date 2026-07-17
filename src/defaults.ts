import os from "node:os";
import path from "node:path";

export const APP_NAME = "AIMessenger";

export function getDefaultDataDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  homeDir = os.homedir(),
): string {
  if (platform === "darwin") {
    return path.join(homeDir, "Library", "Application Support", APP_NAME);
  }
  const stateRoot =
    env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME)
      ? env.XDG_STATE_HOME
      : path.join(homeDir, ".local", "state");
  return path.join(stateRoot, APP_NAME);
}

export function getDefaultEnvFile(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  homeDir = os.homedir(),
): string {
  return path.join(getDefaultDataDir(platform, env, homeDir), "env");
}
