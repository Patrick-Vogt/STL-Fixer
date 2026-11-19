#!/usr/bin/env python3
"""
stl_fixer.py - repair STL files so slicers (Bambu Studio, Orca, Prusa, Cura...)
stop reporting mesh errors.

Usage:
    python3 stl_fixer.py /path/to/folder
    python3 stl_fixer.py /path/to/folder -r          # include sub-folders

Every *.stl in the folder is repaired and written next to the original as
fixed_<name>.stl (binary STL). Originals are never modified.

What it repairs
    - non-finite / degenerate (zero-area) triangles
    - duplicate triangles
    - non-manifold edges (edges shared by more than 2 triangles)
    - inconsistent triangle winding / flipped normals
    - inside-out (negative volume) closed shells
    - open edges / holes (filled)
    - unwelded vertices (merged)

Only dependency: numpy.
"""
import argparse
import os
import re
import sys
import time
from collections import deque

try:
    import numpy as np
except ImportError:  # pragma: no cover
    sys.exit("This script needs numpy.  Install it with:  python3 -m pip install numpy")

# --------------------------------------------------------------------------- #
# Terminal output
# --------------------------------------------------------------------------- #
USE_COLOR = sys.stdout.isatty() and os.environ.get("NO_COLOR") is None


def c(code, text):
    return f"\033[{code}m{text}\033[0m" if USE_COLOR else text


def bold(t): return c("1", t)
def dim(t): return c("2", t)
def red(t): return c("31", t)
def green(t): return c("32", t)
def yellow(t): return c("33", t)
def cyan(t): return c("36", t)


def fmt_time(s):
    return f"{s * 1000:.0f} ms" if s < 1 else f"{s:.1f} s"


class Step:
    """Prints '  ... doing X' while running (live on a TTY), then the result."""

    def __init__(self, label):
        self.label = label
        self.t0 = time.time()
        if sys.stdout.isatty():
            sys.stdout.write(f"  {cyan('…')} {label}")
            sys.stdout.flush()

    def done(self, result="", level="ok"):
        mark = {"ok": green("✓"), "warn": yellow("!"), "fail": red("✗"), "info": cyan("•")}[level]
        text = f"  {mark} {self.label:<34} {result}"
        text += dim(f"  ({fmt_time(time.time() - self.t0)})")
        if sys.stdout.isatty():
            sys.stdout.write("\r\033[2K")
        print(text)
        sys.stdout.flush()


# --------------------------------------------------------------------------- #
# STL I/O
# --------------------------------------------------------------------------- #
def read_stl(path):
    """Return (triangles[n,3,3] float64, note)."""
    size = os.path.getsize(path)
    with open(path, "rb") as fh:
        data = fh.read()
    note = ""
    if size >= 84:
        n = int(np.frombuffer(data, dtype="<u4", count=1, offset=80)[0])
        if 84 + 50 * n == size:
            return _read_binary(data, n), note
    head = data[:512].lstrip().lower()
    if head.startswith(b"solid") and b"facet" in data[:4096].lower() + data[-4096:].lower():
        return _read_ascii(data), note
    if size >= 84:  # truncated / odd binary file: read what fits
        n = (size - 84) // 50
        note = f"file size does not match header, recovered {n} triangles"
        return _read_binary(data, n), note
    raise ValueError("not a valid STL file")


def _read_binary(data, n):
    dt = np.dtype([("n", "<f4", 3), ("v", "<f4", 9), ("a", "<u2")])
    arr = np.frombuffer(data, dtype=dt, count=n, offset=84)
    return arr["v"].astype(np.float64).reshape(-1, 3, 3)


