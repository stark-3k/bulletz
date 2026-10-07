/**
 * Check a built .app before it is handed to anyone.
 *
 * The release is built for both macOS architectures on one runner, which is
 * only safe because a clean `npm ci` never compiles node-pty — it installs
 * prebuilds, and node-pty picks the right one at runtime. If that ever stops
 * being true, `build/Release/pty.node` appears in the bundle carrying the
 * BUILD host's architecture, and the cross-built app gets a terminal that
 * fails on launch in someone else's hands. That is the case this catches.
 *
 *   node scripts/verify-package.mjs <release-dir>
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? "release";
if (!existsSync(dir)) {
  console.error(`verify-package: no such directory: ${dir}`);
  process.exit(1);
}

const problems = [];
const note = (s) => console.log(`  ${s}`);

/**
 * Every built application tree under the release directory.
 *
 * macOS gives a .app bundle per architecture; Linux gives linux-unpacked/.
 * The AppImage itself is a squashfs image, so the unpacked tree beside it is
 * what can actually be inspected — and it is the same bytes.
 */
function findApps(root) {
  const out = [];
  for (const name of readdirSync(root)) {
    const p = join(root, name);
    if (!statSync(p).isDirectory()) continue;
    if (name.endsWith(".app")) {
      out.push({ path: p, kind: "mac" });
      continue;
    }
    if (name.startsWith("linux-unpacked")) {
      out.push({ path: p, kind: "linux" });
      continue;
    }
    // electron-builder writes mac/ for x64 and mac-arm64/ for arm64.
    for (const inner of readdirSync(p)) {
      if (inner.endsWith(".app")) out.push({ path: join(p, inner), kind: "mac" });
    }
  }
  return out;
}

const archOf = (file) => {
  const out = execFileSync("file", ["-b", file]).toString();
  if (out.includes("arm64") || out.includes("aarch64")) return "arm64";
  if (out.includes("x86_64") || out.includes("x86-64")) return "x64";
  return "unknown";
};

const walk = function* (d) {
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    const s = statSync(p);
    if (s.isDirectory()) yield* walk(p);
    else yield p;
  }
};

const apps = findApps(dir);
if (apps.length === 0) {
  console.error(`verify-package: no .app found under ${dir}`);
  process.exit(1);
}

for (const { path: app, kind } of apps) {
  const expected =
    kind === "linux"
      ? "x64"
      : app.includes("mac-arm64")
        ? "arm64"
        : app.includes("/mac/")
          ? "x64"
          : null;
  note(`\n${app}  [${kind}]`);

  // 1. The executable is the architecture its folder claims.
  const exe =
    kind === "mac"
      ? join(app, "Contents", "MacOS", "Bulletz")
      : [join(app, "bulletz"), join(app, "Bulletz")].find((p) => existsSync(p));
  if (!exe || !existsSync(exe)) {
    problems.push(`${app}: no executable found`);
    continue;
  }
  const arch = archOf(exe);
  note(`  arch            ${arch}${expected ? ` (expected ${expected})` : ""}`);
  if (expected && arch !== expected) {
    problems.push(`${app}: executable is ${arch}, expected ${expected}`);
  }

  const files = [...walk(app)];

  // 2. node-pty has to be loadable. On macOS it comes from prebuilds and must
  //    never be a compiled binary carrying the build host's architecture. On
  //    Linux there are no prebuilds at all, so a compiled one is required —
  //    its absence means the terminal cannot start.
  const compiled = files.filter((f) => /node-pty\/build\/Release\/.*\.node$/.test(f));
  if (kind === "linux") {
    if (compiled.length === 0) {
      problems.push(
        `${app}: no compiled node-pty — node-pty ships no Linux prebuilds, so it must be ` +
          `rebuilt against Electron before packaging or the terminal will not start`,
      );
      note(`  node-pty        MISSING`);
    } else {
      const archs = [...new Set(compiled.map(archOf))];
      note(`  node-pty        compiled (${archs.join(", ")})`);
      if (!archs.includes(arch)) {
        problems.push(`${app}: node-pty is ${archs.join(", ")} inside a ${arch} app`);
      }
    }
  } else if (compiled.length) {
    const archs = [...new Set(compiled.map(archOf))];
    note(`  node-pty        COMPILED (${archs.join(", ")})`);
    if (!archs.every((a) => a === arch)) {
      problems.push(
        `${app}: ships a compiled node-pty for ${archs.join(", ")} inside a ${arch} app — ` +
          `cross-building is no longer safe; build each architecture on its own runner`,
      );
    }
  } else {
    const prebuilt = files.filter((f) => new RegExp(`prebuilds/darwin-${arch}/.*\\.node$`).test(f));
    note(`  node-pty        prebuilt, ${prebuilt.length} matching darwin-${arch}`);
    if (prebuilt.length === 0) {
      problems.push(`${app}: no darwin-${arch} node-pty prebuild — the terminal will not start`);
    }
  }

  // 3. The renderer ships with the app.
  const index =
    kind === "mac"
      ? join(app, "Contents", "Resources", "web", "index.html")
      : join(app, "resources", "web", "index.html");
  note(`  renderer        ${existsSync(index) ? "present" : "MISSING"}`);
  if (!existsSync(index)) problems.push(`${app}: the renderer is missing at ${index}`);

  // 4. Nothing in the shipped bundle is a credential. check-no-secrets guards
  //    the web build; this guards what actually ends up in the artifact.
  const cred = /blz_[stir]_[A-Za-z0-9_-]{20,}/;
  const leaked = [];
  for (const f of files) {
    if (!/\.(js|css|html|json|map|txt)$/.test(f)) continue;
    try {
      if (cred.test(readFileSync(f, "utf8"))) leaked.push(f);
    } catch {
      /* unreadable is not a leak */
    }
  }
  note(`  credentials     ${leaked.length ? `LEAKED in ${leaked.length} file(s)` : "none"}`);
  for (const f of leaked) problems.push(`${app}: credential found in ${f}`);
}

console.log("");
if (problems.length) {
  console.error("verify-package: FAILED\n");
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`verify-package: ${apps.length} app(s) OK`);
