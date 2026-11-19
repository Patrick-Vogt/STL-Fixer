# stl-fixer

A small command-line tool that repairs STL files so your slicer stops complaining about them. I wrote it because Bambu Studio kept flagging downloaded models with non-manifold edges and open edges, and fixing them one by one in the GUI got old.

Point it at a folder. Every `.stl` in there gets repaired and saved next to the original as `fixed_<name>.stl`. The originals are never touched.

## Install

You need Python 3.8 or newer and numpy.

```bash
git clone https://github.com/<your-user>/stl-fixer.git
cd stl-fixer
python3 -m pip install -r requirements.txt
```

## Usage

```bash
python3 stl_fixer.py /path/to/folder
```

To include subfolders:

```bash
python3 stl_fixer.py /path/to/folder -r
```

Files that already start with `fixed_` are skipped, so you can run it on the same folder again without it chewing on its own output.

### What you'll see

For each file it prints the steps as they run, how many problems it found, and what it did about them:

```
[1/3] Warhound Mega Bolter.stl
  ✓ Reading                            46,990 triangles
  ✓ Welding vertices                   140,970 → 23,497 vertices
  ! Analysing                          72 findings
      34 open, 38 nonmanifold
  ✓ Repair pass 1                      12 non-manifold tris dropped, 9 hole(s) filled
  ✓ Writing                            fixed_Warhound Mega Bolter.stl
  ✓ Verifying saved file               no issues left
  → fixed 72 finding(s) in 0.4 s
```

At the end there is a summary with the totals per file. The exit code is 1 if any file couldn't be read, 0 otherwise.

The "Verifying saved file" step reloads the file it just wrote and counts the problems again, so what it reports is what your slicer will see.

## What it fixes

- Non-manifold edges (edges shared by more than two triangles)
- Open edges and holes, which get filled
- Inconsistent triangle winding and flipped normals
- Inside-out shells (negative volume)
- Duplicate triangles and zero-area triangles
- Vertices that are in the same place but not connected

Binary and ASCII STL are both read. Output is always binary STL.

## How it works

1. Reads the triangles and welds vertices that sit at the same position (tolerance is 1e-7 of the model's bounding-box diagonal).
2. Counts what's wrong, so you get the "findings" number.
3. Removes degenerate and duplicate triangles.
4. For edges with more than two triangles, keeps the two largest and drops the rest.
5. Makes the winding consistent across each connected shell.
6. Finds the boundary loops of each hole and fills them. Small holes are triangulated by ear clipping, larger or awkward ones with a fan from the centre.
7. Flips any closed shell that ended up inside-out.
8. If problems remain, cuts out the area around them and repeats, up to six passes.
9. Writes the file, reads it back and checks it again.

## Limits

- It doesn't detect or repair self-intersections or overlapping shells. Some slicers flag those separately.
- Hole filling is flat or fan-shaped. It makes the mesh watertight, it doesn't reconstruct the missing surface. A big gap in a model will be bridged, not sculpted.
- Dropping triangles at non-manifold edges can slightly change fine detail right at the problem spot.
- Vertices where two parts of a surface touch at a single point aren't repaired.
- Everything is held in memory. A model with a few million triangles is fine on a normal laptop; much bigger files will need more RAM.

If a file still shows errors in your slicer after running this, open an issue and attach the STL if you can.

## License

MIT, see [LICENSE](LICENSE).
