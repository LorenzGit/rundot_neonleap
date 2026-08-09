/**
 * Deterministic, position-based 32-bit noise for ordinary game randomness.
 *
 * This is an unsigned-integer port of the C# NoiseRandom implementation. Each
 * `next*` call hashes the current `(seed, position, salt)` tuple, then advances
 * `position` exactly once. Use `salt` to create independent decisions at the
 * same logical position.
 *
 * This is not cryptographically secure. RUN SyncPlay simulations must use the
 * server-owned deterministic RNG and noise functions supplied by the SDK.
 */
export class NoiseRandom {
    static readonly MAX_UINT32 = 0xffff_ffff;

    private static readonly BIT_NOISE1 = 0xb529_7a4d;
    private static readonly BIT_NOISE2 = 0x68e3_1da4;
    private static readonly BIT_NOISE3 = 0x1b56_c4e9;

    seed: number;
    position: number;

    constructor(seed: number = Date.now() >>> 0, position = 0) {
        this.seed = 0;
        this.position = 0;
        this.setSeedAndPosition(seed, position);
    }

    setSeedAndPosition(seed: number, position: number): void {
        this.seed = requireUint32(seed, "seed");
        this.position = requireUint32(position, "position");
    }

    /**
     * Return an integer in `[lowerBoundInclusive, upperBoundExclusive)`.
     *
     * The modulo mapping intentionally matches the original C# implementation.
     */
    int(lowerBoundInclusive: number, upperBoundExclusive: number, salt = 0): number {
        requireSafeInteger(lowerBoundInclusive, "lowerBoundInclusive");
        requireSafeInteger(upperBoundExclusive, "upperBoundExclusive");
        const range = upperBoundExclusive - lowerBoundInclusive;
        if (range <= 0 || range > 0x1_0000_0000) {
            throw new RangeError("upperBoundExclusive must be greater than lowerBoundInclusive by at most 2^32");
        }
        return (this.nextUint(salt) % range) + lowerBoundInclusive;
    }

    /**
     * Return a float in `[lowerBoundInclusive, upperBoundInclusive]`.
     *
     * Both endpoints are representable because `nextDouble()` divides by
     * `0xffffffff`, matching the original C# implementation.
     */
    float(lowerBoundInclusive: number, upperBoundInclusive: number, salt = 0): number {
        requireFiniteNumber(lowerBoundInclusive, "lowerBoundInclusive");
        requireFiniteNumber(upperBoundInclusive, "upperBoundInclusive");
        if (upperBoundInclusive < lowerBoundInclusive) {
            throw new RangeError("upperBoundInclusive must be greater than or equal to lowerBoundInclusive");
        }
        return this.nextDouble(salt) * (upperBoundInclusive - lowerBoundInclusive) + lowerBoundInclusive;
    }

    /** Return `true` with the requested probability, consuming one position. */
    bool(probability = 0.5, salt = 0): boolean {
        requireFiniteNumber(probability, "probability");
        if (probability < 0 || probability > 1) {
            throw new RangeError("probability must be between 0 and 1");
        }
        const sample = this.nextDouble(salt);
        return probability >= 1 || (probability > 0 && sample < probability);
    }

    /** Return a normalized double in `[0, 1]`. */
    nextDouble(salt = 0): number {
        return this.nextUint(salt) / NoiseRandom.MAX_UINT32;
    }

    /** Return a uint in `[0, 0xffffffff]`, then advance the position once. */
    nextUint(salt = 0): number {
        const value = NoiseRandom.randomize(this.seed, this.position, salt);
        this.position = (this.position + 1) >>> 0;
        return value;
    }

    /** Pure hash of a `(seed, position, salt)` tuple. Does not mutate state. */
    randomize(seed: number, position: number, salt = 0): number {
        return NoiseRandom.randomize(seed, position, salt);
    }

    /** Pure hash of a `(seed, position, salt)` tuple. Does not mutate state. */
    static randomize(seed: number, position: number, salt = 0): number {
        const normalizedSeed = requireUint32(seed, "seed");
        const normalizedPosition = requireUint32(position, "position");
        const normalizedSalt = requireUint32(salt, "salt");

        let noise = Math.imul(normalizedPosition, NoiseRandom.BIT_NOISE1) >>> 0;
        noise = (noise + normalizedSeed + normalizedSalt) >>> 0;
        noise = (noise ^ (noise >>> 8)) >>> 0;
        noise = (noise + NoiseRandom.BIT_NOISE2) >>> 0;
        noise = (noise ^ (noise << 8)) >>> 0;
        noise = Math.imul(noise, NoiseRandom.BIT_NOISE3) >>> 0;
        return (noise ^ (noise >>> 8)) >>> 0;
    }
}

function requireUint32(value: number, name: string): number {
    requireSafeInteger(value, name);
    if (value < 0 || value > NoiseRandom.MAX_UINT32) {
        throw new RangeError(`${name} must be an unsigned 32-bit integer`);
    }
    return value >>> 0;
}

function requireSafeInteger(value: number, name: string): void {
    if (!Number.isSafeInteger(value)) {
        throw new TypeError(`${name} must be a safe integer`);
    }
}

function requireFiniteNumber(value: number, name: string): void {
    if (!Number.isFinite(value)) {
        throw new TypeError(`${name} must be a finite number`);
    }
}
