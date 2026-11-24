# Snow under the canopy and snow off the trees

Researched 2026-11-23 for FEAT-354 (#813, interception and shelter) and FEAT-355 (#814, trees unloading through the day). One doc because both are one model: how much of a storm the canopy holds, and when it lets go. Part of EPIC-01 (#441).

**The picks, in short**

1. **Interception is a stand effect, read from the 10 m canopy grid** (FEAT-330's `pack/CanopyGrid.ts`), not the 1 m mask's canopy. It lowers the *depth to the ground* (`sim/Snowpack.ts`) and the storm's share of the loose layer (`sim/SnowConditions.ts`), never the drawn snow surface. A closed stand (canopy score 1) holds up to 60 % of a small storm and at most about 0.12 m of new snow, and has 30 % less settled base.
2. **Shelter**: the sun reaching the snow under a stand drops by the same 0.65 the light already drops by there (`CANOPY_SUN`, `world/Sky.ts`), so slush and spring refreeze ease off in the trees; wind scour and tracking already skip the trees. Wind slab waits for FEAT-060 (#93), with a gate written down here.
3. **Unloading stays one uniform.** The storm's part of the tree load decays with the hours since the storm, by a wind, cold and warm-sun rule in closed form (no per-stand state), with a per-tree hash on the rate so some trees go bare first. Near, far and clump LODs all read `treeSnowUniforms`, so they keep matching for free.
4. **Visible unloads** reuse FEAT-217's `TreeBrush` (the spray ring, `uTreeShed`, the bough thump) for a tree near the rider, set off by the gusts in `world/Snow.ts` (and FEAT-060's wind once it exists), a few a minute at most on a loaded, windy morning.
5. **Tree wells (#818) and buried trees (#816) read the same canopy-aware depth**, so an open-grown spruce in a glade keeps a deep well and a tree inside closed timber gets a shallower one, which is how real wells behave.

Four build cards at the end, smallest first: FEAT-360 (#823), FEAT-363 (#825), FEAT-367 (#828), FEAT-369 (#831).

---

## 1. What the game does today

### Depth

- `sim/Snowpack.ts` (FEAT-159): `snowpackDepth(st, z, south, north)` = settled base by month at 3,000 m, times the elevation scale `elevationK(z)`, times the aspect (south faces lose up to 40 %, 60 % on a spring day, north faces gain 10 %), plus `fresh` = 0.35 m x the new snow cover (FEAT-105, 0..1) plus 0.1 m on a "fresh" day. It is the depth from the ground to the snow surface; the terrain is drawn as the snow surface, so the depth only decides what pokes out of it. Readers:
  - the shrubs (`world/Shrubs.ts` `setSnowpack`, `depthAt`, the burial loop at line 277, with per-shrub aspect weights and a +-10 % jitter);
  - the terrain shader's far "ground shows through thin snow" term (BUG-081, `SNOWPACK_GLSL`, `terrain/TerrainMaterial.ts` line 484), which only acts past the trees on open ground;
  - open PR #818 (FEAT-216, tree wells, `world/TreeWells.ts`): a well round each big spruce, fir, Douglas-fir and hemlock, half the snowpack deep at the trunk (at most 1 m), stamped into a 128 m window and added to `Pack.terrainHeight`;
  - open PR #816 (FEAT-336, `world/trees/burial.ts`): trees shorter than the depth plus 0.5 m are left out, those up to 1.5 m taller are sunk by it.
- None of them look at the canopy. The depth is the same in a closed spruce stand as on the open face beside it.

### Snow conditions

`sim/SnowConditions.ts` `snowAt(s, n, z, w, out)` mixes six kinds (groomed, powder, chop, ice, slush, rock) from the surface sample and the day. Canopy enters as `trees = clamp((s.canopy - 0.15) / 0.3)`, where `s.canopy` is the 1 m surface mask's alpha (`sim/Rider.ts` line 498, `this.surface.canopy = m[3]`). It already does three shelter things:

- wind scour (ice on high open ground): `scoured = ... * (1 - trees)`;
- tracking (chop through the day): `tracked = ... * (1 - trees)`, and the powder "keep" term gets `+ 0.45 * trees`;
- loose depth: `powDepth = 0.12 + 0.08 shade + 0.1 trees + 0.2 fresh`, so powder is *deeper* under the trees than in the open.

What it does not do: the sun term `sunny = (1 - storm) * (1 - shade)` and the spring `refreeze` ignore the trees, so a stand gets slush and morning ice like an open south face. Nothing makes a storm's new snow thinner under the canopy.

Other readers of `s.canopy`: `audio/Audio.ts` line 544 (the crust crackle on steep off-piste drops to 0.3 under canopy over 0.3) and line 607 (branch brush sounds over 0.5), and `ui/Conditions.ts` line 45 ("in the trees" over 0.4).

The canopy *grid* (`pack/CanopyGrid.ts`, MapPacker FEAT-331, 10 m cells, byte / 255 = how closed and tall the canopy is overhead) is read only by the light: `states/RideFrame.ts` line 297 calls `env.updateCanopy(pack.canopyAt(x, y), ...)`, which scales the sun to `1 - 0.65 c` and the sky fill to `1 - 0.3 c` (`world/Sky.ts`, `CANOPY_SUN`, `CANOPY_HEMI`). A pack without `meta.canopy` reads 0 everywhere.

### Wind

There is no wind field yet: FEAT-060 (#93) is open, planning only. The one wind is `world/Snow.ts` `uWind` = (3 + 2.5 sin(0.13 t), 1.2 sin(0.07 t + 1)) m/s, the falling flakes' drift, also handed to `terrain.setSnowCover` and `rocks.setSnow` as the lee direction (`RideFrame.ts` lines 338 and 368). No wind slab exists.

### Snow on the trees

`world/trees/snow.ts` (FEAT-157): `treeSnowState(newSnow, day, month, hour, clear)` gives one `{ load, melt, ghost }` for the day:

- `load = base + (1 - base) * clamp(newSnow * 1.5)`, `base` 0.55 / 0.35 / 0.12 (fresh / mid / spring) scaled by `winterDepth(month)`. It does not depend on the hour: a powder morning's trees are still full at 4 pm.
- `melt`: the sun side melts back from 10:30 to 15:00, more in spring, times `clear` and `1 - newSnow`.
- `ghost`: rime above the pack's treeline in deep winter.

`setTreeSnow` writes `treeSnowUniforms.uTreeSnow` (load, melt, ghost). Every tree shader takes that same object: the mesh LODs (`world/trees/materials.ts` lines 267 and 297), the far impostor's runtime blend of its baked moderate and heavy masks (`materials.ts` line 413, the bake itself uses fixed loads), and the clump impostors (`world/trees/clumps.ts` line 592, BUG-127's fix). `treeSnowLoadAt` mirrors the shader's per-tree +-15 % hash on the CPU for `TreeBrush`.

`world/TreeBrush.ts` (FEAT-217): a crown the rider brushes drops a share of its near side's snow through the board's spray ring (`Spray.emit`, no draw call of its own), the tree goes bare on that side through `uTreeShed` (the nearest `TREE_SHED_MAX` = 8 trees), builds back over 240 s, and `Audio` plays the bough thump and sift (`Audio.ts` line 444). A trunk slam shakes the whole tree over several frames under `FRAME_CAP`. Replays use their own shed memory. `tools/treepuffcheck.mjs` checks it in Node.

`sky.snowCover` only rises (a storm adds `dt / 600` a second, flurries `dt / 3000`) and the hour is fixed by the Time of day setting unless it is "now" (`world/SunClock.ts`), so "through the day" in the game means "as a function of the hour", plus whatever happens in the session.

---

## 2. Interception: how much of a storm reaches the ground

### What the sources say

- **Maritime (Oregon Cascades)**: 44 years of paired snow surveys at the H.J. Andrews Forest found 2 to 3 times more snow depth in road openings than in the forest beside them, with the same density (about 365 kg/m3) in both ([Whidden 2023, Andrews pub 5314](https://andrewsforest.oregonstate.edu/publications/5314)). At the Umpqua site about 60 % of snowfall was intercepted, up to about 40 mm of water held at once; 72 % of what left the canopy went as melt drip and 28 % as falling clumps ([Storck et al. 2002](https://cig.uw.edu/publications/modeling-snow-accumulation-and-ablation-processes-in-forested-environments/)).
- **Continental (Colorado, closest to the packs we ride)**: at Fraser Experimental Forest a mature spruce-fir canopy intercepted on average 36 % of snowfall, more in small storms and in cold ([Stottlemyer and Troendle 2001, USGS](https://pubs.usgs.gov/publication/70023328)). A clearcut's peak snow water averaged 36 % above the forest over six years ([Troendle and Reuss 1997](https://hess.copernicus.org/articles/1/325/1997/)), and the Colorado water board's summary gives 20 to 45 % more by aspect, most of it from less winter interception ([CWCB](https://dnrweblink.state.co.us/CWCB/0/doc/169781/Page18.aspx)). Read the other way: the forest floor holds roughly 70 to 80 % of the open's peak.
- **The shape of the curve**: the standard interception model ([Hedstrom and Pomeroy 1998](https://research-groups.usask.ca/hydrology/documents/pubs/papers/lv_pomeroy_2020.pdf), summarised there) has the canopy catch snow in proportion to its closure until the branches fill toward a maximum load that scales with leaf area and drops as the snow gets warmer and wetter. So a small storm is caught at nearly the closure fraction and a big storm passes a larger share. A review of many paired sites found forest cover alone explains 57 % of the variance in relative accumulation, through a simple linear fit ([Varhola et al. 2010](https://research.fs.usda.gov/treesearch/48807)).
- **Dense stands peak lower** across 228 SNOTEL sites ([Sun et al. 2022](https://www.osti.gov/pages/servlets/purl/1908324)).

**Where they disagree**: the maritime 2 to 3 times is seasonal and includes rain and warm melt under the trees; the Colorado numbers are 20 to 36 %. [Lundquist et al. 2013](https://washington.edu/news/2013/11/13/snow-melts-faster-under-trees-than-in-open-areas-in-mild-climates) put the switch at about 30 F (-1 C) mean winter temperature: warmer than that, snow lasts longer in openings; colder, it lasts longer under the trees, because the shade wins. All the packs we have are cold continental resorts, so the game takes the Colorado numbers and keeps the climate switch as an open question (section 8).

### The game rule (starting point)

With `c` the canopy grid's score (0..1) at the spot and `P` the storm's new snow on open ground (m, today's `fresh`):

```
held(c, P) = c * min(HOLD_SHARE * P, HOLD_MAX)     HOLD_SHARE = 0.6, HOLD_MAX = 0.12 m
fresh_under(c, P) = P - held(c, P)
base_under(c) = base * (1 - BASE_LOSS * c)         BASE_LOSS = 0.3
```

The share of the storm that reaches the ground:

| New snow on open ground (P) | game setting | c = 0.3 (open glade) | c = 0.6 | c = 1 (closed stand) |
|---|---|---|---|---|
| 0.05 m | a flurry | 82 % | 64 % | 40 % |
| 0.09 m | Dusting (cover 0.25) | 82 % | 64 % | 40 % |
| 0.21 m | 6 in (cover 0.6) | 83 % | 66 % | 43 % |
| 0.35 m | Powder day (cover 1) | 90 % | 79 % | 66 % |
| 0.45 m | Powder day on a "fresh" day | 92 % | 84 % | 73 % |

A closed stand on a powder day has about two thirds of the open's new snow (1.5 times less), and the season's base is 30 % less, inside Fraser's 20 to 36 % and short of the maritime 2 to 3 times on purpose. `HOLD_MAX` at 0.12 m is roughly 10 mm of water at a fresh density of 80 kg/m3: below Storck's 40 mm maritime peak, about the low end of what Hedstrom and Pomeroy's load formula gives for a Colorado spruce-fir (reasoned, not measured). Density stays the same under the trees (Whidden), so nothing else in the snow needs a canopy term.

### Which canopy

- The **canopy grid** (10 m) for interception: it is a stand-scale effect, and the grid is already the "closed and tall overhead" number. One bilinear sample on a byte array per call.
- **Not the 1 m mask's canopy**: at 1 m the depth would dip under each crown and drop at each gap, which is the tree well's job (#818) and would count the wells twice.
- A pack without a canopy grid gets no interception, exactly as today.

### Where it goes

1. `sim/Snowpack.ts`: `snowpackDepth(st, z, south, north, canopy = 0)` applies `base_under` and `fresh_under`. The default 0 keeps every current caller and the GLSL twin as they are. `SNOWPACK_GLSL` stays canopy-free: it only acts on open far ground (BUG-081), where the trees and the forest tone cover the rest; say so in its comment.
2. `sim/SnowConditions.ts`: the storm part of the powder depth uses the same share, `0.2 * fresh * (1 - held / P)` computed by one shared helper, so the loose layer a board sinks into is shallower under a closed stand on a powder day. `+ 0.1 trees` (untracked, sheltered) stays. `SurfaceInfo` gains `stand` (the grid's score), set in `Rider.ts` next to `canopy`.
3. Shrubs: sample the grid once per shrub when its cell loads (beside the `south` / `north` arrays) and pass it in the burial loop. Understory under closed timber then shows more of itself.
4. #816 burial and #818 wells: pass the canopy at the tree's base into the same `snowpackDepth`. For wells this is the behaviour we want: real wells are deepest round open-grown conifers with branches to the snow in a deep pack, and a tree inside closed timber stands in snow that is already shallower round it. Both PRs stamp or bury when a cell builds or the snowpack moves, and the canopy never changes, so neither restamps more often.
5. The drawn surface does not move: lowering the ground under every stand would make a step at each forest edge and shift every collider, track and prop. The rider feels interception as less loose depth on a powder day and more base contact, rocks, stumps and understory closer to the surface.

---

## 3. Shelter: wind and sun skip the trees

### What the sources say

- Wind speed drops steeply into a forest: one avalanche course summary of Schneebeli and Meyer-Grass (1992) gives about 10 m/s in the open, 0.9 m/s in a sparse forest and 0.1 m/s in a dense one ([summary](https://prezi.com/k-s9eidomp2g/the-role-of-forest-in-slab-avalanche-formation); a secondary source, treat the numbers as indicative). Wind-sheltered terrain is "typically found below treeline", with "softer, fluffier snow on the surface", and new snow stays on the branches ([avalanche.org: wind sheltered](https://avalanche.org/avalanche-encyclopedia/terrain/slope-characteristics/wind-exposure/wind-sheltered/)).
- But strong winds still make slabs in "small pockets in steep gullies or even down in the trees", in open glades below treeline, and behind stands that act as snow fences ([CAIC wind slab](https://avalanche.state.co.us/wind-slab), [CAIC problem guide](https://cloudfront.avalanche.state.co.us/wp-content/uploads/2015/10/avchar-windslab.pdf)). So the edge of a stand and a glade are not fully sheltered.
- Sun: a closed conifer canopy lets through a small share of the direct sun, which is why the snow under it lasts longer in cold climates (Lundquist 2013, above). The game already dims the light under the canopy by `CANOPY_SUN` = 0.65; the snow should see the same.
- Refreeze: the canopy also radiates down at night, so the snow under it cools less than open snow under a clear sky (the usual forest energy balance, Varhola 2010; reasoned for the game). A stand's spring snow is softer first thing and slushes later.

### The game rule (starting point)

In `snowAt`, with `cs` the stand score:

```
sunny   = (1 - storm) * (1 - shade) * (1 - CANOPY_SUN * cs)     // slush, warmth
refreeze = refreeze * (1 - 0.5 * cs)                             // spring morning ice
```

`CANOPY_SUN` is imported from `world/Sky.ts` (or moved to a shared constants module) so the light and the snow agree. Scour and tracking keep their 1 m `trees` gate: they are about the rider's immediate surroundings and already work.

**Wind slab (FEAT-060)**: when the wind field is built, gate wind-packed snow and slab by `1 - smoothstep(0.3, 0.7, cs)`, with the lee edge of a stand (a cell whose upwind neighbour has a much lower score) getting a drift instead. This card writes that gate down on #93; there is nothing to build until the wind exists.

**What the rider feels**: on a windy or sunny afternoon the open faces turn to scoured ice, chop or slush while the trees keep soft, even powder. The crust sound already drops under canopy (`Audio.ts` line 544), and now the snow behind it agrees.

---

## 4. Unloading: the load through the day

### What the sources say

- Intercepted snow leaves by melt drip, sublimation and solid unloading. The standard model treats unloading as a constant rate proportional to the load, so it decays exponentially after a storm ([Hedstrom and Pomeroy 1998](https://research-groups.usask.ca/hydrology/documents/pubs/papers/lv_pomeroy_2020.pdf)); the coefficient often quoted for it is about 0.7 a day (CRHM and SUMMA implementations; not checked against the 1998 text here).
- Comparing three unloading schemes against time-lapse cameras, a wind and temperature scheme (after Roesch et al. 2001) did best without calibration "especially in cold climates where wind dominates unloading", the exponential decay needed local calibration, and melt drip suited rime-prone sites; the scheme alone moves the snow under the canopy by about 20 % ([Lumbrazo et al. 2022](https://snow.nasa.gov/pubs/2022/evaluating-multiple-canopy-snow-unloading-parameterizations-summa-time-lapse-photography)).
- In the field, unloading came with wind gusts and melt in the canopy, but "no trends were found ... that could be used to predict the onset of unloading from gusts or air temperature alone" ([Cebulski thesis, U Saskatchewan](https://harvest.usask.ca/handle/10388/etd-09302010-145706?show=full)); land surface models rest on very few interception studies and lack the right temperature sensitivity ([Lundquist et al. 2021](https://www.co.chelan.wa.us/files/natural-resources/documents/Lundquist%20et%20al%202021%20-%20Snow%20interception%20modelling%20-%20Isolated%20observations%20have%20led%20to%20LSM%20lacking%20appropriate%20temperature%20sensitivities.pdf)). A recent model test still misses the fast unloads in strong wind, warmth or rain on snow ([EGU26-15976](https://meetingorganizer.copernicus.org/EGU26/EGU26-15976.html)).
- Rime sticks: rime-prone sites unload more slowly and are less sensitive to wind (Lumbrazo 2022).

**Where they disagree**: there is no agreed simple predictor. The game takes the plain rule the sources lean on (exponential decay, faster with wind and with warm sun) and does not try to time real events.

### The game rule (starting point)

Split today's load into the old base and the storm's part, and let only the storm's part decay:

```
storm = (1 - base) * clamp(newSnow * 1.5)                 // today's extra load
load  = base + storm * exp(-K(hour))
K(hour) = (K_COLD + K_WIND) * dt + K_WARM * warm * clear * sunHours(hour)
dt = max(0, hour - STORM_END)                             // hours since the storm, STORM_END = 7
sunHours(h) = 4.5 * (T^3 - T^4 / 2) for T = (h - 10.5) / 4.5 in 0..1, then 2.25 + (h - 15)
K_COLD = 0.03 / h (about 0.7 a day), K_WIND = 0.06 / h, K_WARM = 1.5 / h
```

`sunHours` is the exact integral of the `smooth(10.5, 15, hour)` ramp the sun-side `melt` already uses, so the two stay in step. `warm` is `treeSnowState`'s existing 0.2 / 0.45 / 0.9 by snow conditions. While it is snowing (storm or flurries) `dt` is 0 and the trees stay full. What it gives:

| Day | 9:00 | 13:00 | 16:00 |
|---|---|---|---|
| Fresh, cloudy (warm 0.2, clear 0.1) | 84 % of the storm load | 57 % | 40 % |
| Mid, clear (warm 0.45, clear 1) | 84 % | 40 % | 5 % |
| Spring, clear (warm 0.9, clear 1) | 84 % | 27 % | 1 % |

Wind and cold alone take about 40 % by 1 pm and 60 % by 4 pm; a sunny day strips most of it by mid-afternoon: the pattern riders see. Values are game tuning, flagged as a starting point.

**In the session**: the hour does not move on a fixed Time of day, so a storm that ends while riding starts its own clock: `dt` grows by real seconds times 12 (an hour of shedding every 5 minutes) from the moment the weather clears, capped by the hour rule. The new snow cover itself is unchanged (`RideFrame.ts` line 335).

**Ghosts**: the ghost term (rime) is left out of the decay, as rime holds on (Lumbrazo 2022).

### One uniform or per-stand state

**One uniform is enough.** Real stands do unload unevenly (sun-facing edges and wind-exposed crowns first), but the cheap stand-ins cost no state:

- a per-tree rate from the hash `treeSnowLoad` already computes (`h`): `load = max(base + storm * r^(0.7 + 0.6 h), ghost)`, with `r = exp(-K)`. One `pow` per vertex, the same in `TREE_SNOW_VERT` (every LOD) and `treeSnowLoadAt` (TreeBrush), so near, far and clumps keep matching. The uniform grows from (load, melt, ghost) to (base, storm, r, ghost) plus `melt`, or a second `vec2`.
- the sun side's `melt` already makes south faces of crowns go first.

Per-stand state (a decay texture over the pack, or per-cell loads in Vegetation) would buy wind-exposed ridgeline stands shedding before sheltered gullies. That needs FEAT-060's wind field to mean anything, costs a texture lookup per tree vertex in every LOD, and has to be rebuilt in the far bake path. Not worth it now; revisit with FEAT-060.

**The bakes do not change**: the far impostor and clump shaders bake fixed moderate and heavy masks and blend them by `vSnowLoad` at run time (`materials.ts` line 414, `clumps.ts` line 775), so a decaying load just moves the blend.

**The ground under the trees**: what comes down lands under the crowns as clumps ("snow bombs", the pocked, lumpy surface under trees in the afternoon). A small later term could add chop under the trees as `storm * (1 - r)` grows. Left out of the cards below; note it on the decay card as a possible follow-up.

---

## 5. Visible unloads near the rider

The decay is invisible in itself (the load just drops). What riders notice is a tree letting go beside them. The design reuses FEAT-217 whole:

- **Trigger**: each frame in the forest (stand score over 0.3 at the rider) roll for an event with rate `lambda = LAMBDA * stormLeft * gust` per second, `stormLeft = storm * r` (section 4), `gust = smoothstep(3.5, 5.5, |uWind|)` from `world/Snow.ts` today (its sinusoid peaks about every 48 s), FEAT-060's gusts once they exist, plus a warm term `0.3 * warm * clear * smooth(11, 15, hour)` for the midday drip-and-drop. `LAMBDA` = 0.25 gives a few events a minute at the peak of a windy, loaded morning and none on a bare day.
- **Which tree**: one needled tree (the `HOLDS` species in `TreeBrush.ts`) with load over `LOAD_FROM`, 6 to 35 m from the rider, in front of the camera (within 60 degrees of the view), not shed in the last `RECOVER_S`. Found by walking the loaded trees in a box round the rider: `Vegetation.forEachTree` from #818 does exactly that.
- **What it does**: a new `TreeBrush.unload(hit, share)` beside `slam`: clumps from the upper half of the crown falling to the snow and a fine cloud drifting downwind (the spray ring, under `FRAME_CAP`, spread over frames like a slam), the tree drawn bare through a `uTreeShed` slot (`all` share about 0.5, top tiers first), and the bough thump through `Audio` with gain falling with distance (about 1 / (1 + d / 8)) and a delay of d / 340 s. The `uTreeShed` slots are shared with the rider's brushes, nearest first, so a brush near the rider always wins.
- **Snow bomb on the rider**: if the chosen tree's crown is over the rider (inside 1.5 m), the clumps fall on them: the puff round the camera and a heavier thump. Visual and sound only, no physics.
- **Replays and checks**: events must be deterministic for replays and for `shoot.mjs`: roll from a hash of the replay clock, not `Math.random`, or record the events with the replay. A `?unload=` URL parameter (rate multiplier, 0 off) for testing.

FEAT-356 (#815, forest sound research) covers the quiet under a snowy canopy and the wind in the boughs; the unload thump should come from the same mix it proposes.

---

## 6. What the rider feels and sees

| Situation | Today | With the cards |
|---|---|---|
| Powder day, closed stand vs the open face beside it | same new snow; trees a little deeper (untracked) | trees about two thirds of the open's new snow, but still untracked; more base contact, understory and stumps closer |
| Windy afternoon, high open face vs trees | open face scoured, trees soft (already) | same, plus wind slab skips the trees once FEAT-060 lands |
| Sunny spring afternoon | slush in the trees as in the open | trees softer but less slushy; morning refreeze milder in the trees |
| Trees at 4 pm after a powder morning | still fully loaded | mostly bare on a sunny day, about 60 % gone on a cold one; brushing one drops less |
| Riding through a loaded stand in a gust | nothing | a tree ahead lets go: clumps, a cloud drifting downwind, a thump |
| Tree well round a lone spruce in a glade vs one in timber | the same depth | glade well deeper, timber well shallower |
| Far forest from the chair, afternoon | loaded all day | greys toward bare on the same curve as the near trees |

---

## 7. Cost

| Piece | CPU | GPU | Memory |
|---|---|---|---|
| Interception in the rider | one `CanopyGrid.sample` (4 byte reads, bilinear) per physics step | none | none (grid already loaded) |
| Interception in shrubs, burial, wells | one sample per shrub or tree when its cell builds | none | one float per shrub |
| Shelter | a few multiplies in `snowAt` | none | none |
| Load decay | a few flops per frame in `treeSnowState` | one `pow` per tree vertex, all LODs | one more uniform |
| Visible unloads | one tree walk in a 70 m box per event (a few a minute at most); particles under the existing spray caps | no new draw calls | none |

`perf-check` or `treeperf.mjs vail --gpu` on Drew's PC for the decay card (the `pow` in every tree vertex shader), and the render-budgets run on push.

---

## 8. Open questions for Drew

1. **Climate switch**: all packs are cold continental, so the Colorado numbers. A maritime pack (Mt Hood, Whistler) should have twice the interception loss and snow melting out first under the trees. A pack-level `climate` key from MapPacker (mean winter temperature) or a per-resort constant? Not needed until such a pack exists.
2. **Visible unload rate**: a few a minute at the peak is a guess at "noticeable but not a fireworks show". Drew's call after riding it.
3. **Snow bombs on the rider**: purely cosmetic, or a short whiteout on the camera (it is a real hazard, and it is fun)?
4. **Ground under unloading trees** (more chop as the trees shed): worth a follow-up card?

---

## 9. Proposed build cards (smallest first)

1. **FEAT-360 (#823) Shelter: sun and refreeze skip the trees** (`sim/SnowConditions.ts`). Add `stand` (the canopy grid's score) to `SurfaceInfo`, set in `Rider.ts` beside `canopy` from `pack.canopyAt`. In `snowAt`, scale `sunny` by `1 - CANOPY_SUN * stand` (shared with `world/Sky.ts`) and the spring `refreeze` by `1 - 0.5 * stand`. Add the wind slab gate to FEAT-060's card text. Checks: a new Node check `tools/canopysnowcheck.mjs` (in CI's `PHYSICS_CHECKS`): on the same spot at 15:00 in spring, stand 1 has less slush than stand 0, at 8:00 less ice; stand 0 is unchanged from `main`; `snowcheck.mjs` on Vail locally.
2. **FEAT-363 (#825) The trees shed the storm's snow through the day** (`world/trees/snow.ts`, `RideFrame.ts`). Split the load into base and storm, decay the storm part by `K(hour)` (section 4) with the per-tree rate from the hash in `TREE_SNOW_VERT` and `treeSnowLoadAt`; ghosts excluded; an in-session storm starts its own clock. Checks: `canopysnowcheck.mjs` gains the table in section 4 (within 2 %), full load while storming, ghost unchanged, `treeSnowLoadAt` against the GLSL formula; `treepuffcheck.mjs` (an afternoon brush drops less); stills of a stand at 9:00 and 16:00 after a powder morning, near and from the chair, on Drew's GPU; `treeperf.mjs vail --gpu` for the extra `pow`.
3. **FEAT-367 (#828) Canopy interception: less snow under closed stands** (`sim/Snowpack.ts`, `sim/SnowConditions.ts`, `world/Shrubs.ts`, and #816's `burial.ts` and #818's `TreeWells.ts` once merged). `snowpackDepth` takes the stand score (default 0); the storm part of `powDepth` uses the same held share; shrubs sample the grid once per shrub; burial and wells pass the canopy at the tree base. Build after #816 and #818 merge. Checks: `canopysnowcheck.mjs` gains the interception table in section 2; `shrubcheck.mjs`, `standcheck.mjs` and `wellcheck.mjs` with a canopy (a well in a glade deeper than one in timber, a sapling under closed canopy kept where it would be buried in the open); `snowcheck.mjs` on Vail (powder depth in Steep and Deep's trees below the open bowl on a powder day).
4. **FEAT-369 (#831) Trees let go of their snow near the rider** (`world/TreeBrush.ts`, `audio/Audio.ts`, `states/RideFrame.ts`). `TreeBrush.unload` beside `slam`; the gust and warm trigger of section 5 with a deterministic roll; tree pick through `Vegetation.forEachTree` (#818); distance-scaled thump; the snow bomb when the crown is overhead; `?unload=` rate parameter. Needs card 2 (the load it sheds is the decaying one). Checks: `treepuffcheck.mjs` gains unload checks (no event on a bare day or outside the forest, a forced event sheds the upper crown and takes a `uTreeShed` slot below a rider brush, the same seed and clock give the same events in a replay, no frame over `FRAME_CAP`); a headed ride through a loaded stand on Vail with `?unload=10` on Drew's GPU.

---

## Sources

- Whidden, I. W. (2023). Forest canopy effects on snow depth and density of seasonal and transient mountain snowpack in a maritime snow climate. M.S. thesis, Oregon State University. [Andrews Forest pub 5314](https://andrewsforest.oregonstate.edu/publications/5314)
- Sun, N. et al. (2022). Forest canopy density effects on snowpack across the climate gradients of the western United States. [OSTI 1908324](https://www.osti.gov/pages/servlets/purl/1908324)
- Storck, P., Lettenmaier, D. P. and Bolton, S. M. (2002). Measurement of snow interception and canopy effects on snow accumulation and melt in a mountainous maritime climate, Oregon. Water Resources Research. [CIG summary](https://cig.uw.edu/publications/modeling-snow-accumulation-and-ablation-processes-in-forested-environments/)
- Stottlemyer, R. and Troendle, C. A. (2001). Effect of canopy removal on snowpack quantity and quality, Fraser Experimental Forest, Colorado. [USGS 70023328](https://pubs.usgs.gov/publication/70023328)
- Troendle, C. A. and Reuss, J. O. (1997). Effect of clear cutting on snow accumulation and water outflow at Fraser, Colorado. HESS 1, 325. [hess-1-325-1997](https://hess.copernicus.org/articles/1/325/1997/)
- Colorado Water Conservation Board, forest and snow summary. [CWCB doc 169781](https://dnrweblink.state.co.us/CWCB/0/doc/169781/Page18.aspx)
- Varhola, A., Coops, N. C., Weiler, M. and Moore, R. D. (2010). Forest canopy effects on snow accumulation and ablation: an integrative review of empirical results. Journal of Hydrology 392. [Treesearch 48807](https://research.fs.usda.gov/treesearch/48807)
- Lundquist, J. D. et al. (2013). Lower forest density enhances snow retention in regions with warmer winters. Water Resources Research. [UW news](https://washington.edu/news/2013/11/13/snow-melts-faster-under-trees-than-in-open-areas-in-mild-climates)
- Hedstrom, N. R. and Pomeroy, J. W. (1998). Measurements and modelling of snow interception in the boreal forest. Hydrological Processes 12. Summarised in [Lv and Pomeroy 2020](https://research-groups.usask.ca/hydrology/documents/pubs/papers/lv_pomeroy_2020.pdf)
- Lundquist, J. D. et al. (2021). Snow interception modelling: isolated observations have led to land surface models lacking appropriate temperature sensitivities. Hydrological Processes. [PDF](https://www.co.chelan.wa.us/files/natural-resources/documents/Lundquist%20et%20al%202021%20-%20Snow%20interception%20modelling%20-%20Isolated%20observations%20have%20led%20to%20LSM%20lacking%20appropriate%20temperature%20sensitivities.pdf)
- Lumbrazo, C. et al. (2022). Evaluating multiple canopy-snow unloading parameterizations in SUMMA with time-lapse photography characterized by citizen scientists. Water Resources Research. [NASA Snow summary](https://snow.nasa.gov/pubs/2022/evaluating-multiple-canopy-snow-unloading-parameterizations-summa-time-lapse-photography)
- Unloading of intercepted snow in conifer forests (M.Sc. thesis, University of Saskatchewan, 2010). [HARVEST](https://harvest.usask.ca/handle/10388/etd-09302010-145706?show=full)
- EGU26-15976 (2026), canopy snow unloading model evaluation. [Abstract](https://meetingorganizer.copernicus.org/EGU26/EGU26-15976.html)
- Avalanche.org encyclopedia: wind sheltered terrain. [Link](https://avalanche.org/avalanche-encyclopedia/terrain/slope-characteristics/wind-exposure/wind-sheltered/)
- Colorado Avalanche Information Center: wind slab. [Link](https://avalanche.state.co.us/wind-slab), [problem guide PDF](https://cloudfront.avalanche.state.co.us/wp-content/uploads/2015/10/avchar-windslab.pdf)
- The role of forest in slab avalanche formation (course slides citing Schneebeli and Meyer-Grass 1992; secondary). [Prezi](https://prezi.com/k-s9eidomp2g/the-role-of-forest-in-slab-avalanche-formation)
