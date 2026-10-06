/**
 * Make the development Electron bundle identify as Bulletz.
 *
 * Running from source, the process IS node_modules/electron/dist/Electron.app,
 * and macOS reads the dock label, the application menu, and the About box from
 * that bundle's Info.plist. `app.setName()` cannot reach any of them — it only
 * changes app.getName() and the userData path — so without this the dock says
 * "Electron" no matter what the app does at runtime.
 *
 * None of this matters once the app is packaged: electron-builder writes
 * productName into CFBundleName and the problem goes away. This exists purely
 * so running from source does not look like somebody else's app.
 *
 * It edits node_modules, which npm will undo on reinstall — hence it runs from
 * predev/prestart rather than once by hand. It is idempotent, keeps a backup of
 * the original plist, and `--restore` puts everything back.
 */
import { copyFileSync, existsSync, utimesSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = join(HERE, "..");
const REPO = join(DESKTOP, "..", "..");

const APP = join(REPO, "node_modules", "electron", "dist", "Electron.app");
const PLIST = join(APP, "Contents", "Info.plist");
const BACKUP = join(APP, "Contents", "Info.plist.bulletz-backup");
const RESOURCES = join(APP, "Contents", "Resources");
const OUR_ICNS = join(DESKTOP, "assets", "icon.icns");

const NAME = "Bulletz";
const restore = process.argv.includes("--restore");

if (process.platform !== "darwin") process.exit(0); // only macOS reads a plist
if (!existsSync(PLIST)) {
  console.log("brand-dev-shell: no local Electron bundle; nothing to do");
  process.exit(0);
}

const plist = (...args) => execFileSync("/usr/libexec/PlistBuddy", ["-c", ...args, PLIST]).toString().trim();
const read = (key) => {
  try {
    return plist(`Print :${key}`);
  } catch {
    return null;
  }
};
const set = (key, value) => {
  try {
    plist(`Set :${key} ${value}`);
  } catch {
    plist(`Add :${key} string ${value}`);
  }
};

if (restore) {
  if (existsSync(BACKUP)) {
    copyFileSync(BACKUP, PLIST);
    console.log("brand-dev-shell: restored the original Info.plist");
  } else {
    console.log("brand-dev-shell: no backup to restore from");
  }
  const stock = join(RESOURCES, "electron.icns");
  const stockBackup = join(RESOURCES, "electron.icns.bulletz-backup");
  if (existsSync(stockBackup)) {
    copyFileSync(stockBackup, stock);
    console.log("brand-dev-shell: restored the original electron.icns");
  }
  process.exit(0);
}

// Already done, and the plist has not been replaced by a reinstall.
if (read("CFBundleName") === NAME && existsSync(join(RESOURCES, "electron.icns.bulletz-backup"))) {
  process.exit(0);
}

if (!existsSync(BACKUP)) copyFileSync(PLIST, BACKUP);

set("CFBundleName", NAME);
set("CFBundleDisplayName", NAME);

// The bundle icon is what the About panel and the pre-launch dock tile show;
// app.dock.setIcon() changes the running Dock tile only and cannot reach
// either. Deliberately NOT touching CFBundleIdentifier: macOS keys
// screen-recording and microphone permissions to it, and changing it silently
// resets what has been granted.
if (existsSync(OUR_ICNS)) {
  copyFileSync(OUR_ICNS, join(RESOURCES, "bulletz.icns"));
  set("CFBundleIconFile", "bulletz.icns");

  // Replace the stock icon under its own name as well. Icon Services may have
  // already cached "electron.icns" for this bundle path, and that cached
  // entry is what keeps showing the old logo in the About panel.
  const stock = join(RESOURCES, "electron.icns");
  const stockBackup = join(RESOURCES, "electron.icns.bulletz-backup");
  if (existsSync(stock)) {
    if (!existsSync(stockBackup)) copyFileSync(stock, stockBackup);
    copyFileSync(OUR_ICNS, stock);
  }
}

// Icon Services keys its cache on the bundle's modification date, so the plist
// edit alone is not enough — without bumping it, the old icon survives until
// the next login.
try {
  const now = new Date();
  utimesSync(APP, now, now);
  utimesSync(join(APP, "Contents"), now, now);
} catch {
  /* best effort */
}

try {
  execFileSync(
    "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
    ["-f", "-R", APP],
    { stdio: "ignore" },
  );
} catch {
  /* best effort — the name still applies on the next launch */
}

console.log(`brand-dev-shell: dev Electron bundle now identifies as "${NAME}"`);
