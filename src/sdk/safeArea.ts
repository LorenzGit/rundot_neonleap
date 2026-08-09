export interface EdgeInsets {
    top: number;
    right: number;
    bottom: number;
    left: number;
}

export interface FrameBounds {
    top: number;
    right: number;
    bottom: number;
    left: number;
    width: number;
    height: number;
}

export interface ViewportSize {
    width: number;
    height: number;
}

/**
 * No real safe area eats this much of the screen. A larger reading is a bad
 * one — a host reporting device pixels against our CSS-pixel frame, a stale
 * measurement taken before layout, or simply a value we should not trust.
 *
 * Left unclamped it is catastrophic rather than cosmetic: the HUD anchors to
 * these insets, so an oversized bottom pushes the TIME bar above the score and
 * throws the movement stick clean off the top of the screen, and the menu and
 * results screens get squeezed into a sliver that clips from the top.
 */
export const MAX_SAFE_AREA_FRACTION = 0.3;

/**
 * And the two edges of an axis together may not take more than this. Capping
 * each edge separately still allows 60% of the screen to disappear, which is
 * enough to squeeze a sheet down to a sliver and leave its buttons stacked in a
 * rail taller than the content above them. Real insets are nowhere near this;
 * a notch and a home indicator together are under 15% of an axis.
 */
export const MAX_SAFE_AREA_AXIS_FRACTION = 0.4;

/** Shrinks a pair proportionally so the axis keeps most of itself. */
function fitAxis(near: number, far: number, extent: number): [number, number] {
    const total = Math.max(0, near) + Math.max(0, far);
    const limit = Math.max(0, extent) * MAX_SAFE_AREA_AXIS_FRACTION;
    if (total <= limit || total <= 0) return [near, far];
    const scale = limit / total;
    return [near > 0 ? near * scale : near, far > 0 ? far * scale : far];
}

/**
 * Bounded both ways, but not squashed to zero: a letterboxed frame legitimately
 * gets negative offsets so the HUD can reach back out toward the host boundary.
 * Only the magnitude is capped.
 */
function clampInset(value: number, extent: number): number {
    if (!Number.isFinite(value)) return 0;
    const limit = Math.max(0, extent) * MAX_SAFE_AREA_FRACTION;
    return Math.max(-limit, Math.min(value, limit));
}

export function safeAreaOffsetsForFrame(
    safeArea: Readonly<EdgeInsets>,
    frame: Readonly<FrameBounds>,
    viewport: Readonly<ViewportSize>,
): EdgeInsets {
    const safeRight = viewport.width - Math.max(0, safeArea.right);
    const safeBottom = viewport.height - Math.max(0, safeArea.bottom);
    const [top, bottom] = fitAxis(
        clampInset(Math.max(0, safeArea.top) - frame.top, viewport.height),
        clampInset(frame.bottom - safeBottom, viewport.height),
        viewport.height,
    );
    const [left, right] = fitAxis(
        clampInset(Math.max(0, safeArea.left) - frame.left, viewport.width),
        clampInset(frame.right - safeRight, viewport.width),
        viewport.width,
    );
    return { top, right, bottom, left };
}
