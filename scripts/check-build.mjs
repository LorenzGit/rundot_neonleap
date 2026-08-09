import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const distUrl = new URL("../dist/", import.meta.url);
const distPath = decodeURIComponent(distUrl.pathname);
const html = readFileSync(join(distPath, "index.html"), "utf8");

assert.match(html, /(?:src|href)="\.\/assets\//, "production asset URLs must be relative");
assert.ok(!html.includes('src="/assets/'), "absolute Vite asset paths are not RUN-safe");
assert.ok(!html.includes("game.config.playground"), "Playground config must not enter production output");

const thumbnail = readFileSync(join(distPath, "thumbnail.jpg"));
let offset = 2;
let width = 0;
let height = 0;
while (offset < thumbnail.length) {
    if (thumbnail[offset] !== 0xff) {
        offset += 1;
        continue;
    }
    const marker = thumbnail[offset + 1];
    const length = thumbnail.readUInt16BE(offset + 2);
    if (
        marker !== undefined &&
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)
    ) {
        height = thumbnail.readUInt16BE(offset + 5);
        width = thumbnail.readUInt16BE(offset + 7);
        break;
    }
    offset += 2 + length;
}
assert.equal(width, 512, "thumbnail width");
assert.equal(height, 512, "thumbnail height");

const assetDir = join(distPath, "assets");
const assetNames = readdirSync(assetDir);
for (const name of assetNames) {
    if (!name.endsWith(".js")) continue;
    const bytes = statSync(join(assetDir, name)).size;
    assert.ok(bytes < 620_000, `${name} exceeds the 620 kB JavaScript chunk ceiling`);
}

// NEONLEAP generates every texture and glyph at boot, and every sound EFFECT
// is synthesized. The one media file allowed is the owner-supplied score
// ("Rooftop Run"); bound it so a re-export can't quietly bloat the download.
const musicAssets = assetNames.filter((name) => /\.mp3$/.test(name));
assert.equal(musicAssets.length, 1, "exactly one bundled music track ships; SFX remain procedural");
for (const name of musicAssets) {
    const bytes = statSync(join(assetDir, name)).size;
    assert.ok(bytes < 3_500_000, `${name} exceeds the 3.5 MB music ceiling (${bytes} bytes)`);
}
const forbiddenMedia = assetNames.filter((name) => /\.(ogg|wav|m4a|png|webp|gif|ttf|woff2?)$/.test(name));
assert.deepEqual(forbiddenMedia, [], "no image, font, or other audio file ships — those stay generated at boot");

const totalBytes = assetNames.reduce((total, name) => total + statSync(join(assetDir, name)).size, 0);
assert.ok(totalBytes < 5_000_000, `asset payload ${totalBytes} bytes exceeds the 5 MB budget`);

console.log("build check ok: relative assets, 512x512 thumbnail, bounded chunks, one bounded music track");
