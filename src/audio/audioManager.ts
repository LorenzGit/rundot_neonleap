/**
 * NEONLEAP audio (DESIGN.md §13).
 *
 * The score is the owner-supplied "Rooftop Run" track, bundled with the game
 * and looped through WebAudio at a fixed 20% music volume; FOCUS still pulls
 * it through a low-pass filter at half energy. Every sound EFFECT remains
 * fully procedural — filtered noise and tones synthesized at play time.
 *
 * Unlock rule (learned the hard way): play() never awaits resume(). Actions
 * happen first; sound joins when the context wakes up.
 */

import MUSIC_URL from "./assets/rooftop-run.mp3";

export type SoundCue =
    | "ui"
    | "confirm"
    | "jump"
    | "double_jump"
    | "land"
    | "pickup"
    | "near_miss"
    | "stumble"
    | "smash"
    | "billboard_smash"
    | "powerup"
    | "flow_up"
    | "edge_save"
    | "death"
    | "reward"
    | "fanfare";

interface AudioSettings {
    musicEnabled: boolean;
    sfxEnabled: boolean;
}

/** The bundled score plays at 20% — a bed under the procedural SFX. */
const MUSIC_VOLUME = 0.2;

class AudioManager {
    private context: AudioContext | null = null;
    private master: GainNode | null = null;
    private musicGain: GainNode | null = null;
    private musicFilter: BiquadFilterNode | null = null;
    private sfxGain: GainNode | null = null;
    private noiseBuffer: AudioBuffer | null = null;
    private musicElement: HTMLAudioElement | null = null;

    private settings: AudioSettings = { musicEnabled: true, sfxEnabled: true };
    private paused = false;
    private focus = false;
    private lastCueAt = new Map<SoundCue, number>();
    private unlockBound = false;

    /* ---------------------------------------------------------------- setup */

    applySettings(settings: { musicEnabled: boolean; sfxEnabled: boolean }): void {
        this.settings = { musicEnabled: settings.musicEnabled, sfxEnabled: settings.sfxEnabled };
        this.applyGains();
    }

    /**
     * Starts fetching/decoding the score during boot. Creating this element
     * inside the first-gesture path made a multi-megabyte decode land on the
     * exact frame the player pressed RUN; buffering it behind the menu costs
     * nothing and removes that hitch.
     */
    preloadMusic(): void {
        if (this.musicElement) return;
        const element = new Audio(MUSIC_URL);
        element.loop = true;
        element.preload = "auto";
        element.crossOrigin = "anonymous";
        this.musicElement = element;
        element.load();
    }

    bindUnlock(): void {
        if (this.unlockBound) return;
        this.unlockBound = true;
        const unlock = (): void => {
            this.ensureContext();
            const context = this.context;
            if (context && context.state === "suspended") void context.resume();
            this.syncMusicPlayback();
        };
        for (const type of ["pointerdown", "touchstart", "keydown"]) {
            window.addEventListener(type, unlock, { passive: true });
        }
    }

