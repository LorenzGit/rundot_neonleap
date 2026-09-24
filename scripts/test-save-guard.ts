/**
 * Contract test for the save system's remote-write guard.
 *
 * A failed or timed-out RUN storage read used to load defaults and let the
 * next flush write them over the player's real cloud save — including an empty
 * redeemedOrderIds, so every old CELL CACHE order was granted again. This
 * replays that boot against the REAL save module with a fake RUN storage and
 * asserts the cloud copy survives.
 *
 * Run: node --experimental-strip-types --experimental-test-module-mocks scripts/test-save-guard.ts
 */
import { mock } from "node:test";

const localStorageData = new Map<string, string>();
Object.assign(globalThis, {
    window: Object.assign(globalThis, {
        localStorage: {
            getItem: (key: string) => localStorageData.get(key) ?? null,
            setItem: (key: string, value: string) => void localStorageData.set(key, value),
            removeItem: (key: string) => void localStorageData.delete(key),
        },
        matchMedia: () => ({ matches: false }),
    }),
});

const cloud = new Map<string, string>();
const fake = { host: true, readsFail: 0, writes: 0 };

mock.module(new URL("../src/sdk/runSdk.ts", import.meta.url).href, {
    namedExports: {
        getRunCapabilities: () => ({ host: fake.host, mock: false, storage: fake.host }),
        async readAppStorage(key: string) {
            if (fake.readsFail > 0) {
                fake.readsFail -= 1;
                return { ok: false, value: null };
            }
            return { ok: true, value: cloud.get(key) ?? null };
        },
        async writeAppStorage(key: string, value: string) {
            fake.writes += 1;
            cloud.set(key, value);
            return true;
        },
    },
});
// analyticsConfig reads import.meta.env (Vite-only); the save module only needs event().
mock.module(new URL("../src/systems/analytics/analyticsConfig.ts", import.meta.url).href, {
    namedExports: { analytics: { event: () => {} } },
});

const { saveSystem, DEFAULT_SAVE, SAVE_VERSION } = await import("../src/systems/save.ts");

const failures: string[] = [];
function expect(condition: boolean, message: string): void {
    if (!condition) failures.push(message);
}
/** A fresh copy of the save module (its own remote state), as on a new boot. */
const freshSave = (tag: string): Promise<typeof import("../src/systems/save.ts")> =>
    import(`../src/systems/save.ts?${tag}`);
const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const cells = () => saveSystem.get().wallet.cells;

const SAVE_KEY = "neonleap-save-v1";
const LOCAL_SAVE_KEY = "neonleap.local-save";
const OLD_ORDER = "order-cell-cache-1";
const realSave = JSON.stringify({
    ...DEFAULT_SAVE,
    records: { ...DEFAULT_SAVE.records, bestScore: 9_000, totalRuns: 40 },
    wallet: { cells: 777 },
    monetization: { ...DEFAULT_SAVE.monetization, redeemedOrderIds: [OLD_ORDER] },
});
cloud.set(SAVE_KEY, realSave);

// 1. Boot read times out (and so does the immediate background retry):
//    defaults in memory, cloud untouched by flushes. Boot redemption replays
//    an already-redeemed order against the empty in-memory ledger — that
//    grant must never reach the cloud.
fake.readsFail = 2;
const source = await saveSystem.load();
expect(source === ("unavailable" as string), `failed read should report "unavailable", got "${source}"`);
saveSystem.redeemCellOrder(OLD_ORDER, 500);
const flushed = await saveSystem.flush();
expect(flushed === false, "flush must fail while the cloud save is unverified");
expect(cloud.get(SAVE_KEY) === realSave, "cloud save was overwritten after a failed read");

// 2. The background retry recovers the real save (and its ledger), then writes resume.
await tick(2_300);
expect(cells() === 777, `retry should apply the real save (cells ${cells()})`);
expect(saveSystem.get().records.totalRuns === 40, "retry should restore records");
expect(saveSystem.redeemCellOrder(OLD_ORDER, 500) === false, "old CELL CACHE order must not be granted again");
expect(saveSystem.redeemCellOrder("order-cell-cache-2", 23), "a new order should still redeem");
expect((await saveSystem.flush()) === true, "flush should succeed once the cloud read succeeded");
const written = JSON.parse(cloud.get(SAVE_KEY) ?? "{}");
expect(written.wallet?.cells === 800, `verified flush should reach the cloud (cells ${written.wallet?.cells})`);
expect(written.monetization?.redeemedOrderIds?.includes(OLD_ORDER), "ledger lost the old order");

// 3. A save from a newer build is never overwritten.
const newer = JSON.stringify({ ...DEFAULT_SAVE, version: SAVE_VERSION + 1 });
cloud.set(SAVE_KEY, newer);
const fresh = await freshSave("newer");
await fresh.saveSystem.load();
fresh.saveSystem.redeemCellOrder(OLD_ORDER, 1);
expect((await fresh.saveSystem.flush()) === false, "flush must refuse to overwrite a newer build's save");
expect(cloud.get(SAVE_KEY) === newer, "newer-build save was overwritten");

// 4. An unreadable save is backed up before a new player's first write.
cloud.clear();
cloud.set(SAVE_KEY, "{not json");
const corrupt = await freshSave("corrupt");
expect((await corrupt.saveSystem.load()) === "defaults", "unreadable save should load defaults");
expect(cloud.get(`${SAVE_KEY}-unreadable-backup`) === "{not json", "unreadable save was not backed up");
corrupt.saveSystem.redeemCellOrder("order-x", 3);
expect((await corrupt.saveSystem.flush()) === true, "a verified new player must be able to save");

// 5. Offline (no host) still saves locally.
fake.host = false;
const offline = await freshSave("offline");
await offline.saveSystem.load();
offline.saveSystem.redeemCellOrder("order-y", 42);
expect((await offline.saveSystem.flush()) === true, "offline flush should write localStorage");
expect(localStorageData.has(LOCAL_SAVE_KEY), "offline flush did not reach localStorage");

// 6. Host attaches after an offline load: first flush must not clobber the cloud.
cloud.set(SAVE_KEY, realSave);
fake.host = true;
offline.saveSystem.redeemCellOrder("order-z", 1);
expect((await offline.saveSystem.flush()) === false, "late-attach flush must wait for a cloud read");
expect(cloud.get(SAVE_KEY) === realSave, "late attach overwrote the cloud save");

if (failures.length) {
    console.error(`save guard: ${failures.length} failure(s)\n  - ${failures.join("\n  - ")}`);
    process.exit(1);
}
console.log("save guard: all checks passed");
process.exit(0);
