import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export type UpdateInfo = {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  oneClickAvailable: boolean;
  releaseUrl: string | null;
  checkedAt: string | null;
};

const RELEASES_LATEST_URL = "https://api.github.com/repos/juinwei7/Pixel-Crew/releases/latest";
const RELEASES_PAGE_URL = "https://github.com/juinwei7/Pixel-Crew/releases/latest";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** scripts/package.mjs rewrites the shipped package.json's name to the scoped
 *  npm-publish name, so the packaged release layout never has "pixel-crew". */
const ROOT_MANIFEST_NAMES = new Set(["pixel-crew", "@juinwei7/pixel-crew"]);
export function isRootManifestName(name: string | undefined): boolean {
  return name !== undefined && ROOT_MANIFEST_NAMES.has(name);
}

/** The root package.json is the single source of truth for the version.
 *  `../../package.json` resolves there both in dev (server/src) and in the
 *  packaged release layout (server/dist). */
export function readCurrentVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, "..", "..", "package.json"), join(here, "..", "..", "..", "package.json")]) {
    try {
      const manifest = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string; version?: string };
      if (isRootManifestName(manifest.name) && typeof manifest.version === "string") return manifest.version;
    } catch {
      // keep walking
    }
  }
  return "0.0.0";
}

/** Loose semver "x.y.z" parse; returns null for anything else (e.g. drafts,
 *  pre-releases we don't publish). */
export function parseSemver(value: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isNewerVersion(current: string, candidate: string): boolean {
  const a = parseSemver(current);
  const b = parseSemver(candidate);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (b[i] !== a[i]) return b[i] > a[i];
  }
  return false;
}

export class UpdateChecker {
  private latestVersion: string | null = null;
  private releaseUrl: string | null = null;
  private checkedAt: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly currentVersion: string,
    private readonly onUpdate?: (info: UpdateInfo) => void,
    private readonly canApplyOneClickUpdate: () => boolean = () => false,
  ) {}

  getInfo(): UpdateInfo {
    return {
      currentVersion: this.currentVersion,
      latestVersion: this.latestVersion,
      updateAvailable: this.latestVersion !== null && isNewerVersion(this.currentVersion, this.latestVersion),
      oneClickAvailable: this.canApplyOneClickUpdate(),
      releaseUrl: this.releaseUrl ?? RELEASES_PAGE_URL,
      checkedAt: this.checkedAt,
    };
  }

  start(): void {
    // First check shortly after boot so startup never waits on GitHub, then
    // once a day. Failures (offline, rate limit, no releases yet) stay silent.
    setTimeout(() => void this.check(), 5_000).unref();
    this.timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async check(): Promise<void> {
    try {
      const response = await fetch(RELEASES_LATEST_URL, {
        headers: { "User-Agent": "pixel-crew-update-check", Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return;
      const body = await response.json() as { tag_name?: string; html_url?: string; draft?: boolean; prerelease?: boolean };
      if (body.draft || body.prerelease || typeof body.tag_name !== "string" || !parseSemver(body.tag_name)) return;
      const previousLatestVersion = this.latestVersion;
      const previousReleaseUrl = this.releaseUrl;
      this.latestVersion = body.tag_name.replace(/^v/, "");
      this.releaseUrl = typeof body.html_url === "string" ? body.html_url : null;
      this.checkedAt = new Date().toISOString();
      // Existing clients also need a refresh when GitHub publishes another
      // release after an update was already available (for example 1.1 → 1.2).
      if (this.latestVersion !== previousLatestVersion || this.releaseUrl !== previousReleaseUrl) {
        this.onUpdate?.(this.getInfo());
      }
    } catch {
      // Offline or GitHub unavailable — try again next interval.
    }
  }
}