def _read_ascii(data):
    text = data.decode("utf-8", errors="ignore")
    nums = re.findall(
        r"vertex\s+([-+0-9.eEinfaINFA]+)\s+([-+0-9.eEinfaINFA]+)\s+([-+0-9.eEinfaINFA]+)", text)
    if not nums:
        raise ValueError("ASCII STL contains no vertices")
    arr = np.array(nums, dtype=np.float64)
    arr = arr[: (len(arr) // 3) * 3]
    return arr.reshape(-1, 3, 3)


def write_stl(path, V, F):
    tri = V[F].astype(np.float32)
    nrm = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    ln = np.linalg.norm(nrm, axis=1, keepdims=True)
    ln[ln == 0] = 1
    nrm = (nrm / ln).astype(np.float32)
    dt = np.dtype([("n", "<f4", 3), ("v", "<f4", 9), ("a", "<u2")])
    out = np.zeros(len(F), dtype=dt)
    out["n"] = nrm
    out["v"] = tri.reshape(-1, 9)
    header = b"Fixed by stl_fixer.py".ljust(80, b" ")
    with open(path, "wb") as fh:
        fh.write(header)
        fh.write(np.array([len(F)], dtype="<u4").tobytes())
        fh.write(out.tobytes())


# --------------------------------------------------------------------------- #
# Mesh helpers
# --------------------------------------------------------------------------- #
def weld(tri, tol):
    """Merge coincident vertices. Returns V[k,3], F[m,3]."""
    flat = tri.reshape(-1, 3)
    q = np.round(flat / tol).astype(np.int64)
    _, first, inv = np.unique(q, axis=0, return_index=True, return_inverse=True)
    V = flat[first]
    F = inv.reshape(-1, 3).astype(np.int64)
    return V, F


def face_areas(V, F):
    t = V[F]
    return 0.5 * np.linalg.norm(np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0]), axis=1)


def half_edges(F, nV):
    he = np.stack([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]], axis=1).reshape(-1, 2)
    key = np.minimum(he[:, 0], he[:, 1]) * nV + np.maximum(he[:, 0], he[:, 1])
    uniq, inv, cnt = np.unique(key, return_inverse=True, return_counts=True)
    sign = np.where(he[:, 0] < he[:, 1], 1, -1)
    return he, inv, cnt, sign


def edge_stats(F, nV):
    """Counts of open edges, non-manifold edges and inconsistently wound edges."""
    if len(F) == 0:
        return dict(open=0, nonmanifold=0, inconsistent=0)
    he, inv, cnt, sign = half_edges(F, nV)
    ssum = np.bincount(inv, weights=sign)
    return dict(
        open=int((cnt == 1).sum()),
        nonmanifold=int((cnt > 2).sum()),
        inconsistent=int(((cnt == 2) & (np.abs(ssum) == 2)).sum()),
    )


def degenerate_mask(V, F, area_eps):
    bad = (F[:, 0] == F[:, 1]) | (F[:, 1] == F[:, 2]) | (F[:, 0] == F[:, 2])
    bad |= face_areas(V, F) <= area_eps
    return bad


def duplicate_mask(F):
    """True for every repeat of a triangle (regardless of winding), keeping the first."""
    s = np.sort(F, axis=1)
    _, first = np.unique(s, axis=0, return_index=True)
    keep = np.zeros(len(F), dtype=bool)
    keep[first] = True
    return ~keep


