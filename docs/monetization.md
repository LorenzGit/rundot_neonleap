# NEONLEAP monetization brief

Model: `hybrid` (IAP + ads). Architecture: **Shop + Entitlements**
(server catalog, idempotent orders, reconciliation). Player-facing copy
says **Run Bits / RB**, never "bucks".

## Non-payer promise

Every powerup, upgrade track, mission, daily drop, and the full distance
ladder is earnable in play. Purchases accelerate (cells) or remove
interruptions (ad-free); they never unlock gameplay.

## Products (rundot/shop.config.json)

| itemId | Name | Kind | Price | Contents |
| --- | --- | --- | --- | --- |
| `neonleap_neon_core` | NEON CORE | non-consumable, unique | 249 RB | Removes interstitials forever; permanent +25% cells; ion-white trail |
| `neonleap_cell_cache` | CELL CACHE | consumable | 120 RB | 500 cells on grant |

Price evidence: sibling RUN titles — DEADSTOP ad-free 299 RB / cosmetic
199 RB; KINDRED consumable 120 RB. Launch hypothesis inside that band;
rollback signal = zero conversions after 200 exposed sessions → re-test
at 199/99.

## Ad placements

| placementId | Type | Trigger | Caps | Fallback |
| --- | --- | --- | --- | --- |
| `second_wind` | rewarded | Results screen, once per run, from the player's 2nd completed run; direct tap only | 1/run, 6/day | No-fill: hide button + one-line note; never substitute an RB charge |
| `run_end_break` | interstitial | After results acknowledged, every ≥3rd run end | ≥300 s apart, 2/session, 6/day, never first session, never adjacent to a rewarded view, removed by NEON CORE | No-fill: skip silently |

Reward: SECOND WIND reboots the runner at the death point at 60% speed
with 2 s invulnerability; cells already banked are kept. Grant only on
confirmed SDK success.

## Exposure gates and guardrails

- First exposure: after 1 completed run (value moment = first NEW BEST).
- KPIs: payer conversion, rewarded completion rate, interstitial-opt-out
  proxy (NEON CORE views), post-exposure abandonment.
- Guardrails: D1/D7 by exposure cohort; ad reward share of cell sources
  stays under 35%; purchase/ad error rate excluding cancellation.
- LiveOps: global kill switch + per-surface flags fail closed; absent
  config disables all monetization without touching gameplay.
- Pending purchase intent is persisted in the save and reconciled from
  order history on resume; background reconciliation never reopens
  checkout; a repeat tap retries the same idempotency key.
