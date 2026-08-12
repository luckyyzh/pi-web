import type { NextConfig } from "next";
import fs from "fs";
import { readFileSync } from "fs";
import { join } from "path";

// Guard (always on): never enumerate the user profile dir itself. When the
// project lives on a different drive than USERPROFILE (e.g. project on D:
// while the profile is on C:), Next's nft tracer mis-classifies the user dir
// as project-internal (Windows path.relative returns an absolute path across
// drives) and globs it, hitting EPERM on legacy junction dirs (Application
// Data, Cookies, Local Settings, PrintHood, ...). Returning an empty listing
// for the profile root stops the glob before it descends into those junctions.
// Projects inside the profile dir are not affected (they aren't the root).
const USER_PROFILE = (process.env.USERPROFILE || "").toLowerCase().replace(/\\/g, "/");
const isUserDir = (p: unknown): p is string =>
  typeof p === "string" &&
  !!USER_PROFILE &&
  p.toLowerCase().replace(/\\/g, "/") === USER_PROFILE;
const _guardReaddir = fs.readdir.bind(fs);
// @ts-ignore monkeypatch for guard (support both callback and promise callers)
fs.readdir = (p: unknown, ...args: any[]) => {
  if (isUserDir(p)) {
    const last = args[args.length - 1];
    if (typeof last === "function") {
      last(null, []);
      return;
    }
    return Promise.resolve([]);
  }
  return (_guardReaddir as any)(p, ...args);
};
const _guardReaddirSync = fs.readdirSync.bind(fs);
// @ts-ignore monkeypatch for guard
fs.readdirSync = (p: unknown, ...a: any[]) =>
  isUserDir(p) ? [] : (_guardReaddirSync as any)(p, ...a);
const _guardScandir = (fs as any).scandir?.bind(fs);
if (_guardScandir) {
  // @ts-ignore monkeypatch for guard
  fs.scandir = (p: unknown, ...a: any[]) =>
    isUserDir(p) ? (async function* () {})() : _guardScandir(p, ...a);
}

const { version } = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8")) as { version: string };
let piVersion = "unknown";
try {
  const piPkgPath = join(__dirname, "node_modules/@earendil-works/pi-coding-agent/package.json");
  piVersion = (JSON.parse(readFileSync(piPkgPath, "utf8")) as { version: string }).version;
} catch { /* package not found, use default */ }

const nextConfig: NextConfig = {
  // Limit build workers: on low-memory machines (small pagefile) the default
  // per-CPU worker count makes Next's page-data workers crash with
  // "OS can't spawn worker thread" (os error 1450/1455). Override with
  // NEXT_BUILD_CPUS if needed.
  experimental: {
    cpus: process.env.NEXT_BUILD_CPUS ? Number(process.env.NEXT_BUILD_CPUS) : 2,
  },
  outputFileTracingRoot: __dirname,
  serverExternalPackages: [
    "undici",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-tui",
  ],
  allowedDevOrigins: ['192.168.*.*'],
  async headers() {
    return [
      {
        source: "/",
        headers: [
          { key: "Cache-Control", value: "private, no-cache, max-age=0, must-revalidate" },
        ],
      },
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      {
        source: "/manifest.webmanifest",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
        ],
      },
    ];
  },
  env: {
    NEXT_PUBLIC_APP_VERSION: version,
    NEXT_PUBLIC_PI_VERSION: piVersion,
  },
};

export default nextConfig;