def remove_nonmanifold(V, F):
    """Drop the smallest triangles around edges shared by >2 faces until none remain."""
    removed = 0
    nV = len(V)
    for _ in range(50):
        he, inv, cnt, _s = half_edges(F, nV)
        bad_edges = np.where(cnt > 2)[0]
        if len(bad_edges) == 0:
            break
        areas = face_areas(V, F)
        order = np.argsort(inv, kind="stable")
        starts = np.cumsum(cnt) - cnt
        drop = set()
        for e in bad_edges:
            faces = [h // 3 for h in order[starts[e]:starts[e] + cnt[e]]]
            faces = [f for f in faces if f not in drop]
            if len(faces) <= 2:
                continue
            # prefer to keep the two biggest faces
            faces.sort(key=lambda f: areas[f], reverse=True)
            drop.update(faces[2:])
        if not drop:
            break
        keep = np.ones(len(F), dtype=bool)
        keep[list(drop)] = False
        removed += int((~keep).sum())
        F = F[keep]
    return F, removed


def orient(V, F, fix_volume):
    """
    Make winding consistent per connected component (BFS over manifold edges).
    With fix_volume, closed components with negative volume are flipped outward.
    Returns (F, flipped_faces, components, inverted_components).
    """
    m = len(F)
    if m == 0:
        return F, 0, 0, 0
    he, inv, cnt, sign = half_edges(F, len(V))
    order = np.argsort(inv, kind="stable")
    starts = np.cumsum(cnt) - cnt
    e2 = np.where(cnt == 2)[0]
    h1 = order[starts[e2]]
    h2 = order[starts[e2] + 1]
    f1, f2 = h1 // 3, h2 // 3
    same = (sign[h1] == sign[h2])  # same direction => one of the two must flip

    src = np.concatenate([f1, f2])
    dst = np.concatenate([f2, f1])
    w = np.concatenate([same, same])
    o = np.argsort(src, kind="stable")
    dst_l = dst[o].tolist()
    w_l = w[o].tolist()
    indptr = np.concatenate([[0], np.cumsum(np.bincount(src, minlength=m))]).tolist()

    flip = [False] * m
    comp = [-1] * m
    ncomp = 0
    for seed in range(m):
        if comp[seed] != -1:
            continue
        comp[seed] = ncomp
        dq = deque([seed])
        while dq:
            f = dq.popleft()
            ff = flip[f]
            for k in range(indptr[f], indptr[f + 1]):
                g = dst_l[k]
                if comp[g] == -1:
                    comp[g] = ncomp
                    flip[g] = ff ^ w_l[k]
                    dq.append(g)
        ncomp += 1

    flip = np.array(flip, dtype=bool)
    comp = np.array(comp, dtype=np.int64)
    flipped = int(flip.sum())
    F = F.copy()
    F[flip] = F[flip][:, ::-1]

    inverted = 0
    if fix_volume:
        he, inv, cnt, sign = half_edges(F, len(V))
        open_face = np.zeros(m, dtype=bool)
        open_face[(np.where(cnt[inv] != 2)[0]) // 3] = True
        comp_open = np.bincount(comp, weights=open_face, minlength=ncomp) > 0
        t = V[F]
        vol = np.einsum("ij,ij->i", t[:, 0], np.cross(t[:, 1], t[:, 2])) / 6.0
        cvol = np.bincount(comp, weights=vol, minlength=ncomp)
        neg = (cvol < 0) & ~comp_open
        inverted = int(neg.sum())
        if inverted:
            fl = neg[comp]
            F[fl] = F[fl][:, ::-1]
            flipped += int(fl.sum())
    return F, flipped, ncomp, inverted


# ---- hole filling ---------------------------------------------------------- #
def _boundary_loops(F):
    """Closed loops of vertices following the direction new faces must use."""
    he = np.stack([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]], axis=1).reshape(-1, 2)
    keys = set(map(tuple, he.tolist()))
    nxt = {}
    for a, b in keys:
        if (b, a) not in keys:  # boundary half-edge a->b ; the patch uses b->a
            nxt.setdefault(b, []).append(a)
    loops = []
    while nxt:
        start = next(iter(nxt))
        path = [start]
        pos = {start: 0}
        while path:
            cur = path[-1]
            outs = nxt.get(cur)
            if not outs:  # dead end: abandon this path
                break
            v = outs.pop()
            if not outs:
                del nxt[cur]
            if v in pos:
                i = pos[v]
                loops.append(path[i:])
                for x in path[i + 1:]:
                    del pos[x]
                path = path[: i + 1]
                if len(path) == 1 and path[0] not in nxt:
                    break
            else:
                pos[v] = len(path)
                path.append(v)
        # drop whatever dead-end remnants are left for this start vertex
        nxt.pop(start, None)
        for x in path:
            if x in nxt and not nxt[x]:
                del nxt[x]
    return loops


def _ear_clip(P2, idx, existing):
    """Triangulate a CCW 2-D polygon; returns list of (i,j,k) using idx values or None."""
    n = len(idx)
    verts = list(range(n))
    tris = []

    def cross(o, a, b):
        return (P2[a][0] - P2[o][0]) * (P2[b][1] - P2[o][1]) - (P2[a][1] - P2[o][1]) * (P2[b][0] - P2[o][0])

    guard = 0
    while len(verts) > 3 and guard < 10 * n:
        guard += 1
        found = False
        L = len(verts)
        for i in range(L):
            a, b, cc = verts[i - 1], verts[i], verts[(i + 1) % L]
            if cross(a, b, cc) <= 1e-18:
                continue
            ok = True
            for p in verts:
                if p in (a, b, cc):
                    continue
                if cross(a, b, p) >= 0 and cross(b, cc, p) >= 0 and cross(cc, a, p) >= 0:
                    ok = False
                    break
            dk = (min(idx[a], idx[cc]), max(idx[a], idx[cc]))
            if ok and dk in existing:  # would create a 3rd face on an existing edge
                ok = False
            if ok:
                existing.add(dk)
                tris.append((idx[a], idx[b], idx[cc]))
                verts.pop(i)
                found = True
                break
        if not found:
            return None
    if len(verts) == 3:
        tris.append((idx[verts[0]], idx[verts[1]], idx[verts[2]]))
    return tris


def fill_holes(V, F):
    """Cap every open boundary loop. Returns (V, F, holes_filled, loops_skipped)."""
    loops = _boundary_loops(F)
    he = np.stack([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]], axis=1).reshape(-1, 2)
    existing = set(zip(np.minimum(he[:, 0], he[:, 1]).tolist(), np.maximum(he[:, 0], he[:, 1]).tolist()))
    new_faces = []
    new_verts = []
    filled = skipped = 0
    nV = len(V)
    for loop in loops:
        n = len(loop)
        if n < 3:
            skipped += 1
            continue
        P = V[loop]
        # Newell normal (loop is wound in the direction the patch needs)
        nx = np.sum((P[:, 1] - np.roll(P[:, 1], -1)) * (P[:, 2] + np.roll(P[:, 2], -1)))
        ny = np.sum((P[:, 2] - np.roll(P[:, 2], -1)) * (P[:, 0] + np.roll(P[:, 0], -1)))
        nz = np.sum((P[:, 0] - np.roll(P[:, 0], -1)) * (P[:, 1] + np.roll(P[:, 1], -1)))
        normal = np.array([nx, ny, nz])
        nl = np.linalg.norm(normal)
        tris = None
        if n == 3:
            tris = [(loop[0], loop[1], loop[2])]
        elif nl > 1e-18 and n <= 200:
            normal /= nl
            ref = np.array([1.0, 0, 0]) if abs(normal[0]) < 0.9 else np.array([0, 1.0, 0])
            u = np.cross(normal, ref)
            u /= np.linalg.norm(u)
            v = np.cross(normal, u)
            P2 = np.stack([P @ u, P @ v], axis=1).tolist()
            tris = _ear_clip(P2, loop, existing)
        if tris is None:  # centroid fan
            centre = P.mean(axis=0)
            ci = nV + len(new_verts)
            new_verts.append(centre)
            tris = [(loop[i], loop[(i + 1) % n], ci) for i in range(n)]
        new_faces.extend(tris)
        filled += 1
    if new_verts:
        V = np.vstack([V, np.array(new_verts)])
    if new_faces:
        F = np.vstack([F, np.array(new_faces, dtype=np.int64)])
    return V, F, filled, skipped


