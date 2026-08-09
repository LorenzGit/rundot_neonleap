import assert from "node:assert/strict";
import { MAX_SAFE_AREA_AXIS_FRACTION, MAX_SAFE_AREA_FRACTION, safeAreaOffsetsForFrame } from "../src/sdk/safeArea.ts";

assert.deepEqual(
    safeAreaOffsetsForFrame(
        { top: 88, right: 0, bottom: 34, left: 0 },
        { top: 0, right: 390, bottom: 844, left: 0, width: 390, height: 844 },
        { width: 390, height: 844 },
    ),
    { top: 88, right: 0, bottom: 34, left: 0 },
    "a full-viewport frame must receive the full host safe area",
);

assert.deepEqual(
    safeAreaOffsetsForFrame(
        { top: 88, right: 0, bottom: 34, left: 0 },
        { top: 102, right: 390, bottom: 742, left: 30, width: 360, height: 640 },
        { width: 430, height: 844 },
    ),
    { top: -14, right: -40, bottom: -68, left: -30 },
    "letterboxed HUD edges must receive signed offsets that reach out to the host safe boundaries",
);

assert.deepEqual(
    safeAreaOffsetsForFrame(
        { top: 88, right: 18, bottom: 34, left: 12 },
        { top: 60, right: 420, bottom: 820, left: 4, width: 416, height: 760 },
        { width: 430, height: 844 },
    ),
    { top: 28, right: 8, bottom: 10, left: 8 },
    "only the safe-area overlap with the game frame must become local HUD padding",
);

// A host reporting device pixels against our CSS-pixel frame produced insets
// that ate the screen: the HUD anchors to them, so the TIME bar ended up above
// the score and the movement stick was thrown clean off the top.
{
    const hostile = safeAreaOffsetsForFrame(
        { top: 228, right: 750, bottom: 1182, left: 741 },
        { top: 0, right: 718, bottom: 440, left: 0, width: 718, height: 440 },
        { width: 718, height: 440 },
    );
    for (const [edge, value, extent] of [
        ["top", hostile.top, 440],
        ["bottom", hostile.bottom, 440],
        ["left", hostile.left, 718],
        ["right", hostile.right, 718],
    ] as const) {
        assert.ok(
            Math.abs(value) <= extent * MAX_SAFE_AREA_FRACTION + 0.001,
            `${edge} inset ${value} must be capped; an inset that eats the screen is a bad reading`,
        );
    }
    assert.ok(
        hostile.top + hostile.bottom < 440,
        "vertical insets must never consume the whole viewport, or nothing can be laid out",
    );
    assert.ok(hostile.left + hostile.right < 718, "horizontal insets must never consume the whole viewport");
}

// Non-finite readings must not poison the layout.
assert.deepEqual(
    safeAreaOffsetsForFrame(
        { top: Number.NaN, right: Number.POSITIVE_INFINITY, bottom: Number.NaN, left: Number.NaN },
        { top: 0, right: 390, bottom: 844, left: 0, width: 390, height: 844 },
        { width: 390, height: 844 },
    ),
    { top: 0, right: 0, bottom: 0, left: 0 },
    "a non-finite safe area must fall back to nothing rather than NaN padding",
);

// Capping each edge alone still lets 60% of an axis vanish, which squeezes a
// sheet to a sliver. The two edges of an axis together are bounded as well.
{
    const squeezed = safeAreaOffsetsForFrame(
        { top: 228, right: 750, bottom: 1182, left: 741 },
        { top: 0, right: 718, bottom: 440, left: 0, width: 718, height: 440 },
        { width: 718, height: 440 },
    );
    assert.ok(
        squeezed.top + squeezed.bottom <= 440 * MAX_SAFE_AREA_AXIS_FRACTION + 0.001,
        `vertical insets took ${squeezed.top + squeezed.bottom} of 440; a sheet needs most of its axis`,
    );
    assert.ok(
        squeezed.left + squeezed.right <= 718 * MAX_SAFE_AREA_AXIS_FRACTION + 0.001,
        `horizontal insets took ${squeezed.left + squeezed.right} of 718`,
    );
}

console.log("safe area check ok: signed frame offsets, per-edge and per-axis bounds");