    private ensureContext(): void {
        if (this.context) return;
        const Ctor =
            window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return;
        const context = new Ctor();
        this.context = context;
        this.master = context.createGain();
        this.master.gain.value = 0.9;
        this.master.connect(context.destination);

        this.musicFilter = context.createBiquadFilter();
        this.musicFilter.type = "lowpass";
        this.musicFilter.frequency.value = 16000;
        this.musicGain = context.createGain();
        this.musicGain.connect(this.musicFilter);
        this.musicFilter.connect(this.master);

        this.sfxGain = context.createGain();
        this.sfxGain.connect(this.master);
        this.applyGains();

        const seconds = 1;
        const buffer = context.createBuffer(1, context.sampleRate * seconds, context.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
        this.noiseBuffer = buffer;

        // The looping score, routed through the music chain so the FOCUS
        // filter and the volume setting both apply to it. The element itself
        // was created (and has been buffering) since boot.
        this.preloadMusic();
        const element = this.musicElement;
        if (element) context.createMediaElementSource(element).connect(this.musicGain);
    }

    private applyGains(): void {
        if (this.musicGain) {
            this.musicGain.gain.value = this.settings.musicEnabled && !this.paused ? MUSIC_VOLUME : 0;
        }
        if (this.sfxGain) this.sfxGain.gain.value = this.settings.sfxEnabled && !this.paused ? 0.8 : 0;
        this.syncMusicPlayback();
    }

    /** Keeps the element's play/pause state honest against settings + focus. */
    private syncMusicPlayback(): void {
        const element = this.musicElement;
        if (!element) return;
        const shouldPlay = this.settings.musicEnabled && !this.paused && this.context?.state === "running";
        if (shouldPlay && element.paused) {
            void element.play().catch(() => {
                // Autoplay may still be blocked; the next gesture retries.
            });
        } else if (!shouldPlay && !element.paused) {
            element.pause();
        }
    }

    setPaused(paused: boolean): void {
        this.paused = paused;
        this.applyGains();
    }

    /** Menu and run share the one score; the API stays for future variants. */
    setMode(_mode: "menu" | "run"): void {}

    /** Layer control belonged to the procedural score; kept as a no-op API. */
    setTier(_tier: number): void {}

    setFocus(active: boolean): void {
        if (this.focus === active) return;
        this.focus = active;
        const context = this.context;
        if (!context || !this.musicFilter) return;
        const now = context.currentTime;
        this.musicFilter.frequency.cancelScheduledValues(now);
        this.musicFilter.frequency.setTargetAtTime(active ? 480 : 16000, now, 0.12);
    }

    /* ------------------------------------------------------------------ sfx */

    /**
     * Fire a cue. The pickup ladder climbs +1 semitone per chained cell and
     * resets with the chain (§13); everything else is a fixed shape.
     */
    play(cue: SoundCue, detail = 0): void {
        this.ensureContext();
        const context = this.context;
        const sfx = this.sfxGain;
        if (!context || !sfx || context.state !== "running") return;
        if (!this.settings.sfxEnabled || this.paused) return;
        const now = context.currentTime;
        const last = this.lastCueAt.get(cue) ?? -1;
        if (now - last < 0.03) return;
        this.lastCueAt.set(cue, now);

        const tone = (
            from: number,
            to: number,
            duration: number,
            type: OscillatorType,
            gain: number,
            delay = 0,
        ): void => {
            const osc = context.createOscillator();
            const env = context.createGain();
            osc.type = type;
            osc.frequency.setValueAtTime(from, now + delay);
            osc.frequency.exponentialRampToValueAtTime(Math.max(24, to), now + delay + duration);
            env.gain.setValueAtTime(gain, now + delay);
            env.gain.exponentialRampToValueAtTime(0.0001, now + delay + duration);
            osc.connect(env);
            env.connect(sfx);
            osc.start(now + delay);
            osc.stop(now + delay + duration + 0.05);
        };
        const hiss = (from: number, to: number, duration: number, q: number, gain: number, delay = 0): void => {
            if (!this.noiseBuffer) return;
            const source = context.createBufferSource();
            source.buffer = this.noiseBuffer;
            source.loop = true;
            const filter = context.createBiquadFilter();
            filter.type = "bandpass";
            filter.Q.value = q;
            filter.frequency.setValueAtTime(from, now + delay);
            filter.frequency.exponentialRampToValueAtTime(Math.max(60, to), now + delay + duration);
            const env = context.createGain();
            env.gain.setValueAtTime(gain, now + delay);
            env.gain.exponentialRampToValueAtTime(0.0001, now + delay + duration);
            source.connect(filter);
            filter.connect(env);
            env.connect(sfx);
            source.start(now + delay, Math.random());
            source.stop(now + delay + duration + 0.05);
        };

        switch (cue) {
            case "ui":
                tone(1900, 1400, 0.05, "sine", 0.12);
                break;
            case "confirm":
                tone(660, 660, 0.06, "triangle", 0.16);
                tone(990, 990, 0.09, "triangle", 0.14, 0.06);
                break;
            case "jump":
                hiss(900, 3400, 0.16, 1.1, 0.2);
                tone(300, 620, 0.12, "sine", 0.1);
                break;
            case "double_jump":
                hiss(1200, 4200, 0.14, 1.3, 0.2);
                tone(440, 880, 0.12, "triangle", 0.14);
                break;
            case "land":
                tone(150, 52, 0.11, "triangle", 0.16 + Math.min(0.2, detail * 0.14));
                hiss(700, 240, 0.08, 0.8, 0.1);
                break;
            case "pickup": {
                const semitone = Math.min(24, Math.max(0, detail));
                const base = 740 * 2 ** (semitone / 12);
                tone(base, base, 0.07, "sine", 0.16);
                tone(base * 2, base * 2, 0.1, "sine", 0.08, 0.02);
                break;
            }
            case "near_miss":
                hiss(2600, 700, 0.22, 1.6, 0.22);
                break;
            case "edge_save":
                hiss(3000, 5200, 0.1, 2, 0.14);
                tone(1180, 1560, 0.09, "square", 0.05);
                break;
            case "stumble":
                tone(220, 60, 0.22, "sawtooth", 0.2);
                hiss(2400, 300, 0.3, 0.7, 0.26);
                break;
            case "smash":
                hiss(1800, 300, 0.22, 0.8, 0.3);
                tone(240, 80, 0.16, "square", 0.14);
                break;
            case "billboard_smash":
                tone(130, 36, 0.34, "triangle", 0.34);
                hiss(1400, 160, 0.4, 0.6, 0.34);
                break;
            case "powerup":
                tone(520, 780, 0.1, "triangle", 0.16);
                tone(780, 1170, 0.16, "triangle", 0.16, 0.09);
                break;
            case "flow_up":
                for (let step = 0; step < 4; step += 1) {
                    tone(500 * 2 ** (step / 4), 500 * 2 ** ((step + 1) / 4), 0.07, "sawtooth", 0.07, step * 0.05);
                }
                hiss(800, 5200, 0.32, 1.4, 0.1);
                break;
            case "death":
                tone(220, 30, 0.7, "sine", 0.4);
                hiss(900, 90, 0.5, 0.6, 0.24);
                break;
            case "reward":
                tone(660, 660, 0.08, "triangle", 0.16);
                tone(880, 880, 0.08, "triangle", 0.16, 0.08);
                tone(1320, 1320, 0.18, "triangle", 0.16, 0.16);
                break;
            case "fanfare":
                tone(523, 523, 0.1, "triangle", 0.16);
                tone(659, 659, 0.1, "triangle", 0.16, 0.09);
                tone(784, 784, 0.1, "triangle", 0.16, 0.18);
                tone(1046, 1046, 0.26, "triangle", 0.18, 0.27);
                break;
        }
    }

    /** Dev/QA introspection: is the score actually rolling, and how loud. */
    debugState(): { contextState: string; musicPlaying: boolean; musicGain: number } {
        return {
            contextState: this.context?.state ?? "none",
            musicPlaying: this.musicElement !== null && !this.musicElement.paused,
            musicGain: this.musicGain?.gain.value ?? 0,
        };
    }

    destroy(): void {
        this.musicElement?.pause();
        this.musicElement = null;
        void this.context?.close();
        this.context = null;
    }
}

export const audioManager = new AudioManager();
