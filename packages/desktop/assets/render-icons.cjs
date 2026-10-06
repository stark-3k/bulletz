const { app, BrowserWindow } = require("electron");
const { writeFileSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");

const OUT = process.argv[2];
const PAGE = process.argv[3];
const SIZES = [16, 32, 64, 128, 256, 512, 1024];

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  mkdirSync(OUT, { recursive: true });
  // One window, resized and reloaded per size. Spawning a fresh window each
  // time raced its own load and failed with ERR_FAILED after the first.
  const win = new BrowserWindow({
    width: 1024, height: 1024, show: false, transparent: true, frame: false,
    backgroundColor: "#00000000", webPreferences: { deviceScaleFactor: 1 },
  });

  for (const size of SIZES) {
    win.setContentSize(size, size);
    // The page reads ?size to decide whether to use the simplified small-icon
    // treatment, so it must reload rather than just resize.
    await win.loadFile(PAGE, { query: { size: String(size) } });
    await new Promise((r) => setTimeout(r, 600));
    const img = await win.webContents.capturePage();
    writeFileSync(join(OUT, `${size}.png`), img.toPNG());
    const s = img.getSize();
    console.log(`  ${String(size).padStart(4)}.png -> ${s.width}x${s.height}`);
  }
  win.destroy();
  app.quit();
});
