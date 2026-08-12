import type { NextConfig } from "next";
import fs from "fs";
import { readFileSync } from "fs";
import { join } from "path";

// Diagnostic hook (disabled by default): set NEXT_FS_DIAG=1 to print the caller
// stack whenever fs tries to read a Windows user-dir junction like
// "Application Data". Helps locate who scans the user dir during `next build`
// when it fails with EPERM on machines whose junctions are restricted.
if (process.env.NEXT_FS_DIAG === "1") {
  const HIT = /Application Data|Local Settings|Cookies|My Documents|NetHood|SendTo|Recent|Templates|Favorites|Desktop|Start Menu|AppData/i;
  console.error(
    "[FS-DIAG] env USERPROFILE=" + (process.env.USERPROFILE ?? "") +
    " HOME=" + (process.env.HOME ?? "") +
    " APPDATA=" + (process.env.APPDATA ?? "") +
    " LOCALAPPDATA=" + (process.env.LOCALAPPDATA ?? "") +
    " cwd=" + process.cwd(),
  );
  const origReaddir = fs.readdir.bind(fs);
  const origReaddirSync = fs.readdirSync.bind(fs);
  // @ts-ignore monkeypatch for diagnostics
  fs.readdir = (p: any, ...a: any[]) => {
    if (typeof p === "string" && HIT.test(p)) console.error("[FS-DIAG] readdir:", p, "\n" + new Error("stack").stack);
    return (origReaddir as any).apply(fs, [p, ...a]);
  };
  // @ts-ignore monkeypatch for diagnostics
  fs.readdirSync = (p: any, ...a: any[]) => {
    if (typeof p === "string" && HIT.test(p)) console.error("[FS-DIAG] readdirSync:", p, "\n" + new Error("stack").stack);
    return (origReaddirSync as any).apply(fs, [p, ...a]);
  };
  const origScandir = (fs as any).scandir?.bind(fs);
  if (origScandir) {
    // @ts-ignore monkeypatch for diagnostics
    fs.scandir = (p: any, ...a: any[]) => {
      if (typeof p === "string" && HIT.test(p)) console.error("[FS-DIAG] scandir:", p, "\n" + new Error("stack").stack);
      return (origScandir as any).apply(fs, [p, ...a]);
    };
  }
}

// Guard (always on): never enumerate Windows legacy user-dir junction dirs.
// When the project lives on a different drive than the user profile (e.g.
// project on D: while USERPROFILE is on C:), nft's glob walks the user dir and
// hits EPERM on these junctions (fs.readdir -> scandir), breaking `next build`.
// Returning an empty listing is safe: the junctions contain no build inputs.
const USER_DIR_JUNCTION = /[\\/](?:Application Data|Local Settings|Cookies|My Documents|NetHood|SendTo|Recent|Templates|Favorites|Start Menu|Desktop|My Music|My Pictures|My Videos)(?:[\\/]|$)/i;
const isUserDirJunction = (p: unknown): p is string =>
  typeof p === "string" && USER_DIR_JUNCTION.test(p);
const _guardReaddir = fs.readdir.bind(fs);
// @ts-ignore monkeypatch for guard
fs.readdir = (p: unknown, ...a: any[]) =>
  isUserDirJunction(p) ? Promise.resolve([]) : (_guardReaddir as any)(p, ...a);
const _guardReaddirSync = fs.readdirSync.bind(fs);
// @ts-ignore monkeypatch for guard
fs.readdirSync = (p: unknown, ...a: any[]) =>
  isUserDirJunction(p) ? [] : (_guardReaddirSync as any)(p, ...a);
const _guardScandir = (fs as any).scandir?.bind(fs);
if (_guardScandir) {
  // @ts-ignore monkeypatch for guard
  fs.scandir = (p: unknown, ...a: any[]) =>
    isUserDirJunction(p) ? (async function* () {})() : _guardScandir(p, ...a);
}

const { version } = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8")) as { version: string };
let piVersion = "unknown";
try {
  const piPkgPath = join(__dirname, "node_modules/@earendil-works/pi-coding-agent/package.json");
  piVersion = (JSON.parse(readFileSync(piPkgPath, "utf8")) as { version: string }).version;
} catch { /* package not found, use default */ }

const nextConfig: NextConfig = {
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
