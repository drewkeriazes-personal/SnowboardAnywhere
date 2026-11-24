# Forest sound: quiet under the snowy canopy, wind in the boughs

Researched 2026-11-23 for FEAT-356 (#815). Part of EPIC-01 (#441). Read with `docs/research/canopy-snow.md` (FEAT-354 and FEAT-355, PR #822), which picks the same canopy number and sets up the gusts and the snow bombs this sound has to match.

**The picks, in short**

1. **Stay procedural.** Every sound in the game today is synthesised from one looping 2 s white noise buffer, oscillators, biquads and a waveshaper (`game/src/audio/Audio.ts`, `ChaseAudio.ts`); there is not one sample file and no reverb node. The forest bed fits that: noise layers, a stick-slip creak, one generated impulse response. No sample licensing to manage.
2. **The quiet is a contrast, so the open needs wind first.** Today nothing sounds at rest in the open (the only wind is the rider's own speed, `windLo` and `windHi`), so there is nothing for the forest to be quiet *against*. The bed is two layers on one wind number: a low buffeting *ear wind* that fades out as the stand closes (wind at head height drops from about 10 m/s in the open to under 1 m/s in a forest), and a *bough sough* overhead that fades in with the stand, its pitch set by the wind over the needles.
3. **The canopy number is the stand score at the listener**, the 10 m canopy grid (`Pack.canopyAt`, FEAT-330) already smoothed once a frame in `world/Sky.ts` (`env.canopy`), not the 1 m mask's `s.canopy`. That is the number #822 picks for stand effects, it follows the camera when it is detached (like the listener), and it costs no new lookup.
4. **A wind clock that always runs.** The only wind today, `world/Snow.ts` `uWind`, stops advancing when no flakes fall (`Snow.update` returns while `points.visible` is false, which is every weather but storm and flurries). A tiny shared `world/wind.ts` (base speed per weather times Snow.ts's own gust curve, on the session clock) feeds the sound, the flakes and FEAT-369's unload trigger, and is the seam FEAT-060 (#93) replaces.
5. **Reverb: none in the open, a short dark tail in the trees.** The measurements say the opposite of "less reverb in the forest": trunks scatter sound into a measurable tail even over thick snow (Li, Meng and Kang 2022), while an open snow slope reflects almost nothing (fresh snow's reflection coefficient is under 0.1). So the open stays dry as today, and under a stand the rider's own sounds get a short (about 0.6 s) tail from one `ConvolverNode` with a generated IR. Fresh snow makes that tail quieter and darker; ice and hardpack make it longer-sounding and brighter, with a small high shelf on the rider's own sounds.

Three build cards at the end, smallest first: FEAT-370 (#835), FEAT-371 (#836), FEAT-372 (#837).

---

## 1. What the game does today

### The audio graph

`GameAudio.start()` (`audio/Audio.ts` lines 85 to 170) builds everything on the first user gesture:

- `master` to the destination, `sfx` (effects volume, silenced while paused by `setDuck`) and `musicGain` through `musicFilter` (the Outrun low-pass) into `master`. The graph is mono apart from `ChaseAudio`'s HRTF `PannerNode` for the monster.
- One 2 s white noise `AudioBuffer` (`noiseBuf`), looped by every noise source. `layer(type, freq, q)` is a looping source through one `BiquadFilterNode` into a `GainNode` at 0 into `sfx`. Continuous layers: `flowGroom`, `flowPow`, `flowHard`, `flowCrust`, `carveToe`, `carveHeel`, `skidL`, `windLo` (lowpass 300 Hz), `windHi` (bandpass 2.4 kHz, Q 6), `breath`, `rockBody`, plus the oscillators `rumble` (triangle 42 Hz) and the lift hum (sawtooth 55 Hz through 180 Hz lowpass).
- FEAT-328's rock scrapes: generated click trains (heavy-tailed sizes, 260 or 450 clicks a second) through banks of resonant bandpasses and a tanh `WaveShaperNode` (lines 113 to 151).
- One-shots: `burst(type, freq, dur, gain, q, sweep)` (a filtered noise slice with an exponential decay, fresh nodes each call, lines 338 to 348) and `tone(freq, dur, gain, type, glide)` (an oscillator with a decay), each picked from three variants with +-8 % jitter.

So about 20 sources run all the time at gain 0 when unused, and `update()` (lines 481 to 565) sets gains and cutoffs once a frame by writing `.value` with a `k = dt * 12` ease. There is no `ConvolverNode`, `DelayNode` or reverb anywhere in `game/src`.

### The forest sounds that exist

- **Branch brush**: `brush()` (line 388), a 0.12 s highpass burst at 2.5 to 4 kHz, every 0.4 to 2 s while `s.canopy > 0.5` and speed over 6 m/s (line 558). `s.canopy` is the 1 m surface mask's alpha, set per physics step in `sim/Rider.ts` line 498 (`this.surface.canopy = m[3]`). Right for its job (branches at the board). BUG-152 (#758, a stray tick every few seconds) suspects this one.
- **Shrub brush** (FEAT-159, `shrubBrush`, line 390) from `s.shrub`.
- **Snow off a bough** (FEAT-217): `TreeBrush.update` (`world/TreeBrush.ts`) returns the puff strength and `RideFrame.ts` line 242 calls `audio.treePuff(k)`: a low thump (lowpass 190 to 250 Hz, 0.2 to 0.25 s) and a sift (bandpass 1.6 to 2.5 kHz sweeping down to 700 Hz over 0.45 to 0.75 s) (`Audio.ts` line 396).
- **Tree crack** (Outrun): `ChaseAudio.crack()`, a highpass 2.2 kHz snap, a 140 Hz square drop and a 400 Hz lowpass tail, from the `treeCrack` event (`session/eventSources.ts` line 36).
- The crust crackle is cut to 0.3 under `s.canopy > 0.3` (line 495), the one place the canopy already shapes the mix.

### The canopy numbers

| Number | Where | Scale | Read by |
|---|---|---|---|
| `s.canopy` | `sim/Rider.ts` line 498, mask alpha | 1 m, at the rider | brush, crust, `snowAt`, the HUD's "in the trees" |
| `pack.canopyAt(x, y)` | `pack/CanopyGrid.ts` (FEAT-330) | 10 m, "how closed and tall overhead" | the light, once a frame |
| `env.canopy` | `world/Sky.ts` `updateCanopy`, called at `states/RideFrame.ts` line 292 | the above at the viewer (rider, or the camera when detached), eased at `CANOPY_RATE` 1.5 / s (about 2 s), set at once after a jump over 150 m | the light |

`audio.update` runs at `RideFrame.ts` line 178, before `updateCanopy` at line 292, so it reads last frame's `env.canopy`: one frame late, inaudible. A pack without `canopy.png` reads 0; the forest bed then falls back to a smoothed `s.canopy` (see section 4).

### The wind

- `world/Snow.ts` line 81: `uWind = (3 + 2.5 sin(0.13 t), 1.2 sin(0.07 t + 1))` m/s in three.js x and z, so `|uWind|` swings between about 0.5 and 5.6 m/s with a period near 48 s. It is the flakes' drift and is also read for the lee side of boulders (`rocks.setSnow`, `RideFrame.ts` line 368).
- `Snow.update` returns at once when `points.visible` is false (line 75), and `Session.ts` line 179 shows the flakes only in storm and flurries. On every other day `snow.wind` stays at its initial (2, 1), `|uWind|` = 2.24 m/s, frozen.
- FEAT-060 (#93), the real wind field (per weather, gusting, stronger on ridges, calm in trees), is open and unbuilt.

---

## 2. What the sources say

### Snow and sound

- Fresh snow is an acoustically soft, open-celled porous layer: measured effective flow resistivity of natural snow covers is 11 to 31 kPa s m^-2 (Albert and Hole 2001; Albert's inversions across 11 snow covers), against about 345 for a grass field; two late-season covers came out at 60 and 140, and wind-packed Arctic snow is higher still (NILU report). Higher flow resistivity is harder and more reflective.
- Fresh snow reflects very little: ultrasonic reflection coefficients under 0.1 at normal incidence, and one day of sintering raises them measurably at every angle; large-grained old snow and firn reflect over 0.2 (Lieblappen, Fegyveresi, Courville and Albert 2020).
- Impedance tube absorption of snow from 125 Hz to 1.6 kHz over porosities of 46 to 90 % fits Wilson's relaxation model (Maysenhölder et al. 2012); above about 500 Hz the absorption is mostly damping in the pores. Popular summaries put fresh snow's absorption coefficient at 0.5 to 0.9, falling as it settles, melts or ices (the AccuWeather article on the card; it blocks automated fetching, so the range is quoted from the card).
- The "quiet after a snowfall" that people notice at a distance is mostly ground effect and absorption over tens of metres. A rider's own board is at the ground and the ear about 1.6 m above it, so the direct sound is barely changed by the snow it rides on; what changes is everything that arrives later (reflections off the slope, trunks and other surfaces) and how loud the background is. The design below puts the effect there, and keeps any filter on the direct sound small and labelled as a game choice.

### Forests and sound

- Trunks scatter. In a pine forest, high-frequency attenuation and the reverberation below the canopy are dominated by multiple scattering among the trunks (Huisman and Attenborough 1991). Denser forests reverberate longer, and from 1 to 3 kHz the reverberation changes little with distance (Padgham 2004).
- Over thick snow (the day after heavy snow, -24 C, wind under 2 m/s) stands still reverberate measurably: T20 is low below 200 Hz, rises steeply from 200 to 400 Hz and is flat or falls slightly above; older, rougher, denser stands ring longest; T20 grows from 10 to 20 m range (Li, Meng and Kang 2022). The figures with the values are images; read them from the paper before tuning.
- Wind: Schneebeli and Meyer-Grass (1992), as quoted in `canopy-snow.md` section 3, give about 10 m/s in the open, 0.9 m/s in a sparse forest and 0.1 m/s in a dense one (secondary source, indicative).
- Wind noise from conifers is flow separation round the needles (aeroacoustic dipoles), so its spectrum moves up with wind speed; measured and predicted coniferous tree sound sits around 40 to 50 dB over 50 Hz to 4 kHz at the two speeds on the KTH poster, and the semi-empirical model holds to 8.5 m/s (Bolin 2009; Fégeant's earlier model). A needle 1 to 2 mm thick shedding at a Strouhal number near 0.2 gives `f = 0.2 U / d`, about 130 U Hz for d = 1.5 mm: 400 Hz at 3 m/s, 900 Hz at 7 m/s (reasoned from the mechanism, not measured).

### Game audio practice

- Farnell, *Designing Sound*, Practical 18 (wind), the standard procedural recipe and the one this graph already follows: white noise for the body, a gust generator of noise low-passed twice at 0.5 Hz, squalls from noise low-passed at 3 Hz switched in above a speed threshold, a howl through a resonant filter (1 kHz, Q 60) swept 600 to 1000 Hz by speed, and a leaves layer of noise through a 200 Hz highpass and a 4 kHz lowpass with slow (0.07 Hz) smoothing. Each source sits at its own pan position.
- Creaks in the same book are stick-slip friction: a train of pulses whose rate wanders, ringing a body's resonances (Farnell's creaking door). It is how the game already does the board creak (`creak()`, a sawtooth glide plus a narrow bandpass burst).

---

## 3. The layers

All gains below are starting points, set against today's mix: `flowGroom` idles at 0.05 and the speed wind `windLo` reaches its 0.5 cap near 30 m/s. Every number marked *guess* is for tuning by ear on Vail.

### Inputs (once a frame, no new sampling)

```
stand = max(env.canopy, 0.8 * canopy1m)     // canopy1m: s.canopy eased over 2 s, for packs without canopy.png
U     = wind.speed(t, weather)               // m/s above the canopy, world/wind.ts
gust  = wind.gust(t)                         // 0..1, the swell
load  = treeSnowUniforms.uTreeSnow.value.x   // snow on the boughs (FEAT-157; FEAT-363 makes it decay)
soft  = clamp(sn.powder + newSnow)           // fresh, open-celled snow under the rider
hard  = clamp(sn.ice + 0.5 * sn.chop)        // ice, crust
```

`world/wind.ts` (new, a few lines): `speed = BASE[weather] * (0.6 + 0.4 * gust)`, with `BASE` = off, cirrus and few 2; scattered 3; broken and overcast 4; flurries 5; storm 8 m/s (*guess*, FEAT-060 replaces it), and `gust` = `|uWind(t)| / 5.6` from Snow.ts's own curve, run on the session clock so it moves on clear days too. `Snow.update` reads its `uWind` from the same function, so the flakes do not change. A `?wind=` URL parameter forces the speed for checks.

### 3.1 Ear wind (the open)

The wind round the head when you are standing or riding slowly in the open, missing today.

- One noise layer, lowpass, cutoff `150 + 20 U` Hz, Q 0.7, plus Farnell's squall: a second gain driven by a 3 Hz smoothed random walk above U = 5 m/s.
- Gain `min(0.2, 0.003 * U^2) * (1 - stand)^2`. The square on the stand follows the wind speed falling about tenfold into a forest (section 2); the square on U is the usual dynamic pressure scaling (*guess*).
- On a lift: full (exposed), not ducked like the speed wind.

### 3.2 Bough sough (the stand)

The sound from above, not round the ears.

- Two noise sources started at different offsets in the buffer (decorrelated), each a bandpass at `fc = clamp(130 U, 300, 1600)` Hz with Q 0.5, through a `StereoPannerNode` at -0.6 and +0.6. A third, shared, lowpass at 220 Hz for the trunk-sway roar at 0.4 of the band's gain.
- A lowpass after them at `4000 - 2000 * load` Hz: snow-laden boughs are stiffer and the snow damps the needles, so a loaded forest sighs darker and lower (reasoned).
- Gain `0.10 * stand * min(1, U / 8)^1.5 * (1 - 0.4 * load) * swell`, `swell` 0.6 to 1 from Farnell's 0.5 Hz gust walk, each side on its own walk so the swell moves across the canopy (*guess*). At 0.1 it sits under the board at speed and becomes the main sound when you stop in the trees.
- `fc` and gains ramp with `setTargetAtTime(..., 0.3)` rather than the per-frame `.value` ease, so a frame hitch never steps the pitch.

### 3.3 The odd creak

- A one-shot `boughCreak()`: a sawtooth whose rate wanders 25 to 70 Hz (the stick-slip pulse rate) through two bandpasses at 350 to 900 Hz and 1.6 times that, Q 6; attack 0.08 s, hold 0.3 to 1 s, release 0.2 s; gain 0.02 to 0.05; a random pan within +-0.8; sent to the forest tail (3.4) so it sounds a few trees away.
- Rate: Poisson, `0.03 * stand * smoothstep(3, 7, U)` per second, so about one every 30 to 60 s in a closed stand on a windy day and none in the open or in still air. Fired on a gust's rising edge when one is due, so it lands with the swell (*guess*).
- `Math.random` is fine: replays do not need the same audio. Cold-weather frost cracks (a rifle-shot snap) are rare enough to leave out.

### 3.4 The rider's own sounds under the canopy

A new `self` bus between the rider layers and `sfx`: flow, carve, skid, rock, breath, footsteps and the one-shots from `burst` and `tone` route through it (the jukebox, chase bus, chimes and the wind layers do not).

- **High shelf** at 3.5 kHz on the self bus: `-4 dB * stand * soft + 2 dB * hard`. A small, deliberate game cue (the direct sound barely changes in reality, section 2): powder in the trees reads hushed, ice reads hard and bright anywhere. Today's surface layers already carry most of the difference; the shelf only tilts them.
- **Forest tail**: a send from the self bus (and the creaks and FEAT-369's thumps) into one `ConvolverNode`, wet return through a lowpass and a gain into `sfx`.
  - IR generated once in `start()`: 2 channels (decorrelated noise, so the mono input comes back wide), 0.8 s long, 15 ms of silence first (trunks 3 to 7 m away), an exponential decay for T60 = 0.6 s (*guess*, to read against Li et al.'s figures), a 200 Hz highpass baked in (their T20 is low below 200 Hz). `normalize = false`, scaled by hand. 76,800 floats, built in about a millisecond.
  - Wet lowpass `2500 + 3500 * hard - 1000 * soft` Hz (clamped 1.5 to 6 kHz) and wet gain `0.12 * stand * (1 - 0.5 * soft) * (1 + 0.3 * hard)`: fresh snow on the ground and boughs eats the tail's top and level, ice and crust give it back.
  - The open gets no tail at all (stand 0), which is what an open snow slope does.
- Why a convolver and not a feedback delay network: one node, a smooth diffuse tail from noise, and every live control (length by level, tone by the wet lowpass) sits outside it, so the IR never has to be rebuilt. A four-delay FDN of `DelayNode`s with a lowpass in the loop is the fallback if the convolver costs too much on the Low preset.

### 3.5 Lined up with FEAT-369 (snow bombs, #831) and FEAT-363 (#825)

- **One wind.** #831's trigger `gust = smoothstep(3.5, 5.5, |uWind|)` from `world/Snow.ts` is frozen at 2.24 m/s on every day without flakes (section 1), so it would never fire on a clear windy morning. It should read `world/wind.ts` instead; then the bough sough swells and, now and then on the same gust, a tree lets go.
- **The thump through this mix**: FEAT-217's `treePuff` thump and sift, with #831's distance gain `1 / (1 + d / 8)` and delay `d / 340` s, panned by the tree's bearing from the camera (a `StereoPannerNode` per one-shot, pan = sin of the bearing), the sift lowpassed by distance (`2500 - 40 d` Hz), and sent to the forest tail with a send that grows with distance (`0.2 + 0.02 d`, so a far unload is mostly tail). A crown overhead (the snow bomb on the rider) is the existing `treePuff` at full gain, dry, plus a 60 Hz `tone` for weight.
- **Load**: the sough's darkening reads the same `uTreeSnow` load that FEAT-363 decays through the day, so an afternoon forest after a powder morning sighs brighter as it goes bare.
- **Canopy**: the same stand score #822 adds as `SurfaceInfo.stand` (FEAT-360, #823). Audio reads `env.canopy` (the listener's), the physics reads the rider's; they agree whenever the camera is on the rider.

---

## 4. Cost

| Piece | Main thread, per frame | Audio thread |
|---|---|---|
| Inputs | none new: `env.canopy` and the 1 m canopy are already computed; one ease for the fallback, a sin for the wind | none |
| Ear wind, sough | about 10 `AudioParam` writes (the same pattern as the 20 layers today) and two random walks | 4 looping buffer sources, 5 biquads, 2 stereo panners: each a handful of multiply-adds a sample, well under 1 % of a core together (reasoned) |
| Creaks | one Poisson roll | an oscillator, 2 biquads and a panner for about a second, once a minute |
| Self bus shelf | one write | 1 biquad |
| Forest tail | two writes | one `ConvolverNode`, 0.8 s stereo IR: FFT partitioned convolution; Chromium has run the longer tail stages on background threads for real-time contexts (an older `ConvolverNode.cpp`; check the current source). Estimate 1 to 3 % of one core (*guess*), the one item to measure |

Measure with the `perf-check` skill on Drew's PC: a DevTools trace riding into a Vail stand with `?forest=0` against the default, reading the audio rendering thread's busy time, and the Low preset on the MacBook from BUG-145 if it is to hand. If the convolver shows, mute its send below stand 0.05 (Chromium skips a node's processing once its input has been silent past its tail time) and, failing that, swap to the FDN. One-time cost: the IR (about 1 ms) and three more nodes at start.

---

## 5. Licensing

Nothing to license: all of it is synthesised, like the rest of the game's sound. If a sample is ever wanted (a recorded creak, a real sough bed), take CC0 only (Freesound's CC0 filter, the same rule as the ambientCG rock textures), add a row to `docs/research/licensing-and-attribution.md` and a credit line, and avoid "royalty free" bundles whose terms forbid redistributing the raw files, since this repo is public and ships them as files.

---

## 6. Open questions for Drew

1. **Base wind per weather** (2 m/s on a clear day to 8 in a storm) is a placeholder until FEAT-060. Calm bluebird days, or always a breeze?
2. **The high shelf on the rider's own sounds** is a game cue rather than physics. Keep it, or let the tail and the bed carry the forest on their own? An A/B with `?forest=` on Vail would settle it.
3. **Ear wind on the lift**: full exposure (real) could crowd the music; duck it like the speed wind?

---

## 7. Proposed build cards (smallest first)

1. **FEAT-370 (#835) Wind you can hear: open-air ear wind and the bough sough in the trees** (`world/wind.ts` new, `world/Snow.ts`, `audio/Audio.ts`, `audio/forestMix.ts` new, `states/RideFrame.ts`). Add the always-running wind clock (section 3, inputs) and have `Snow.update` read its `uWind` from it; add the ear wind (3.1) and the decorrelated, panned sough (3.2) to `GameAudio.start`; pass `{ stand, U, gust, load }` from `RideFrame` into `audio.update` (stand from `env.canopy`, the 1 m canopy as fallback). The mix is a pure function `forestMix(inputs) -> { gains, cutoffs }` in `audio/forestMix.ts` so it can be checked in Node; `?wind=` and `?forest=0` URL parameters; `README.md` unchanged, `docs/developer-guide.md` gets the parameters. Checks: a new Node check `tools/forestmixcheck.mjs` in CI's `PHYSICS_CHECKS` (sough 0 at stand 0, ear wind falls at least 80 % from stand 0 to 1, sough centre 400 Hz at 3 m/s and 900 Hz at 7, a loaded forest darker than a bare one, the wind clock moving on a clear day and the flakes' `uWind` unchanged from `main` in a storm); `npx tsc --noEmit`; a headed ride on Drew's GPU from the open Back Bowls into the trees on Vail, standing still in each, with Drew listening.
2. **FEAT-371 (#836) The odd creak in the trees on a windy day** (`audio/Audio.ts`, `audio/forestMix.ts`). `boughCreak()` (3.3) on the card-1 wind and stand, a Poisson rate on the gust's rising edge, a random pan. Needs card 1. Checks: `forestmixcheck.mjs` gains the rate (0 in the open and in still air, about 0.03 a second in a closed stand at 8 m/s, within 10 % over a simulated 10 minutes with a fixed seed); a headed stop in a Vail stand with `?wind=8` on Drew's GPU.
3. **FEAT-372 (#837) The rider's own sounds in the forest: a short dark tail, a hushed or bright edge** (`audio/Audio.ts`, `audio/forestMix.ts`). The `self` bus and routing, the high shelf, the generated 0.8 s stereo IR and the `ConvolverNode` send with its wet lowpass and gain (3.4); `treePuff` and the FEAT-369 thump take a send and a pan. Checks: a browser check `tools/forestaudiocheck.mjs` in CI's `BROWSER_CHECKS` that renders the graph in an `OfflineAudioContext` (no GPU needed): no wet energy at stand 0, the tail's measured T60 within 15 % of 0.6 s, the tail's spectral centroid on ice above that on powder, the shelf at -4 dB on powder in a closed stand; `forestmixcheck.mjs` gains the shelf and wet values; `perf-check` on Drew's PC (audio thread with `?forest=0` against default, section 4) with the numbers in the PR; Drew's ear on Vail on a powder day and an icy spring morning.

FEAT-369 (#831) gets a comment instead of a card: take the gust from card 1's `world/wind.ts`, and route its thump as in 3.5.

---

## Sources

- Code: `game/src/audio/Audio.ts`, `game/src/audio/ChaseAudio.ts`, `game/src/world/Snow.ts`, `game/src/world/Sky.ts`, `game/src/world/TreeBrush.ts`, `game/src/pack/CanopyGrid.ts`, `game/src/sim/Rider.ts`, `game/src/sim/SnowConditions.ts`, `game/src/states/RideFrame.ts`, `game/src/session/Session.ts`; `docs/research/canopy-snow.md` (PR #822); issues #93, #823, #825, #831.
- Li, Meng and Kang (2022), [Sound attenuation by trunks in the ground with thick snow](https://discovery.ucl.ac.uk/id/eprint/10172662/1/ICA_2022_template_final_ABS-0152.pdf), ICA 2022.
- Albert, [Snow cover effects on impulsive noise propagation in a forest](https://www.ioa.org.uk/system/files/proceedings/dg_albert_snow_cover_effects_on_impulsive_noise_propagation_in_a_forest.pdf), IOA proceedings (from the card; the link returned 404 on 2026-11-23).
- Albert and Hole (2001), Blast noise propagation above a snow cover, JASA 109(6) 2675 to 2681 ([index entry](https://acnpsearch.tweb-dev.unibo.it/singlejournalindex/87070725)); flow resistivity range across snow covers ([ASA 1994 abstract](https://auditory.org/asamtgs/asa94aus/3aPAa/3aPAa14.html)); wind-packed Arctic snow ([NILU report](https://nilu.com/dnn-file/41-2002-lrh/?ext=pdf)).
- Lieblappen, Fegyveresi, Courville and Albert (2020), [Using ultrasonic waves to determine the microstructure of snow](https://frontiersin.org/journals/earth-science/articles/10.3389/feart.2020.00034/pdf), Frontiers in Earth Science 8:34.
- Maysenhölder, Heggli, Zhou, Zhang, Frei and Schneebeli (2012), Microstructure and sound absorption of snow, Cold Reg. Sci. Technol. 83-84, 3 to 12 ([record](https://publica.fraunhofer.de/handle/publica/228468)); Capelli et al. (2016), [Speed and attenuation of acoustic waves in snow](https://www.slf.ch/fileadmin/user_upload/WSL/Mitarbeitende/schweizj/Capelli_etal_Acoustics_waves_snow_CRST_2016.pdf).
- [AccuWeather: why it becomes so quiet after a fresh snowfall](https://www.accuweather.com/en/weather-news/why-does-it-become-so-quiet-after-a-fresh-snowfall/70000676) (from the card).
- Huisman and Attenborough (1991), Reverberation and attenuation in a pine forest, JASA 90, 2664 to 2677, doi:10.1121/1.401861 ([abstract](https://data.zhenzhi.com/details/1/993718255)); Padgham (2004), Reverberation and frequency attenuation in forests, JASA, doi:10.1121/1.1629304 ([abstract](https://data.zhenzhi.com/details/1/876875671)).
- Bolin (2009), [Prediction method for wind-induced vegetation noise](https://www.ingentaconnect.com/contentone/dav/aaua/2009/00000095/00000004/art00003), Acta Acustica united with Acustica 95(4); [KTH MWL poster](https://www.mech.kth.se/flow-old/FLOWposters/poster_MWL_Linne.pdf) (coniferous tree sound spectra, needle flow separation).
- Schneebeli and Meyer-Grass (1992) wind in forests, via [this course summary](https://prezi.com/k-s9eidomp2g/the-role-of-forest-in-slab-avalanche-formation) (secondary).
- Farnell, *Designing Sound* (MIT Press 2010), [Practical 18: wind](https://mitp-content-server.mit.edu/books/content/sectbyfn/books_pres_0/8375/designing_sound.zip/practical18.html); a Max port explaining the gusts ([Designing Sound](https://designingsound.org/2013/04/designing-ambiences-in-maxmsp/)).
- Web Audio: [MDN ConvolverNode](https://developer.mozilla.org/en-US/docs/web/api/convolvernode); [W3C convolution notes](https://www.w3.org/TR/2015/WD-webaudio-20151208/convolution.html); [Chromium ConvolverNode.cpp](https://chromium.googlesource.com/chromium/blink/+/376dc6e/Source/modules/webaudio/ConvolverNode.cpp) (background threads for real-time contexts, an older snapshot).