def compact(V, F):
    used = np.zeros(len(V), dtype=bool)
    used[F.ravel()] = True
    remap = -np.ones(len(V), dtype=np.int64)
    remap[used] = np.arange(used.sum())
    return V[used], remap[F]


# --------------------------------------------------------------------------- #
# Pipeline
# --------------------------------------------------------------------------- #
def count_issues(r):
    return sum(r.get(k, 0) for k in ("degenerate", "duplicate", "nonmanifold", "open", "inconsistent", "inverted"))


def fix_file(src, dst):
    """Repair one file. Returns dict with 'before', 'after', 'faces_in', 'faces_out'."""
    st = Step("Reading")
    tri, note = read_stl(src)
    tri = tri[np.isfinite(tri).all(axis=(1, 2))] if len(tri) else tri
    if len(tri) == 0:
        st.done("no triangles found", "fail")
        raise ValueError("empty mesh")
    st.done(f"{len(tri):,} triangles" + (f"  {yellow(note)}" if note else ""),
            "warn" if note else "ok")

    lo, hi = tri.reshape(-1, 3).min(0), tri.reshape(-1, 3).max(0)
    diag = float(np.linalg.norm(hi - lo)) or 1.0
    tol = max(diag * 1e-7, 1e-9)
    area_eps = (diag ** 2) * 1e-12

    st = Step("Welding vertices")
    n_raw = len(tri) * 3
    V, F = weld(tri, tol)
    st.done(f"{n_raw:,} → {len(V):,} vertices")
    faces_in = len(F)

    # ---- analysis (what slicers would complain about) ----
    st = Step("Analysing")
    before = dict(
        degenerate=int(degenerate_mask(V, F, area_eps).sum()),
        duplicate=int(duplicate_mask(F).sum()),
    )
    before.update(edge_stats(F, len(V)))
    before["inverted"] = 0
    _, _, _, inv0 = orient(V, F, fix_volume=True)
    before["inverted"] = inv0
    n_before = count_issues(before)
    detail = ", ".join(f"{v:,} {k}" for k, v in before.items() if v) or "no issues"
    st.done(f"{n_before:,} findings" if n_before else "no issues found",
            "warn" if n_before else "ok")
    if n_before:
        print(dim(f"      {detail}"))

    # ---- repair ----
    st = Step("Removing degenerate / duplicate")
    bad = degenerate_mask(V, F, area_eps)
    F = F[~bad]
    dup = duplicate_mask(F)
    F = F[~dup]
    st.done(f"{int(bad.sum()):,} degenerate, {int(dup.sum()):,} duplicate removed",
            "ok")

    for p in range(1, 7):
        st = Step(f"Repair pass {p}")
        parts = []
        if p > 1:  # last pass left problems: cut out the area around them and re-patch
            he, inv, cnt, _s = half_edges(F, len(V))
            badv = np.unique(he[(cnt[inv] != 2)].ravel())
            hit = np.isin(F, badv).any(axis=1)
            F = F[~hit]
            parts.append(f"cut {int(hit.sum()):,} tris around bad spots")
        bad = degenerate_mask(V, F, area_eps)
        F = F[~bad]
        F = F[~duplicate_mask(F)]
        F, rm = remove_nonmanifold(V, F)
        if rm:
            parts.append(f"{rm:,} non-manifold tris dropped")
        F, flipped, ncomp, _ = orient(V, F, fix_volume=False)
        if flipped:
            parts.append(f"{flipped:,} flipped")
        V, F, holes, skipped = fill_holes(V, F)
        if holes:
            parts.append(f"{holes:,} hole(s) filled")
        F, _, _, inverted = orient(V, F, fix_volume=True)
        if inverted:
            parts.append(f"{inverted:,} inside-out shell(s) flipped")
        V, F = compact(V, F)
        es = edge_stats(F, len(V))
        left = es["open"] + es["nonmanifold"] + es["inconsistent"]
        res = ", ".join(parts) or "nothing to do"
        if left:
            st.done(f"{res}  → {left} edge problem(s) left", "warn")
        else:
            st.done(res)
            break

    st = Step("Writing")
    write_stl(dst, V, F)
    st.done(f"{os.path.basename(dst)}  ({len(F):,} triangles)")

    st = Step("Verifying saved file")
    tri2, _ = read_stl(dst)
    V2, F2 = weld(tri2, tol)
    after = dict(degenerate=int(degenerate_mask(V2, F2, area_eps).sum()),
                 duplicate=int(duplicate_mask(F2).sum()))
    after.update(edge_stats(F2, len(V2)))
    after["inverted"] = 0
    n_after = count_issues(after)
    st.done("no issues left" if not n_after else ", ".join(f"{v} {k}" for k, v in after.items() if v),
            "ok" if not n_after else "warn")

    return dict(before=before, after=after, n_before=n_before, n_after=n_after,
                faces_in=faces_in, faces_out=len(F))


