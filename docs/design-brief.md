# NEONLEAP design brief

- Player fantasy / audience / orientation / session length: night-city
  rooftop courier in an endless one-touch sprint; arcade score-chasers;
  landscape; 30–180 s runs inside 3–8 min sessions.
- One-sentence core loop and first meaningful action: sprint, tap/hold to
  clear gaps, chain pickups and near-misses into a flow multiplier, die,
  upgrade, retry — the first meaningful action is the first held jump over
  the runway's first gap.
- First 10-minute path: stable runway → first gap success → first cell
  line (decision: follow the arc) → first stumble (recovery is instant and
  fair) → first death inside 90 s → results show distance + NEW BEST +
  cells → one-tap retry → first powerup → Upgrade Bay opens after run 2 →
  SECOND WIND revive offer appears from run 2 → daily missions revealed.
- Goal ladder: short = beat your distance / finish a mission; medium =
  max an upgrade track (≈ a week of runs) and unlock HEAD START tiers;
  long = chase tier-10+ mastery and the full upgrade wall. Each changes
  play: upgrades alter routing and run starts, HEAD START skips the slow
  game.
- First-session win / stopping point / next-session promise: win = a
  400 m+ run with a visible NEW BEST; stopping point = results screen
  after a mission claim; promise = "three fresh missions and a supply
  drop tomorrow, and HEAD START gets you back to speed".
- Return hook: daily missions + nightly supply drop (cells), one
  consensual 22 h reminder notification, cancellable and truthful.
- Controls / accessibility / feedback: one touch (tap/hold); coyote +
  buffered jumps; every event has visual + SFX + optional haptic chain;
  reduced-motion strips shake/afterimages; color never carries state
  alone (icons + text on powerups).
- Difficulty / pacing / skill-RNG policy: distance-tiered ramp (§7 of
  DESIGN.md); generator is seeded and provably fair — every gap is
  clearable at the speed it appears (balance bot proves it); powerup
  rolls are the only run-to-run variance.
- Economy: sources = runs (cells), missions, daily drop; sinks = five
  upgrade tracks + revive alternative; caps = track level 5; non-payer
  promise in DESIGN.md §10.
- LiveOps seams: stable product/placement IDs in the monetization
  registries; mission templates parameterized; LiveOps flags can close
  every monetization surface.
- Metrics: FTUE first-jump/first-death timing, runs/session, retry rate,
  revive take-rate, flow tier distribution, upgrade funnel, D1/D7 by
  exposure cohort (guardrails per monetization plan).
- Vertical slice / test plan / next decision: slice = runway → 2 roofs →
  1 powerup; owner test on phone + desktop; next decision = RB price
  review after first Playground catalog read.
