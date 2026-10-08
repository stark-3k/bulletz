/**
 * Restore the execute bit on node-pty's spawn-helper.
 *
 * node-pty does not fork a shell directly — it execs a small helper binary
 * that sets up the controlling terminal first. The npm tarball ships that
 * helper executable, but the bit does not survive the trip into the app
 * bundle, and electron-builder does not restore it.
 *
 * The failure is quiet and misleading: the module loads, `spawn()` returns an
 * object, and then nothing ever happens. The terminal sits on "starting…"
 * forever with no error anywhere, because the exec failed inside the helper
 * rather than in anything that reports.
 *
 * electron-builder calls this after it lays out each platform's files and
 * before it seals them into a dmg or zip.
 */
const { chmodSync, existsSync, readdirSync, statSync } = require("node:fs");
const { join } = require("node:path");

/** Everything named spawn-helper anywhere under a directory. */
function find(dir, name, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) find(p, name, out);
    else if (e.name === name) out.push(p);
  }
  return out;
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName === "win32") return;

  const root = context.appOutDir;
  const helpers = find(root, "spawn-helper");

  if (helpers.length === 0) {
    // Linux compiles node-pty from source and has no spawn-helper, so this is
    // only a problem on macOS, where the prebuild supplies one.
    if (context.electronPlatformName === "darwin") {
      throw new Error(
        "after-pack: no spawn-helper found in the macOS build — node-pty cannot " +
          "fork a shell without it, and the terminal would hang on 'starting…'",
      );
    }
    return;
  }

  for (const h of helpers) {
    chmodSync(h, 0o755);
    const mode = statSync(h).mode & 0o777;
    if ((mode & 0o111) === 0) {
      throw new Error(`after-pack: could not make ${h} executable (mode ${mode.toString(8)})`);
    }
    console.log(`  after-pack: +x ${h.replace(root, "")}`);
  }

  // The helper is useless if it is sealed inside the asar, where there is no
  // real file to exec. asarUnpack should have placed it outside.
  for (const h of helpers) {
    if (!h.includes("app.asar.unpacked") && existsSync(join(root, "Contents", "Resources", "app.asar"))) {
      throw new Error(`after-pack: ${h} is inside the asar and cannot be executed`);
    }
  }
};
