# Run runtime environment

`oasis-kit.glb` and `oasis-modular-environment.blend` remain the full original
editable asset. The renderer has permanently excluded the Palace prefab;
`static-batches.mjs` skips it before scene ownership or batching.

`oasis-kit-runtime-v1.glb` is derived by reachability pruning, not by mesh
re-export or simplification. It contains Palm, RockBank, BridgeSupport and
FinishGate. Their node transforms, primitive attributes/indices and materials
keep their original semantics. Referenced buffer-view bytes are copied exactly;
only array references and buffer offsets are remapped. There are no textures,
external buffers, animations, skins or decoder extensions in this GLB. The
generator rejects unsupported features rather than silently dropping them.

Regenerate only the runtime file and its adjacent JSON manifest:

```sh
python3 platform/arena/run/assets/source/prune_environment.py
```

The Blender authoring script calls this same postprocessor after its full
export. This change was generated from the checked-in original GLB without
running Blender or replacing the original GLB/Blend bytes.

The full GLB is 1,344,624 bytes; the runtime GLB is 933,776 bytes, saving
410,848 bytes (30.6%), of which 405,768 bytes are Palace-only geometry buffers.
These are file sizes, not measured HTTP encoded bytes or device loading times.
The JSON manifest binds the source and derived SHA-256 values. The Vite import
produces a new content-fingerprinted URL; published old URLs remain retained
under the existing static-asset policy.

Directed verification:

```sh
cd platform
node --test tests/run-runtime-environment.test.mjs arena/run/qa/asset-loading.test.mjs
```

Tests compare complete per-prefab GLB semantics and buffer bytes independently
of the pruner, parse both files with the actual GLTFLoader, verify deterministic
regeneration, and reject unsupported references and source overwrite. Existing
asset cancellation/readiness tests remain separate. Texture prewarming, scene
readiness, physics, imagery and visible prefab content are unchanged. This does
not establish public loading budgets or physical-device smoothness acceptance.
