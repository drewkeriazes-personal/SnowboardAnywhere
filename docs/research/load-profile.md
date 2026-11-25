# Resort load profile (FEAT-377)

What a reload of Vail does from navigation to sim ready (`window.__sim`, the frame loop starting) and on to menu live
(the main menu's crossfade to the live view, after which RIDE goes), what each step cost, and what was cut. Measured
2026-11-24 on Drew's PC (RTX 2070 SUPER, ANGLE D3D11, headless on the GPU, 1920 x 1080) with
`node tools/loadperf.mjs vail --gpu` at `/?pack=vail&x=1611&y=-3997&h=37`, the loads served by the tool's own plain
server (no HTTP caching, so every load downloads the pack; FEAT-375's 304s make the downloads cheaper still). Other
work shared the PC (CPU about 50% busy), so single runs swing by a second or two: the numbers are medians of 3 warm
reloads, and the per-step table is one representative warm run. The step names are the `load: <step>` measures
(`src/core/loadSteps.ts`), split further with `--profile` (sampled JavaScript to sim ready).

## Before (main 8823694, High preset)

Warm reload: sim ready 13.6 s, menu live 20.0 s (median of 3). Cold (fresh profile): 23.2 s and 31.2 s.
Medium preset (the shipped default): warm 7.9 s and 14.9 s, cold 13.1 s and 19.8 s.

Ranked, one warm run on High (sim ready 12.0 s, menu live 20.0 s; ms of wall time):

| # | Step | ms | What is in it |
|---|------|---:|---------------|
| 1 | Streaming behind the menu (`stream until settled`) | 8 600 | about 140 passes, each waiting for an animation frame that a page with no frame loop does not get (the 50 ms timer instead): terrain chunk builds 1 900 (about 1 050 chunks, a third of it the ridge test's four extra height reads per vertex), the near trees regathered on every pass a cell landed 1 250, tree cells (trunk colliders 300, `prepare` 200), stand images decoded with a blocking GPU readback 300 to 1 700, stem areas and stems generated about 600, height and mask tile decodes on the main thread about 500, the roads' first rebuild 275 |
| 2 | Menu live after sim ready | 8 000 | the menu's 8 s cap every time: the warm-up streamed the chase camera's view at the start, not the menu shot (`setEye` only placed the camera on the next frame), and the first frame's mogul season (the shot's month) rebuilt about 650 1 and 2 m chunks at 10 a frame |
| 3 | World build (`world`) | 1 600 | roads 360 (built before any tile, then rebuilt), buildings 300, cloud noise 300 (made on the CPU every load), trees 150, bridges 50, the impostor bake 35 (110 cold), the rest about 400 |
| 4 | Fine tile under the start | 660 | the warm-up waited for it after the world was built; the start's tiles were only requested then |
| 5 | Tree lines | 590 | the cover levels' decode (a blocking GPU readback) and the baked lines' fetch and parse, before the world builds |
| 6 | First frames (in menu live) | 1 300 | shadow programs compiled on first use (`getProgramInfoLog`), the minimap's hillshade 400, uploads |
| 7 | Shader compile (`compile shaders`) | 190 | 8 300 cold: the GPU's shader cache is empty |
| 8 | Pack meta, features, menu shots and still, the menu's paint | 100 | |

## Cuts, in order of payoff

All keep the result the same. Checked by hashing every terrain chunk's vertex arrays and every tree cell's records
after the warm-up (cold build, restored build and before each change: identical bits), and with before / after stills
against main (`tools/compare.mjs`, a chase and an aerial at Steep and Deep: below the horizon a mean difference of 0.04
and 0.004 levels; the clouds' start time and the spray are random per load).

| Cut | Kind | Saves (warm, High) |
|-----|------|-------------------:|
| The menu's warm-up streams the shot it shows (`setEye` places the camera at once) under the shot's conditions (`RideFrame.snowDay(0)` before the stream) | do less | menu live about 8 s |
| Terrain kept between loads (`Terrain.snapshot` / `restore`, `terrain/chunkSave.ts`) | save | 1.8 to 2 s |
| Streaming passes go again after the queued tasks, not a frame later; the near trees gather once the cells have landed (`holdNear`) | do less | 1.2 s of gathers, and the frame waits |
| Tree stems and stem areas kept (`world/trees/savedStems.ts`): no stand image fetched or decoded | save | 0.9 s |
| Cover levels and stand images read back from the GPU asynchronously | overlap | 0.5 s |
| Start tiles requested before the world builds; the menu's warm-up does not wait for the start's tile | overlap | 0.5 s |
| Height tiles and greyscale masks decoded in three workers (`pack/tileDecode.ts`) | overlap | 0.4 s of main thread |
| Ridge test reads a coarse chunk's own grid neighbours | do less | 0.3 to 0.4 s (cold too) |
| Roads first built when a tile lands or on the first frame | do less | 0.3 s |
| Cloud noise kept | save | 0.3 s |

Left: the shader compile on a cold GPU cache (8 s cold, a driver cost; `compileAsync` already compiles in parallel),
the first frame's shadow programs and minimap hillshade (after sim ready; deferring the hillshade moves a 0.4 s hitch to
the RIDE press), the cover levels' decode inside `tree lines` (saving it would take 75 MB of disk), the tree cells'
colliders and `prepare`, the buildings and the ghosts.

## After (High preset)

Warm reload: sim ready 5.5 s, menu live 7.7 s (median of 3; 4.2 s and 5.7 s in a quieter moment). Cold: 20.8 s and
22.6 s, no slower than before (the compile is most of it). Medium (shipped default): warm 3.5 s and 4.9 s, cold 11.4 s
and 12.8 s.

Disk (Keep built resort data, Vail): terrain 42.6 MB, tree stems 6.7 MB on Medium, cloud noise 0.5 MB; the browser
counts 33 MB for the origin (IndexedDB compresses).
