# Road Centerline Refinement — Spec

## Goal

Given OpenStreetMap road geometry and aligned satellite imagery, produce a road graph whose centerlines sit on the middle of each road in the imagery, resampled into constant-length slices. Humans annotate corrected geometry; two models learn to reproduce that correction automatically:

- **Model A** handles intersections: it decides each intersection's type and provides the evidence for fitting a parameterised template to it.
- **Model B** handles the road between intersections: it predicts sideways offsets of the centerline and, with a separate profile head, the road's **cross-section**: lanes and their use, markings, kerbs, cycle lanes, parking and sidewalks (see [Road cross-sections](#road-cross-sections)).

## Terminology

| Term | Meaning |
|---|---|
| **Junction** | An OSM node shared by 3+ ways (an intersection) or used by only one way end (a dead end). Nodes where exactly two ways join end to end are **not** junctions; those ways are merged into one segment. |
| **Cluster** | A group of junctions that form one physical intersection (e.g. all entries of a roundabout, or the 4 junctions where two dual carriageways cross). Every junction belongs to exactly one cluster. |
| **Template** | A parameterised geometric model of a cluster (see [Templates](#templates)). OSM provides its topology; the fit provides its geometry. |
| **Arm** | One road leaving a cluster. Carries one carriageway, or two for a dual carriageway. |
| **Port** | The point where one carriageway leaves a cluster's cut-out: a position plus a heading. Each port belongs to exactly one OSM segment. |
| **Cut-out** | The region a template owns: its core plus each arm up to its port. Model B makes no predictions inside it. |
| **Segment** | The road between two ports (or a port and a dead end), following OSM geometry. Segments are handled by Model B. |
| **Guide line** | The OSM polyline for a segment, clipped to its ports and transformed to fit them (Stage 2). Used for direction and arc length only, not as output. |
| **Piece** | A stretch of guide line between two pinned points during Stage 3. A segment starts as one piece and is split in half repeatedly. |
| **Split point** | The arc-length midpoint of a piece, placed by Model B and then pinned. |
| **Pinned point** | A point that no longer moves during splitting: a port, or a split point that has been placed. |
| **Blend band** | The stretch of a segment from its port out to `b` metres, where template and Model B geometry are blended (Stage 4). |
| **Slice** | A constant-length piece (`ℓ` metres) of the final centerline. Its two end nodes are shared with neighbouring slices. The last slice of a curve covers the remainder (`< ℓ`). |
| **Sideways offset** | Signed distance perpendicular to the local road direction. Positive = left of travel direction. |
| **Cross-section** | What the road looks like across its width at one point: an ordered list of bands, left to right in the segment's direction, separated by boundaries. |
| **Band** | One strip of the cross-section with a kind (lane, parking, sidewalk…), kind-specific attributes and a width. Widths may be zero. |
| **Boundary** | The edge between two neighbouring bands, or at the outside of the outermost band: a physical edge (kerb, flush…) plus a painted marking (none, dashed, solid…). |
| **Structure span** | A stretch of segment, `[s_from, s_to)`, over which the list of bands, their attributes and the boundaries stay the same. Only widths vary inside it. |
| **Width point** | A position inside a structure span with a width for every band (and a carriageway shift). Widths are interpolated linearly between width points. |

### Parameters

| Name | Default | Notes |
|---|---|---|
| `ℓ` slice length | 0.1 m | Output resolution. Cheap, since slices come from resampling, not from the model. |
| `Δ` min piece length | 2 m | Splitting stops when a piece is ≤ `Δ`. Should be several imagery pixels (≥ ~4 px). Not tied to `ℓ`. |
| `τ` confidence threshold | tune | Below this, a split point is deferred rather than pinned (Stage 3). |
| `R` refinement passes | 2 | Clean-up passes after splitting (Stage 3b). |
| `d_c` cluster distance | 30 m | Junctions joined by a segment shorter than this are merged into one cluster. |
| `b` blend band length | 5 m | About 2–3 × `Δ`. |
| `K` port feedback rounds | 2 | Maximum number of template re-fits (Stage 3c). |
| `p_max` port move cap | 1.5 m | Maximum port movement per feedback round. |
| GSD | from imagery | Native ground sample distance (m/px) of the area's imagery, e.g. 0.08 for PDOK 8 cm. |
| Model B fine crop | 16 m at 0.1 m/px | 160 × 160 px. Precise centring. |
| Model B coarse crop | 64 m at 0.4 m/px | 160 × 160 px. Road continuity and occlusions. |
| Model A crop | 128 m at 0.25 m/px | 512 × 512 px. Larger clusters get a larger crop at the same resolution. |
| Profile strip | 40 m × 8 m at 0.1 m/px | 400 × 80 px, across × along the road. Input to Model B's profile head. |
| `Δₓ` cross-section sampling | 1 m | Spacing of profile predictions along the final centerline (Stage 5). |
| `w_min` minimum band width | 0.3 m | Narrower runs in a predicted profile are merged into a neighbour (Stage 5). |
| `ε_w` width tolerance | 0.1 m | Width points are dropped while interpolation stays within this of the smoothed widths (Stage 5). |

All geometry is computed in a local projected CRS in metres (e.g. UTM zone of the tile). Convert to/from WGS84 only at I/O.

## Inputs

- **OSM extract** for the area: highways only (`highway=*`), with `tunnel`, `bridge`, `layer`, `junction`, `oneway` tags kept.
- **Imagery**: each area is locked to one dated imagery layer when it is created (e.g. PDOK `2026_orthoHR`), recorded with its provider, year, native GSD and licence. Labels describe "the middle of the road *in this imagery*", so annotation, training and evaluation for an area all use exactly that layer. Never use a "current" layer (such as PDOK `Actueel_*`): it is replaced every year.

## Imagery and crops

Both models see a **constant view**: a fixed ground resolution and a fixed crop size, so a road of a given width always covers the same number of pixels, and a sideways offset in metres is always the same number of pixels.

- **Snapshot.** Before training, download each annotated area's imagery into a local GeoTIFF in the area's UTM CRS at native resolution, plus a margin around the area for the largest crop. Training reads crops from the snapshot, never from tile servers. This keeps training reproducible and fast.
- **Fixed resolution, not zoom level.** Crops are resampled to a fixed metres per pixel (see [Parameters](#parameters)). Web-map zoom levels are not used: their resolution varies with latitude.
- **Centred on the current guess, never on the label.** A crop is centred on where the pipeline *would* look at inference: a guide-line point for Model B, the OSM centroid for Model A. Centring on the annotated position would make every target zero.
- **Canonical orientation (Model B).** The crop is rotated so the guide line's heading points up. To avoid empty corners, read a source window √2 ≈ 1.42× the crop size, rotate, then cut the crop; resample bilinearly.
- **Two scales (Model B).** One crop can't give both fine detail and wide context at a reasonable size, so Model B gets two crops with the same centre and rotation: a fine crop and a coarse crop. Both stay the same at every split level and in refinement; the guide line and pinned-end channels say where the model is in the process.

## Templates

A template is fitted to one cluster. **OSM fixes the topology**: how many arms there are, which carriageways each arm carries, and which ports connect to which inside the cluster. **The fit fixes the geometry.** Templates never add or remove arms.

### Template types

| Type | Shape | Parameters (in addition to the per-arm ones below) |
|---|---|---|
| `point` | All arm centerlines meet at one centre. Covers T, Y, crossroads, skewed and 5+ way intersections. | centre `c` |
| `staggered` | Two centres joined by a short link; each arm attaches to one of them. Covers offset/staggered junctions. | centres `c₁`, `c₂`; arm-to-centre assignment (from OSM) |
| `roundabout` | A circular ring; arms attach to the ring. | centre `c`, ring radius `r_ring` |
| `dead_end` | One arm ending at a point, optionally with a turning circle. | end point `e`; optional turning radius `r_turn` |
| `freeform` | No shape constraint: the cluster's internal OSM polylines are fitted directly to the evidence with a smoothness term. Fallback for anything the other types can't express (interchanges, complex multi-way junctions). | internal polyline vertices |

### Per-arm parameters

Every arm has its own geometry, so arms are **not** assumed to be at 90° (or any other fixed angle):

- `θᵢ`: the arm's direction where it leaves the core (the centre, ring or link). Free per arm; the only constraint is that the arms keep their circular order from OSM.
- `rᵢ`: the distance along the arm from the core to its port. This sets the cut-out boundary for that arm, so an arm with a long turn-lane flare can have a larger `rᵢ` than a plain side road.
- Port heading `ψᵢ`: the road direction at the port. The arm's centerline inside the cut-out is a cubic Bézier from the core (tangent `θᵢ`) to the port (tangent `ψᵢ`). Arms can therefore curve on their approach; `θᵢ ≠ ψᵢ` is normal.
- For a dual-carriageway arm: separation `wᵢ`. Its two ports sit at `±wᵢ/2` either side of the arm's axis.

For dual carriageways inside a `point` or `staggered` core, each carriageway is an offset of its arm's axis; where they cross other carriageways follows the OSM topology inside the cluster.

## Road cross-sections

Every road attribute is a function of distance `s` along the segment's centerline. Attributes come in two kinds, and each has one representation, one editing tool and one model output:

| Kind | Examples | Representation |
|---|---|---|
| Changes rarely, in steps | which bands exist, lane use, markings, kerbs, parking type | **structure spans**: piecewise constant |
| Changes smoothly | band widths | **width points** inside each span: piecewise linear |

### Bands and boundaries

A cross-section is an ordered list of bands, **left to right in the segment's direction** (start port → end port), with one boundary before, between and after them:

```
 sidewalk | parking | cycle lane | lane ←  ¦  lane → | cycle lane | sidewalk
         kerb     flush        solid      dashed     solid       kerb
```

Band kinds and their attributes:

| Kind | Attributes | Notes |
|---|---|---|
| `lane` | `direction`: forward / backward / both; `use`: a set of general / bus / bicycle / taxi / cycle_street; `turn`: none / through / left / right / combinations | The driving lanes. `use` is a set so shared lanes work, e.g. `{bus, bicycle}`; a Dutch cycle street (*fietsstraat*, where cars are guests) is `{cycle_street}`. Turns usually change near intersections, so they get their own spans. |
| `cycle_lane` | — | Painted cycle lane on the road (Dutch *fietsstrook*). |
| `cycle_track` | — | Cycle path separated from the road but part of the street. Often also mapped in OSM as its own way, which this project doesn't load. |
| `parking` | `arrangement`: parallel / angled / perpendicular; `surface`: carriageway / bay / on_sidewalk | Per side. Only where parking is visibly designated (see [What counts as parking](#what-counts-as-parking)). |
| `sidewalk` | — | |
| `median` | `surface`: painted / kerbed / verge | Between opposing lanes on one carriageway. |
| `verge` | — | Grass, trees, tree pits. |
| `shoulder` | — | Hard shoulder on larger roads. |

Boundary attributes:
- `physical`: flush (same surface) / paving_change / low_kerb / kerb;
- `marking`: none / dashed / solid / double_solid / dashed_solid / solid_dashed / block (Dutch *blokmarkering*).

The **carriageway** is the run of `lane` bands. Its middle is the centerline, so the cross-section is positioned with the carriageway's middle on the centerline, plus a small `shift` stored per width point. `shift` is normally 0; a consistently non-zero shift means the centerline isn't in the middle of the road, which makes it a free quality check.

**Width** in the usual sense ("how wide is this road") is the carriageway: driving lanes only, excluding cycle lanes, parking and sidewalks. Those are their own bands, so nothing is lost.

Left and right are always relative to the segment's direction. Exports should say so explicitly, and a consumer that reverses a segment must reverse its bands too.

### What counts as parking

A `parking` band is only used where parking is **visibly designated**: bays, painted markings, a different paving or kerbed parking strips. A car that has simply stopped at the side of the road doesn't make a parking band: that surface is part of the `lane` it is next to. Whether it's legal to stop there can't be judged from imagery and is [out of scope](#out-of-scope).

The same rule applies to shared paved surfaces with no visible boundaries (e.g. a Dutch *woonerf*): the area cars drive on is `lane`, and parking is marked only where bays or markings show it.

### Outer limit

A cross-section ends at the **outer edge of the sidewalk**. Where there is no sidewalk on a side, it ends at the outer edge of the last band that belongs to the street on that side: a cycle track, parking or the carriageway's own edge. Verges *between* the road and the sidewalk are included; anything beyond the sidewalk (front gardens, building fronts) is not, and gets the class `outside` in training.

### Spans and width points

- A segment starts as **one structure span** covering its whole length. Annotators split it only where the structure really changes.
- Each span has **at least one width point**. One width point means constant widths. Widths are interpolated linearly between width points and held constant before the first and after the last.
- Positions (`s` for spans, width points and flags) are metres along the current centerline. When the centerline is edited, all positions on that segment are rescaled by `L_new / L_old`, so attributes stay attached to the same part of the road.

**Gradual transitions are width changes, not structure changes.** Bands may have zero width, so a band that appears or disappears gradually simply narrows to 0. In Houten, parking often turns into sidewalk: the parking band narrows from 2 m to 0 while the sidewalk widens, and the boundary between them is `flush` or `paving_change`, not a kerb. One span with a few width points describes this. A new span is needed only where something appears abruptly, and even then a zero-width band in the neighbouring span often makes editing simpler.

### Intersections

Cross-sections continue into intersections so the overlay and outputs have no gaps:

- **Arms** take the cross-section of their segment at the port: the structure of the span at that end, and the widths there. There is never a step in width at the cut-out boundary.
- **Corners** (`point` and `staggered`): the template gains a **kerb corner radius** for each pair of neighbouring arms. The kerb of one arm's right side meets the next arm's left side in a circular arc of that radius. Sidewalks and verges follow the corner, offset outward.
- **Roundabouts**: the template gains `ring_width` (the circulating carriageway, centred on the ring) and `apron_width` (the mountable strip around the island, common in the Netherlands). The central island radius follows: `radius − ring_width / 2 − apron_width`.
- Lane markings stop at the port. Stop lines, give-way markings and crossings are [out of scope](#out-of-scope) for now.

### Overlay

The annotation tool draws what the output will look like, on top of the imagery:

- **Bands:** semi-transparent strips offset from the centerline, coloured by kind, e.g. dark grey lanes, red cycle lanes (matching Dutch red asphalt), blue parking, light grey sidewalk, green verge.
- **Boundaries:** drawn as what they are: kerbs as thick grey lines, markings as white lines (dashed, solid, double, block), flush edges as faint lines.
- **Lane direction:** small arrows on each lane.
- **Intersections:** the carriageway surface of all arms joined with the kerb corner radii, roundabout rings and aprons, with sidewalks following the corners.

Offsets are computed from the centerline resampled at 0.5 m, using per-vertex normals. On tight curves the inside offset can fold over itself; the overlay clips those loops.

## Pipeline (inference)

### Stage 0 — Build the graph and clusters

1. Load OSM highways and drop ways tagged `tunnel=yes` (out of scope).
2. Find junctions. Only **shared OSM nodes** count; roads that cross geometrically without a shared node (overpasses, `bridge=yes`, different `layer`) are **not** connected. Merge ways that join end to end at a non-junction node into one segment, keeping all their OSM way IDs.
3. **Cluster** junctions. Merge two junctions into one cluster when:
   - they are joined by a segment shorter than `d_c`; or
   - they are both on a way tagged `junction=roundabout`; or
   - their cut-outs would overlap (checked again after Stage 1).

   A dead end is a cluster of its own.
4. **Assign ports.** Every OSM segment that leaves a cluster gives one port, and that assignment never changes. Group ports into arms: two one-way segments running side by side in opposite directions form one dual-carriageway arm; every other port is its own arm. Sort arms by angle around the cluster's OSM centroid. The arm count limits which templates are possible.
5. Segments with both ends inside the same cluster are **internal**: their topology is kept for the template, and Model B never processes them.

### Stage 1 — Classify and fit templates (Model A)

For every cluster, before any segment is split:

1. Model A predicts:
   - **type probabilities** over the types valid for this arm count;
   - a **centerline heatmap** over the cluster's crop: the probability that each pixel is on a road centerline;
   - a confidence.
2. **Fit** each plausible type to the heatmap by minimising:

   `E = E_heatmap + λ_prior · E_osm + λ_smooth · E_smooth`

   - `E_heatmap`: negative log heatmap, sampled along the template's centerlines;
   - `E_osm`: a weak pull toward OSM geometry (arm directions, centroid), so the fit stays sensible where the heatmap is weak;
   - `E_smooth`: keeps the Bézier arms from kinking.

   Initialise arm directions and port positions from OSM: put each port where the OSM segment crosses a default radius for its road class, with the OSM direction as its heading.
3. **Choose the type** by combining Model A's type probability with each fit's residual. If no type fits well, use `freeform`.
4. Pin the resulting ports. The arm-to-port mapping comes from Stage 0 and the arms are matched by circular order, so the fit only has to resolve continuous parameters.

Fitting to a heatmap, rather than having Model A regress parameters directly, means a new template type can be added without retraining Model A.

### Stage 2 — Fit the guide line

For each segment, clip the OSM polyline to the part between its two ports. Then apply a similarity transform (translate, rotate, uniform scale) so its ends match the ports. The result is the guide line.

A segment that ends at a dead end is clipped at that cluster's port like any other.

### Stage 3 — Binary splitting (Model B)

Each segment starts as a single piece between its two ports. Pieces are processed level by level (breadth-first):

1. For every piece longer than `Δ`, take the guide line point `m` at **half the piece's arc length** (not the midpoint of the straight line between its ends, which can be off the road on a curve).
2. Model B predicts the sideways offset `d` at `m`, along the **guide line's normal at `m`**, plus a confidence `c`.
3. If `c ≥ τ`: move `m` by `d` and pin it. Re-fit each half of the guide line between its pinned ends with the Stage 2 similarity transform. This moves the remaining OSM-derived vertices in both halves, so the correction fades to zero at both neighbouring pinned points.
4. If `c < τ`: don't pin `m`. Split the piece at `m` anyway, without moving it, and keep its prediction as a fallback. The two halves are processed at the next level with tighter context. A deferred point is resolved in Stage 3b.
5. Repeat until every piece is ≤ `Δ`.

All split points at one level are independent given the level above, so they are predicted in one batch. Depth is about `log2(L / Δ)`: around 9 levels for a 1 km segment at `Δ` = 2 m.

### Stage 3b — Refinement

A bad pin at a coarse level constrains everything below it. To recover, run `R` passes over all split points: re-predict each one with Model B, treating its two neighbouring points (at the final resolution) as its pinned ends, and update it. Within a pass, update even-indexed points first and then odd-indexed points, so each point's neighbours stay fixed while it is predicted. Deferred points are resolved here, falling back to their Stage 3 prediction if confidence stays below `τ`.

Each pass is one batched prediction per parity. Stop early if the mean update is below a small tolerance (e.g. 0.05 m).

### Stage 3c — Port feedback

A port depends on both sides: the intersection shows where the arm leaves, and the road outside shows which way it's heading. After splitting, feed the road's evidence back into the template:

1. **Re-fit** each template with an extra term:

   `E_ports = Σᵢ ‖port position − line through the segment's first split points‖² + μ · (ψᵢ − segment heading near the port)²`

   using the split points within the blend band (or the first 3, whichever is more).
2. Clamp each port's movement to `p_max`.
3. Spread each port's shift into its segment with the same linear falloff to the next pinned split point, then run one Stage 3b pass on the split points within `2b` of the port.
4. Repeat up to `K` rounds, stopping early if no port moves more than 0.1 m.

Model B never moves a port directly. It supplies evidence, and the template fit decides.

### Stage 4 — Blend and resample

1. **Segments:** fit a smooth curve (e.g. centripetal Catmull-Rom or a smoothing spline) through the start port, the split points in arc-length order, and the end port. This also removes the slight bends left at split points by re-fitting each half separately.
2. **Blend band:** along the first `b` metres of a segment from each port, the final point is

   `p(s) = (1 − w(s)) · template(s) + w(s) · segment(s)`,  with `w(s) = smoothstep(s / b)`

   where `template(s)` continues the arm straight out from the port along `ψᵢ`. The join is therefore smooth in both position and heading.
3. **Template curves:** generate the template's centerlines inside each cut-out (Bézier arms, ring, link).
4. **Resample** every curve at `ℓ` metres of arc length, starting from the cluster's core; the final slice of each curve may be shorter than `ℓ`. Nodes where curves meet (a `point` centre, the points where arms attach to a ring, ports) are shared, so the slice graph stays connected.

### Stage 5 — Cross-sections (Model B profile head)

Runs on the final centerlines from Stage 4, so profile crops are centred on (nearly) the right place.

1. **Predict profiles.** Every `Δₓ` metres along each segment, cut a profile strip centred on the centerline and rotated to its heading. The profile head predicts, for each 0.1 m bin across the road, a band kind and that kind's attributes, and for each edge between bins, a boundary class (see [Model B profile head](#model-b-profile-head)).
2. **Turn each profile into bands.** Merge neighbouring bins with the same kind into bands; merge bands narrower than `w_min` into a neighbour. Each band takes the majority of its bins' attributes; each boundary takes the most confident boundary class near the change.
3. **Choose structure spans.** Along the segment, choose spans with dynamic programming. The cost is how badly each sample's band list disagrees with its span's band list, plus a penalty for every new span. The penalty differs per attribute: high for markings and lane use, low for parking, which changes quickly. Candidate band lists are those predicted at the samples.
4. **Fit widths.** Inside each span, fit a smoothing spline to each band's predicted widths, with a penalty on bending (widths change slowly). Then reduce it to the fewest width points whose linear interpolation stays within `ε_w` of the spline.
5. **Intersections.** Fit kerb corner radii, `ring_width` and `apron_width` to Model A's kerb heatmap, with arm cross-sections fixed from their ports.

The output is in exactly the format annotators edit (spans and width points), so model output can be reviewed and corrected in the same tool.

## Human annotation

Annotators correct geometry; they do not click every slice.

1. **Clusters:** check the cluster grouping (merge or split if Stage 0 got it wrong). Pick the template type (pre-filled from OSM tags and the arm count), then drag its handles: centre(s) or ring, arm directions, port distances, Bézier handles, carriageway separation. `freeform` clusters are edited as polylines.
2. **Centerlines:** for each segment, edit a free polyline (add or move as many vertices as needed) so it follows the middle of the road between its ports. The tool starts from the Stage 2 guide line, and later from model output.
3. **Cross-sections** (with the [overlay](#overlay) on):
   - set the segment's band list and attributes, prefilled from OSM tags (`lanes`, `lanes:forward/backward`, `turn:lanes`, `width`, `lane_markings`, `cycleway:left/right`, `parking:left/right`, `sidewalk`);
   - drag band edges in the overlay to set widths; dragging adds a width point at that position if there isn't one nearby;
   - split the segment into structure spans where the structure changes, and edit each span's bands;
   - at intersections, drag kerb corners to set corner radii, and the ring and apron edges for roundabouts.
4. **Flags** per segment, or per span of a segment:
   - `occluded`: the road centre is hidden (trees, shadow, building lean) and the annotator is inferring it from context.
   - `ambiguous`: no clear centre (e.g. unmarked wide area, car park aisle).
   - `skip`: imagery unusable.
5. **OSM topology errors** (e.g. a missing slip road): flag the cluster `topology_error` and, if possible, annotate it as `freeform`. Fixing OSM topology is out of scope.

Once Models A and B exist, annotators correct model output instead of OSM. This speeds annotation and focuses effort on the model's mistakes.

### Deriving training labels

From the annotated data, labels are computed, not annotated:

- **Model A:**
  - type label = the annotated template type;
  - heatmap target = the annotated template's centerlines rasterised into the crop, with a Gaussian of σ ≈ 1 m around them.
- **Model B:** for any arc length `s` on the guide line, `target = sideways distance from the guide line point to the annotated centerline`, measured along the normal. Sample `s` densely and randomly, not only at multiples of `Δ`. Sample only **from the ports outward**; never inside a cut-out.
- **Profile head:** at any `s` along an annotated segment, rasterise the annotated cross-section into the profile strip's bins: each bin gets the kind and attributes of the band covering its centre, and each boundary goes to the nearest bin edge. Bins beyond the outermost boundary get the class `outside`. Shift the labels by the same sideways perturbation as the crop (see [Training notes](#training-notes)), so the profile head also learns to cope with an imperfect centerline. Sample `s` randomly, not on a grid: how many width points the annotator placed then makes no difference.
- **Model A kerb heatmap:** the annotated intersection's kerb lines (arm kerbs, corner arcs, ring and island edges) rasterised like the centerline heatmap.
- **Slices:** run Stage 4 on the annotated geometry for evaluation and export.

## Models

### Model A — intersection

- **Input:** imagery crop of 128 m at 0.25 m/px, north-up, centred on the cluster's OSM centroid. Extra channels: the cluster's rasterised OSM geometry and its initial port positions.

  Model A is fully convolutional, so a cluster that doesn't fit inside the crop with a 20 m margin gets a larger crop **at the same resolution**, never a downscaled one. (128 m covers e.g. the 68 m Houten roundabouts with room to spare.)
- **Output:** type probabilities (masked to the types valid for the arm count), a centerline heatmap and a **kerb heatmap** at crop resolution (0.25 m/px), and a confidence. The template fit (Stage 1) works on the centerline heatmap with sub-pixel interpolation; Stage 5 fits the corner radii and roundabout widths to the kerb heatmap.

Model A doesn't output the intersection's position directly. Position, arm angles and port locations all come from the template fit (Stage 1).

### Model B — sideways offset

- **Input:** two imagery crops centred on the split point and **rotated so the guide line's heading at that point points up** (see [Imagery and crops](#imagery-and-crops)):
  - **fine:** 16 m at 0.1 m/px, for precise centring;
  - **coarse:** 64 m at 0.4 m/px, to see road continuity past occlusions.

  Each crop has extra rasterised channels for:
  - the current guide line;
  - the piece's two pinned ends (if they fall inside the crop).

  Crops may overlap a cut-out: Model B can *see* into intersections, it just never predicts there. Every level and the refinement passes use the same model and the same crops.
- **Output:** scalar sideways offset `d` (metres) plus a confidence `c`.

### Model B profile head

A second head on Model B, used in Stage 5. Because the crop is already centred on the road, rotated to its heading and at a fixed resolution, the cross-section is simply a horizontal line across the crop. That makes cross-sections a **1D segmentation** problem, which avoids predicting a variable-length list of bands directly.

- **Input:** a profile strip, 40 m across × 8 m along the road at 0.1 m/px (400 × 80 px), centred on the centerline and rotated like the other crops. 40 m covers sidewalks on both sides of most streets; 0.1 m/px resolves 10 cm painted lines. The strip's 8 m length lets the model see dash patterns and parking-bay markings. The coarse crop is also given, for context.
- **Output**, for each of the 400 bins across the road:
  - band kind, including `outside`;
  - one output per kind-specific attribute (lane direction, use, turn; parking arrangement and surface; median surface). Lane `use` is multi-label: one yes/no output per value;

  and for each of the 401 bin edges, a boundary class (`none`, or a physical edge and marking).
- **Loss:** cross-entropy per bin. Annotators won't place boundaries exactly, so the band-kind loss ignores 1 bin either side of each labelled boundary; the boundary output is trained with a small tolerance (e.g. a target spread over ±2 bins).

### Training notes

- **Exposure bias:** at inference, a piece's pinned ends and guide line come from earlier predictions. During training, simulate this: take the annotated centerline, perturb the pinned ends sideways with noise matching the observed error of the level that produced them, re-fit the guide line, and use the sideways distance to the annotated centerline at the arc-length midpoint as the target. Better still, mix in examples from the model's own rollouts. Report error by split level.
- **Port noise:** ports also come from a fit at inference. Perturb port positions and headings in training by the observed Stage 1 error.
- **Confidence:** train `c` to predict whether the error will be small, e.g. a classification head for `|d − target| < 0.5 m`. This is what makes `τ` meaningful.
- **Piece lengths:** sample training pieces across the full range of lengths seen at inference (from `Δ` up to whole segments). Crops are local, but the guide line's quality differs between coarse and fine levels.
- **Occluded spans:** keep them in training (the model can learn to infer the centre from the surrounding road), but track their error separately. Consider down-weighting `ambiguous` spans.
- **Crop centring:** training crops are centred on the perturbed guide-line point (Model B) or a jittered OSM centroid (Model A), never on the annotated position. Sideways noise should cover the full range of errors seen at inference, including raw OSM offsets of several metres.
- **Augmentation:**
  - small rotations (a few degrees; Model B crops are already in canonical orientation);
  - brightness and contrast changes;
  - no flips if the road network has a handedness the model should learn (e.g. driving side), unless the label sign is flipped too.
- **Other imagery:** to run on imagery other than 8 cm aerial photos (other countries, satellite imagery), add augmentation that blurs and downsamples crops before resampling to the fixed resolution, and report results separately per imagery source.

## Data model

```
Junction   { id, osm_node_id, osm_xy, cluster_id }
Cluster    { id, junction_ids, internal_segment_ids, type, params, flags, source: osm|model|human }
             // params also hold corner_radii (point, staggered) or ring_width, apron_width (roundabout)
Arm        { id, cluster_id, order, theta, port_distance, separation?, port_ids }
Port       { id, cluster_id, arm_id, segment_id, carriageway: 0|1, xy, heading }
Segment    { id, osm_way_ids, start_port, end_port,
             guide_line: [xy], centerline: [xy], source, flags: [Flag], spans: [StructureSpan] }
Flag       { kind: occluded|ambiguous|skip, s_from, s_to }   // arc-length span
StructureSpan { s_from, s_to, bands: [Band], boundaries: [Boundary],   // len(boundaries) = len(bands) + 1
                width_points: [WidthPoint], source }
Band       { kind, attributes }                                  // left to right in segment direction
Boundary   { physical: flush|paving_change|low_kerb|kerb, marking: none|dashed|solid|double_solid|dashed_solid|solid_dashed|block }
WidthPoint { s, widths: [metres per band], shift }
Slice      { id, curve_ref, index, node_a, node_b, length }   // curve_ref: segment, or template curve
SliceNode  { id, xy }
Area       { id, name, bbox, crs, imagery: Imagery }
Imagery    { id, provider, layer, year, gsd, tiles, license }   // a dated layer, fixed per area
```

`source` records where the current geometry came from, so model output and human corrections can be told apart. Ports, `point` centres and ring attachment points are shared `SliceNode`s, so the slice graph stays connected through intersections. Cross-sections are stored per segment, not per slice node: exports evaluate them at each slice node when per-node values are needed.

## Edge cases

| Case | Handling |
|---|---|
| Tunnels | Excluded in Stage 0 (`tunnel=yes`). |
| Bridges / overpasses | Handled like any road. Never create junctions at geometric crossings; only at shared OSM nodes. |
| Tree cover / shadow | Model B sees wide context; annotator flags `occluded`. Reported separately in evaluation. |
| Roundabouts | One cluster (all junctions on the `junction=roundabout` way), `roundabout` template. |
| Skewed intersections | Each arm's direction `θᵢ` is fitted independently; no fixed angles. |
| Curved approaches | Bézier arm from core tangent `θᵢ` to port heading `ψᵢ`. |
| Staggered / offset junctions | `staggered` template, or a merged cluster via `d_c`. |
| Dual carriageways | One arm with two ports. Each carriageway's centreline is the middle of **that carriageway**, not the whole road. |
| Interchanges, complex junctions | `freeform`. |
| Segment shorter than its two cut-outs | The two clusters are merged (Stage 0, step 3). |
| Very short segments (`L ≤ Δ`) | No split points; Stage 4 resamples between the two ports directly. |
| Loop leaving and re-entering the same cluster | Two different ports, so it's handled like any segment. |
| Closed way with no junctions | Rare. Stage 2 uses translation only (no rotation or scale is defined). |
| OSM topology errors | Flag `topology_error`; `freeform` if possible. |
| Parking that turns into sidewalk | One span; the parking band narrows to 0 while the sidewalk widens; the boundary is `flush` or `paving_change`. |
| Parking bays between tree pits | Short spans alternating `parking` / `verge`. The annotation tool has a **repeat** action: select a run of spans (e.g. one bay and one tree pit) and repeat it along the segment, then adjust where needed. |
| Parking on the sidewalk | `parking` band with `surface: on_sidewalk`. |
| Single OSM way with a central divider | `median` band between the opposing lanes. |
| Dual carriageway mapped as two OSM ways | Each segment is one carriageway; its cross-section covers that carriageway and its own side of the street. The space between the carriageways is the outermost band on the inner side (`median` or `verge`). |
| Shared space (Dutch *woonerf*) | Often no kerbs and no markings. The area cars drive on is `lane`; `parking` only where bays or markings show it; `flush` boundaries. Flag `ambiguous` where even the driving area isn't visible. |
| Cars stopped at the side of the road | Not parking: part of the `lane` band (see [What counts as parking](#what-counts-as-parking)). |

## Evaluation

Primary metric: **sideways distance** between the predicted and annotated centerlines, measured at every slice node.

Report:
- mean, median and p95 (metres);
- broken out by:
  - flag (clear vs occluded);
  - road class (`highway=*`);
  - split level (to show whether coarse-level errors carry down);
  - zone: inside cut-outs, blend band, and road;
- before and after Stage 3b refinement and Stage 3c port feedback;
- **intersections** separately:
  - template type accuracy (and its confusion matrix);
  - how often `freeform` is used, which shows which template to add next;
  - port position error (mean, p95) and port heading error;
  - cluster grouping errors (clusters annotators had to merge or split);
- **baselines:**
  - raw OSM;
  - OSM after the Stage 2 transform only (no Model B);
  - point junctions with no templates (Model A predicting only a centre offset);
  - sequential start-to-end tracing with the same Model B and linear rubber-band propagation.

  These show how much each stage contributes.

**Cross-sections**, evaluated at every slice node:
- boundary position error (metres), per boundary type;
- per-bin band-kind accuracy and IoU per kind;
- lane `use` accuracy, per value (it is multi-label);
- marking and kerb classification accuracy;
- carriageway width error (metres);
- structure span boundary error (metres along the segment), and how many spans annotators had to add or delete.

Hold out geographic areas (not random segments) for test, so nearby roads don't leak between splits.

## Out of scope (for now)

- Markings inside intersections and on lanes: stop lines, give-way markings, pedestrian crossings, arrows. Templates and lane `turn` attributes are the natural places to add these.
- Road surface material.
- Stopping and parking rules (where it is legal to stop at the side of a lane). These can't be judged from imagery.
- Discovering roads missing from OSM, and fixing OSM topology.
- Tunnels.

## Open questions

- **Lane use outside the Netherlands.** The `use` set (general, bus, bicycle, taxi, cycle_street) is chosen for Dutch roads. Other countries, such as the US with shared bus/bike lanes, may need more values; the set representation allows adding them.
- **Driving side.** Lanes store a direction, so left-hand traffic works in principle; the default band lists and the overlay assume right-hand traffic.