def find_stls(folder, recursive):
    out = []
    if recursive:
        for root, _dirs, files in os.walk(folder):
            for f in files:
                out.append(os.path.join(root, f))
    else:
        out = [os.path.join(folder, f) for f in os.listdir(folder)
               if os.path.isfile(os.path.join(folder, f))]
    out = [p for p in out
           if p.lower().endswith(".stl") and not os.path.basename(p).lower().startswith("fixed_")]
    return sorted(out)


def main():
    ap = argparse.ArgumentParser(description="Repair STL files (non-manifold edges, holes, flipped normals ...).")
    ap.add_argument("folder", help="folder containing .stl files")
    ap.add_argument("-r", "--recursive", action="store_true", help="also process sub-folders")
    args = ap.parse_args()

    folder = os.path.abspath(os.path.expanduser(args.folder))
    if not os.path.isdir(folder):
        sys.exit(red(f"Not a folder: {folder}"))

    files = find_stls(folder, args.recursive)
    print(bold("STL Fixer"))
    print(dim(f"Folder: {folder}"))
    if not files:
        print(yellow("No .stl files found (files already prefixed fixed_ are skipped)."))
        return 0
    print(f"Found {bold(str(len(files)))} STL file(s)\n")

    t_all = time.time()
    results = []
    for i, src in enumerate(files, 1):
        rel = os.path.relpath(src, folder)
        print(bold(f"[{i}/{len(files)}] {rel}"))
        dst = os.path.join(os.path.dirname(src), "fixed_" + os.path.basename(src))
        t0 = time.time()
        try:
            r = fix_file(src, dst)
            results.append((rel, r, None))
            if r["n_after"] == 0:
                verdict = green("clean") if r["n_before"] == 0 else green(f"fixed {r['n_before']:,} finding(s)")
            else:
                verdict = yellow(f"{r['n_after']:,} issue(s) remain")
            print(f"  → {verdict} {dim('in ' + fmt_time(time.time() - t0))}\n")
        except Exception as exc:  # keep going with the other files
            results.append((rel, None, str(exc)))
            print(f"  {red('✗')} {red('failed:')} {exc}\n")

    # ---- summary ----
    ok = [r for r in results if r[1]]
    failed = [r for r in results if not r[1]]
    total_found = sum(r[1]["n_before"] for r in ok)
    total_left = sum(r[1]["n_after"] for r in ok)
    print(bold("Summary") + dim(f"  ({fmt_time(time.time() - t_all)})"))
    print(f"  Files processed : {len(ok)}/{len(files)}")
    print(f"  Findings        : {total_found:,} found, {green(str(total_found - total_left))} fixed"
          + (f", {yellow(str(total_left))} remaining" if total_left else ""))
    for rel, r, err in results:
        if r is None:
            print(f"   {red('✗')} {rel}  {red(err)}")
        elif r["n_after"]:
            left = ", ".join(f"{v} {k}" for k, v in r["after"].items() if v)
            print(f"   {yellow('!')} {rel}  remaining: {left}")
        else:
            print(f"   {green('✓')} {rel}  {dim(str(r['n_before']) + ' fixed')}")
    return 1 if failed else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\nAborted.")
        sys.exit(130)
