#!/usr/bin/env python3
"""Mutation scorer for test-writing tasks (the Prometheus and Titan lanes),
entered via tests/test.sh. It ships in the task's verifier files at
tests/mutation/score_mutants.py (platform-owned, held byte for byte at
submit) and runs on the verifier runtime's interpreter
(/opt/judge/python/bin/python3) with -I, so it works in a task image of any
language. Standard library only.

What it measures: the submission is a set of test files. Its tests run on
the reference code; only the ones that pass there are eligible. Each mutant
(a small deliberate bug) is then applied in turn and the eligible tests run
against it; a mutant is killed when an eligible test fails on it.

  score     killed mutants / all mutants (the reward, 0-1)
  validity  tests passing on the reference / tests submitted

The task's scoring lives in tests/mutation/scoring.toml:

  kind = "repo"            # "repo" (Prometheus: tests added to a real
                           # repository) or "binary" (Titan: black-box
                           # tests of a program, invoked through $BIN)
  workdir = "/app"         # where the tests run
  run_tests = "..."        # runs $TEST_FILES (newline-separated,
                           # workdir-relative) and writes JUnit XML to
                           # $JUNIT_OUT; $BIN is set on binary tasks. It
                           # must run every test, never stop at the first
                           # failure.
  build = ""               # optional: rebuilds after a mutant is applied
                           # (compiled languages: a mutant that does not
                           # compile is the task's fault, not a kill)
  test_globs = ["..."]     # where submitted tests live, workdir-relative
  source_dir = "/app"      # what mutant patches apply to (patch -p1;
                           # git apply in an image without patch)
  bin = ""                 # binary tasks: the program's path, which $BIN
                           # always names; each binary mutant is swapped
                           # in at that path, so no run can tell from $BIN
  timeout_sec = 900        # one test run
  build_timeout_sec = 900  # one build

Mutants are tests/mutants/<id>.patch (applied to source_dir, then `build`)
or tests/mutants/<id>/bin (a prebuilt program swapped in at `bin`). The id
is the criterion id the platform reads, so name it after what it breaks
(a scenario on repo tasks, a requirement id on binary tasks).

Repo tasks also carry tests/mutation/baseline.json (`score_mutants.py
baseline` writes it): the repository's own test files and test ids at the
task's base. Only test ids absent from it count as submitted, so the
repository's existing tests never earn credit. Every file a patch mutant
touches has its reference copy in tests/mutation/reference/; they are
restored before scoring, so an edit to the code under test cannot shift
the result. A repo task without either leaves the attempt ungraded.

The verifier runs in a container of its own, whose /app is the environment
image as built: `verify` first applies the submitted change
(/logs/artifacts/model.patch, captured in the attempt's container) to /app.
No change applies nothing; a change that does not apply is scored as if
nothing were submitted (0, with apply_failed in reward.json).

The submitted tests never see what grades them: the mutants and reference
copies are read into memory and removed from disk before the first test
runs. Every eligible test also runs against a neutral copy (each file the
mutants touch gains a trailing blank line, the program a trailing byte);
a test that fails there reads the text, not the behaviour, and is
disqualified. The reference runs once more after the mutants; a test that
fails there failed for its own reasons (state it left behind, a count of
its runs) and loses its kills. Every command runs in its own process
group, which is stopped when it ends, so nothing it started outlives it.

Authoring subcommands (the kit runs them; the platform's verify never
does): `check-removal` checks a repo task's tests were taken out cleanly
(the remaining suite passes without them, and nothing left in the repository
or added by tests/mutation/removal.patch still names a removed or gold
test; a name the code under test itself uses counts only where it can only
mean the test), and `matrix [--all-tests]` prints the kill matrix without a verdict
(with --all-tests the repository's own tests count too, which shows the
mutants a copied existing test would earn). `apply-removal <patch> <root>`
takes a repo task's tests out exactly as the kit does (no fuzz, no offset);
the runner builds the model's image with it.

A task the scorer cannot run (a duplicate mutant id, a mutant that does
not apply or build, a reference that does not build, a control run that
leaves no report) leaves the attempt ungraded: infra, never a 0. Outputs
follow the Gold verifier contract: reward.json (numbers only, written
last), grade.json (one criterion per mutant plus the kill matrix) or
ungraded.json.
"""
import contextlib
import glob
import hashlib
import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import tomllib
import xml.etree.ElementTree as ET
from pathlib import Path

TESTS_DIR = Path(os.environ.get("MUTATION_TESTS_DIR", "/tests"))
VERIFIER_DIR = Path(os.environ.get("MUTATION_VERIFIER_DIR", "/logs/verifier"))
# The submitted change as the attempt's container captured it
# (pre_artifacts.sh: `git diff --binary` of /app against the base commit),
# and the tree it applies to. The verifier runs in a container of its own,
# whose /app is the environment image as built.
CHANGE_PATH = Path(os.environ.get("MUTATION_ARTIFACTS_DIR", "/logs/artifacts")) / "model.patch"
CHANGE_DIR = Path(os.environ.get("MUTATION_CHANGE_DIR", "/app"))
CONFIG_PATH = TESTS_DIR / "mutation" / "scoring.toml"
BASELINE_PATH = TESTS_DIR / "mutation" / "baseline.json"
REFERENCE_DIR = TESTS_DIR / "mutation" / "reference"
MUTANTS_DIR = TESTS_DIR / "mutants"
RESULT_FILES = ("reward.txt", "reward.json", "ungraded.json", "grade.json")
MUTANT_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}")
LOG_TAIL = 4000


class Ungraded(Exception):
    """The task, not the submission, kept the scorer from running."""


def log(msg):
    print(f"[mutation] {msg}", flush=True)


# ─── Config and hidden material ────────────────────────────────────────────

def load_config(path=CONFIG_PATH):
    try:
        raw = tomllib.loads(Path(path).read_text())
    except (OSError, tomllib.TOMLDecodeError) as e:
        raise Ungraded(f"scoring.toml unreadable: {e}")
    kind = raw.get("kind")
    if kind not in ("repo", "binary"):
        raise Ungraded("scoring.toml: kind must be 'repo' or 'binary'")
    if not isinstance(raw.get("run_tests"), str) or not raw["run_tests"].strip():
        raise Ungraded("scoring.toml: run_tests is required")
    globs = raw.get("test_globs")
    if not isinstance(globs, list) or not globs or not all(isinstance(g, str) and g for g in globs):
        raise Ungraded("scoring.toml: test_globs must be a non-empty list")
    workdir = raw.get("workdir", "/app")
    cfg = {
        "kind": kind,
        "workdir": Path(workdir),
        "run_tests": raw["run_tests"],
        "build": raw.get("build") or "",
        "test_globs": globs,
        "source_dir": Path(raw.get("source_dir", workdir)),
        "bin": raw.get("bin") or "",
        "timeout_sec": int(raw.get("timeout_sec", 900)),
        "build_timeout_sec": int(raw.get("build_timeout_sec", 900)),
    }
    if kind == "binary" and not cfg["bin"]:
        raise Ungraded("scoring.toml: binary tasks need bin")
    return cfg


def patched_files(patch_text):
    """Paths (with -p1 stripped) a unified diff writes."""
    out = []
    for line in patch_text.decode("utf-8", "replace").splitlines():
        if line.startswith("+++ "):
            target = line[4:].split("\t")[0].strip()
            if target == "/dev/null":
                continue
            parts = target.split("/", 1)
            out.append(parts[1] if len(parts) == 2 else parts[0])
    return out


def load_mutants(mutants_dir=MUTANTS_DIR):
    """Every mutant, its content read into memory."""
    if not mutants_dir.is_dir():
        raise Ungraded("no tests/mutants directory")
    out, seen = [], set()
    for entry in sorted(mutants_dir.iterdir(), key=lambda p: p.name):
        if entry.is_file() and entry.suffix == ".patch":
            mid, kind, data = entry.stem, "patch", entry.read_bytes()
        elif entry.is_dir() and (entry / "bin").is_file():
            mid, kind, data = entry.name, "bin", (entry / "bin").read_bytes()
        else:
            continue
        if not MUTANT_ID_RE.fullmatch(mid):
            raise Ungraded(f"mutant id not allowed: {mid!r}")
        if mid in seen:
            raise Ungraded(f"two mutants share the id {mid!r}")
        seen.add(mid)
        m = {"id": mid, "kind": kind, "data": data}
        if kind == "patch":
            m["files"] = patched_files(data)
        out.append(m)
    if not out:
        raise Ungraded("no mutants")
    return out


def load_reference(cfg, mutants, ref_dir=REFERENCE_DIR):
    """{source-relative path: reference bytes} for every file a patch mutant
    touches; a repo task must ship all of them."""
    touched = sorted({f for m in mutants if m["kind"] == "patch" for f in m["files"]})
    copies = {}
    for rel in touched:
        src = ref_dir / rel
        if src.is_file():
            copies[rel] = src.read_bytes()
        elif cfg["kind"] == "repo":
            raise Ungraded(f"no reference copy of {rel}")
    return copies


def load_baseline(cfg, path=BASELINE_PATH):
    if cfg["kind"] != "repo":
        return {"files": {}, "test_ids": []}
    if not path.is_file():
        raise Ungraded("baseline.json missing")
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError) as e:
        raise Ungraded(f"baseline.json unreadable: {e}")
    return {"files": dict(data.get("files") or {}), "test_ids": list(data.get("test_ids") or [])}


def hide(*dirs):
    """Remove grading material from disk before any submitted test runs."""
    for d in dirs:
        shutil.rmtree(d, ignore_errors=True)


# ─── Submitted tests ───────────────────────────────────────────────────────

def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def matching_files(workdir, globs):
    found = set()
    for pattern in globs:
        for p in glob.glob(str(workdir / pattern), recursive=True):
            path = Path(p)
            if path.is_file() and not path.is_symlink():
                found.add(path.relative_to(workdir).as_posix())
    return sorted(found)


def submitted_files(cfg, baseline):
    """Test files to run: on repo tasks the ones new or changed since the
    base (an unchanged file holds only the repository's own tests); on
    binary tasks every file the globs match."""
    files = matching_files(cfg["workdir"], cfg["test_globs"])
    if cfg["kind"] != "repo":
        return files
    base = baseline["files"]
    return [f for f in files if base.get(f) != sha256_file(cfg["workdir"] / f)]


# ─── Running ───────────────────────────────────────────────────────────────

def stop_group(proc):
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass


def run_command(cmd, cwd, env, timeout):
    """Run `cmd` in its own process group; whatever it started is stopped
    when it returns or times out."""
    started = time.monotonic()
    proc = subprocess.Popen(["/bin/bash", "-c", cmd], cwd=cwd, env=env, start_new_session=True,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    timed_out = False
    try:
        out, _ = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        stop_group(proc)
        out, _ = proc.communicate()
    stop_group(proc)
    text = (out or b"").decode("utf-8", "replace")
    return {"rc": None if timed_out else proc.returncode, "timed_out": timed_out,
            "out": text[-LOG_TAIL:], "seconds": time.monotonic() - started}


class Report(dict):
    """{test id: status}, and in .repeats the ids parse_junit numbered
    (`x#2` -> `x`), so a test whose own name ends in #2 is never taken for
    a repeat."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.repeats = {}


def parse_junit(path):
    """{test id: 'passed' | 'failed' | 'skipped'} from a JUnit XML report, or
    None when there is no readable report. The id is classname::name; a
    repeated id gets #2, #3 ... in order."""
    try:
        root = ET.parse(path).getroot()
    except (OSError, ET.ParseError):
        return None
    results, seen = Report(), {}
    for case in root.iter("testcase"):
        cls = case.get("classname") or case.get("file") or ""
        name = case.get("name") or ""
        tid = f"{cls}::{name}" if cls else name
        seen[tid] = seen.get(tid, 0) + 1
        if seen[tid] > 1:
            results.repeats[f"{tid}#{seen[tid]}"] = tid
            tid = f"{tid}#{seen[tid]}"
        if case.find("failure") is not None or case.find("error") is not None:
            status = "failed"
        elif case.find("skipped") is not None:
            status = "skipped"
        else:
            status = "passed"
        results[tid] = status
    return results


def repeat_root(tid, report):
    """The id a repeated test was numbered from (`x#3` is the third `x`), as
    parse_junit recorded it; any other id is its own root."""
    return getattr(report, "repeats", {}).get(tid, tid)


def run_tests(cfg, files):
    """Run `files` once: the per-test results, or None when the run timed
    out or left no report, and the run record."""
    with tempfile.TemporaryDirectory(prefix="mutation-") as tmp:
        junit = Path(tmp) / "junit.xml"
        env = dict(os.environ)
        env["TEST_FILES"] = "\n".join(files)
        env["JUNIT_OUT"] = str(junit)
        # A fresh bytecode cache per run: a mutant's .pyc must never serve the
        # next one (same size, same second would pass Python's check).
        env["PYTHONPYCACHEPREFIX"] = str(Path(tmp) / "pycache")
        if cfg["bin"]:
            env["BIN"] = cfg["bin"]
        rec = run_command(cfg["run_tests"], cfg["workdir"], env, cfg["timeout_sec"])
        results = None if rec["timed_out"] else parse_junit(junit)
    return results, rec


def signal_name(n):
    try:
        return signal.Signals(n).name
    except ValueError:
        return f"signal {n}"


def how_it_ended(rec, setting, limit):
    """What a failed command did, never empty: timed out after `limit`
    seconds (the scoring.toml `setting`) or its exit code, with the signal
    that stopped it when there is one (bash reports a killed child as 128 +
    the signal), then the output's tail or that there was none."""
    if rec["timed_out"]:
        why = f"timed out after {limit}s ({setting} in scoring.toml)"
    else:
        rc = rec["rc"]
        sig = -rc if rc < 0 else rc - 128 if 128 < rc < 128 + 65 else None
        why = f"exit code {rc}"
        if sig is not None:
            why += f" ({signal_name(sig)}"
            why += ": killed, most often for running out of memory)" if sig == signal.SIGKILL else ")"
    out = rec["out"].strip()
    return f"{why}; output: {out[-800:]}" if out else f"{why}; no output"


def build(cfg, what):
    if not cfg["build"]:
        return
    env = dict(os.environ)
    if cfg["bin"]:
        env["BIN"] = cfg["bin"]
    rec = run_command(cfg["build"], cfg["source_dir"], env, cfg["build_timeout_sec"])
    if rec["timed_out"] or rec["rc"] != 0:
        raise Ungraded(f"build failed for {what}: "
                       + how_it_ended(rec, "build_timeout_sec", cfg["build_timeout_sec"]))


_last_stamp = [0.0]


def stamp(paths):
    """Give `paths` an mtime strictly later than any this run has set, so a
    build cache keyed on mtime (make, cargo) never mistakes a mutant for the
    file it replaced within the same second."""
    t = max(time.time(), _last_stamp[0] + 1.0)
    _last_stamp[0] = t
    for p in paths:
        if p.exists():
            os.utime(p, (t, t))


@contextlib.contextmanager
def patch_file(patch_text):
    with tempfile.NamedTemporaryFile(prefix="mutation-", suffix=".patch", delete=False) as f:
        f.write(patch_text)
        name = f.name
    try:
        yield name
    finally:
        os.unlink(name)


def patch_command(patch_text, source_dir, extra):
    with patch_file(patch_text) as name:
        try:
            return subprocess.run(["patch", "-p1", "--batch", "--silent", *extra, "-i", name],
                                  cwd=source_dir, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        except FileNotFoundError:
            # The task image, not the submission: ungraded, never a crash or a 0.
            raise Ungraded("neither git nor patch is installed in the task image")


def git_apply(git, args, root):
    """git apply in `root`, in a work tree or not (never one above `root`),
    with no hook, fsmonitor or prompt of the image's run."""
    env = dict(os.environ, GIT_CEILING_DIRECTORIES=str(Path(root).resolve().parent),
               GIT_TERMINAL_PROMPT="0")
    return subprocess.run([git, "-c", "safe.directory=*", "-c", "core.hooksPath=/dev/null",
                           "-c", "core.fsmonitor=false", "apply", "--whitespace=nowarn", *args],
                          cwd=root, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)


# Where the image has no patch(1), git apply takes a mutant with the nearest
# tolerance to patch's defaults: one line of context each side may stand for
# the three (patch's fuzz 2), offsets are found, and a hunk with no context
# (diff -U0) applies. A -U1 or -U2 hunk whose every context line drifted is
# still refused, where patch would fuzz it in.
MUTANT_GIT_FLAGS = ["-C1", "--unidiff-zero"]


def mutant_command(patch_text, source_dir, reverse=False, check=False):
    """Apply a mutant to source_dir (or revert it; with `check`, only try):
    patch(1) as always, git apply only in an image without patch."""
    git = shutil.which("git")
    if shutil.which("patch") or not git:
        return patch_command(patch_text, source_dir, (["-R"] if reverse else ["--forward"])
                             + (["--dry-run"] if check else []))
    with patch_file(patch_text) as name:
        return git_apply(git, MUTANT_GIT_FLAGS + (["-R"] if reverse else [])
                         + (["--check"] if check else []) + [name], source_dir)


def apply_patch(m, source_dir, reverse=False, dry_run=False):
    # patch(1) cannot apply a binary block and git would, past the reference
    # copies and the neutral check (they read only the text files' headers).
    if re.search(rb"^GIT binary patch\r?$", m["data"], re.M):
        raise Ungraded(f"mutant {m['id']} changes a binary file; a mutant changes text only")
    dry = mutant_command(m["data"], source_dir, reverse, check=True)
    if dry.returncode != 0:
        raise Ungraded(f"mutant {m['id']} does not {'revert' if reverse else 'apply'}: "
                       f"{dry.stdout.decode('utf-8', 'replace')[-800:]}")
    if dry_run:
        return
    mutant_command(m["data"], source_dir, reverse)
    stamp([Path(source_dir) / f for f in m["files"]])


def apply_change(change_path=CHANGE_PATH, root=CHANGE_DIR):
    """Apply the submitted change to `root` before anything is scored. None
    when it applied or nothing was submitted; otherwise why it did not apply
    (the submission's doing: the attempt is graded with nothing submitted).
    git applies it whole or not at all, binary hunks included, in a work tree
    or not (never one above `root`); without git, patch checks it with a dry
    run first."""
    if not change_path.is_file() or change_path.stat().st_size == 0:
        log("no change submitted")
        return None
    if not root.is_dir():
        raise Ungraded(f"no {root} to apply the submitted change to")
    git = shutil.which("git")
    if git:
        r = git_apply(git, [str(change_path)], root)
        if r.returncode != 0:
            return r.stdout.decode("utf-8", "replace")[-800:] or "git apply failed"
    else:
        data = change_path.read_bytes()
        dry = patch_command(data, root, ["--forward", "--dry-run"])
        if dry.returncode != 0:
            return dry.stdout.decode("utf-8", "replace")[-800:] or "patch failed"
        patch_command(data, root, ["--forward"])
    log(f"applied the submitted change ({change_path.stat().st_size} bytes)")
    return None


def write_program(path, data):
    """Swap the program at `path` in place (same path, same directory, same
    mode), so a test can tell runs apart only by what the program does. A
    symbolic link stays a link: its target is what is swapped."""
    p = Path(path).resolve()
    mode = p.stat().st_mode if p.exists() else 0o755
    tmp = p.with_name(f".{p.name}.swap")
    tmp.write_bytes(data)
    os.chmod(tmp, mode)
    os.replace(tmp, p)


def restore_reference(cfg, copies):
    for rel, data in copies.items():
        dst = cfg["source_dir"] / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_bytes(data)
        stamp([dst])


# ─── Scoring ───────────────────────────────────────────────────────────────

def control_run(cfg, files, what):
    results, rec = run_tests(cfg, files)
    if results is None:
        raise Ungraded(f"the {what} run left no report: "
                       + how_it_ended(rec, "timeout_sec", cfg["timeout_sec"]))
    return results


def neutral_check(cfg, mutants, files, eligible, copies, ref_program):
    """Eligible tests that fail when the code under test changes in a way no
    behaviour can see: they read the text, not what it does."""
    touched = sorted({f for m in mutants if m["kind"] == "patch" for f in m["files"]})
    targets = [cfg["source_dir"] / rel for rel in touched if (cfg["source_dir"] / rel).is_file()]
    neutral_program = ref_program is not None and any(m["kind"] == "bin" for m in mutants)
    if not targets and not neutral_program:
        return set()
    saved = []
    try:
        for t in targets:
            saved.append((t, t.read_bytes()))
            with open(t, "ab") as f:
                f.write(b"\n")
        stamp(targets)
        if neutral_program:
            # A trailing byte past the end of an executable is never loaded.
            write_program(cfg["bin"], ref_program + b"\0")
        build(cfg, "the neutral copy")
        results = control_run(cfg, files, "neutral")
        return {t for t in eligible if results.get(t) != "passed"}
    finally:
        for t, data in saved:
            t.write_bytes(data)
        stamp([t for t, _ in saved])
        if neutral_program:
            write_program(cfg["bin"], ref_program)
        if targets:
            build(cfg, "the reference")


def kills(results, eligible, known):
    """The eligible tests a mutant run killed. A test the report marks
    failed kills. A test missing from the report kills only when the tests
    could not load: the run left no report at all (it timed out, the tests
    no longer compile), the report holds none of the reference run's tests,
    or it holds a failure the reference run never had (a test module that
    failed while loading). A test merely left out after another, known test
    failed does not kill."""
    if results is None:
        return sorted(eligible)
    load_failed = (not any(t in known for t in results)
                   or any(s == "failed" and t not in known for t, s in results.items()))
    return sorted(t for t in eligible
                  if results.get(t) == "failed" or (load_failed and t not in results))


def score(cfg, mutants, baseline, copies, ref_program):
    restore_reference(cfg, copies)
    if copies:
        log(f"restored {len(copies)} reference file(s)")
    if ref_program is not None:
        write_program(cfg["bin"], ref_program)
    build(cfg, "the reference")

    files = submitted_files(cfg, baseline)
    log(f"{len(files)} submitted test file(s)")
    base_ids = set(baseline["test_ids"])
    tests = {}
    eligible = set()
    known = set()
    if files:
        ref, rec = run_tests(cfg, files)
        log(f"reference run: {len(ref or {})} test(s) in {rec['seconds']:.0f}s"
            + (" (timed out)" if rec["timed_out"] else "")
            + ("" if ref is not None else " (no report)"))
        known = set(ref or {})
        for tid, status in (ref or {}).items():
            # A repeated id is numbered by its place in the report (#2, #3),
            # so a new test of the same name placed above a base test would
            # hand that base test a fresh number: a repeat of an id the base
            # has belongs to the base.
            if tid in base_ids or repeat_root(tid, ref) in base_ids:
                continue
            tests[tid] = status
            if status == "passed":
                eligible.add(tid)
    disqualified = set()
    if eligible:
        disqualified = neutral_check(cfg, mutants, files, eligible, copies, ref_program)
        for tid in disqualified:
            tests[tid] = "disqualified"
        eligible -= disqualified
        if disqualified:
            log(f"{len(disqualified)} test(s) fail on the neutral copy and are disqualified")

    matrix = {}
    seconds = {}
    for m in mutants:
        started = time.monotonic()
        killers = []
        if not eligible:
            # Nothing to run, but a mutant that cannot apply is still the
            # task's fault, never a graded 0.
            if m["kind"] == "patch":
                apply_patch(m, cfg["source_dir"], dry_run=True)
        elif m["kind"] == "patch":
            apply_patch(m, cfg["source_dir"])
            try:
                build(cfg, f"mutant {m['id']}")
                results, _ = run_tests(cfg, files)
            finally:
                apply_patch(m, cfg["source_dir"], reverse=True)
            killers = kills(results, eligible, known)
        else:
            write_program(cfg["bin"], m["data"])
            try:
                results, _ = run_tests(cfg, files)
            finally:
                write_program(cfg["bin"], ref_program)
            killers = kills(results, eligible, known)
        matrix[m["id"]] = killers
        seconds[m["id"]] = round(time.monotonic() - started, 1)

    # The reference once more, after every mutant: a test that no longer
    # passes on it failed for its own reasons (state it left behind, a count
    # of its runs), not because of a mutant, so its kills are dropped.
    if eligible:
        if any(m["kind"] == "patch" for m in mutants):
            build(cfg, "the reference after the mutants")
        control = control_run(cfg, files, "closing reference")
        late = {t for t in eligible if control.get(t) != "passed"}
        if late:
            log(f"{len(late)} test(s) fail on the reference after the mutants and are disqualified")
            for tid in late:
                tests[tid] = "disqualified"
            eligible -= late
            disqualified |= late
            matrix = {mid: [t for t in killers if t not in late] for mid, killers in matrix.items()}

    rows = []
    for m in mutants:
        killers = matrix[m["id"]]
        rows.append({"id": m["id"], "passed": bool(killers), "evaluated": True, "blocker": False,
                     "method": "mutation", "weight": 1, "seconds": seconds[m["id"]],
                     "rationale": f"killed by {len(killers)} test(s)" if killers else "survived"})
        log(f"{m['id']}: {'killed' if killers else 'survived'}")

    total = len(mutants)
    killed = sum(1 for r in rows if r["passed"])
    s = killed / total
    validity = len(eligible) / len(tests) if tests else 0.0
    numbers = {
        "reward": round(s, 6),
        "solved": 1 if killed == total else 0,
        "score": round(s, 6),
        "blockers_passed": 1,
        "flagged": 0,
        "criteria_total": total,
        "criteria_passed": killed,
        "validity": round(validity, 6),
        "tests_total": len(tests),
        "tests_valid": len(eligible),
        "tests_disqualified": len(disqualified),
    }
    return {"numbers": numbers, "criteria": rows, "kill_matrix": matrix, "tests": tests}


def write_outputs(graded):
    VERIFIER_DIR.mkdir(parents=True, exist_ok=True)
    for name in RESULT_FILES:
        (VERIFIER_DIR / name).unlink(missing_ok=True)
    detail = dict(graded["numbers"])
    detail["blockers_passed"] = True
    detail["flagged"] = False
    detail["criteria"] = graded["criteria"]
    detail["kill_matrix"] = graded["kill_matrix"]
    detail["tests"] = graded["tests"]
    (VERIFIER_DIR / "grade.json").write_text(json.dumps(detail, indent=1))
    # reward.json last: its presence is what marks the attempt graded.
    (VERIFIER_DIR / "reward.json").write_text(json.dumps(graded["numbers"]))


def write_ungraded(reason):
    VERIFIER_DIR.mkdir(parents=True, exist_ok=True)
    for name in RESULT_FILES:
        (VERIFIER_DIR / name).unlink(missing_ok=True)
    (VERIFIER_DIR / "ungraded.json").write_text(json.dumps({"ungraded": True, "reason": reason[:2000]}))


# ─── Clean removal (repo tasks) ────────────────────────────────────────────
#
# A repo task is made by taking tests out of a real repository; the gold
# tests put them (or better ones) back. Taken out cleanly means two things:
# the repository's remaining suite still passes without them, and nothing
# left in the repository points at what was taken out (a comment naming a
# removed test, a TODO, a fixture or conftest entry only it used, a module
# list naming its file), which would tell the model where the gaps are.

REMOVAL_PATCH_PATH = TESTS_DIR / "mutation" / "removal.patch"
SCAN_SKIP_DIRS = {".git", ".hg", ".svn", "node_modules", "target", "build", "dist", "out",
                  "__pycache__", ".venv", "venv", ".tox", ".nox", ".mypy_cache",
                  ".pytest_cache", ".ruff_cache", ".gradle", ".idea", ".vscode", "vendor",
                  "third_party", ".cargo", "coverage", ".next"}
SCAN_MAX_BYTES = 1 << 20
# Names too common to say anything about a removed test.
GENERIC_NAMES = {"test", "tests", "main", "init", "setup", "teardown", "setUp", "tearDown",
                 "setUpClass", "tearDownClass", "setup_method", "teardown_method",
                 "setup_module", "teardown_module", "setup_class", "teardown_class",
                 "fixture", "fixtures", "helper", "helpers", "utils", "util", "index",
                 "conftest", "common", "mod", "lib", "self", "None", "True", "False",
                 "beforeEach", "afterEach", "beforeAll", "afterAll", "describe", "expect",
                 "TestCase", "TestMain", "run", "check", "assert", "spec", "specs"}
MIN_NAME_LEN = 5
TEST_FILE_RE = re.compile(r"(^|/)(tests?|spec|specs|__tests__|testing)/|(^|/)test_[^/]+$|"
                          r"_test\.[a-z]+$|[._](test|spec)\.[a-z]+$|Tests?\.(java|kt|cs|scala)$|"
                          r"(^|/)conftest\.py$")
# Definitions in a test file: every named function, class or method.
DEF_RES = [
    re.compile(r"^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)"),                       # python
    re.compile(r"^\s*class\s+([A-Za-z_]\w*)"),                                  # python, java, ts, kotlin
    re.compile(r"^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)"),                  # go
    re.compile(r"^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)"),  # rust
    re.compile(r"^\s*(?:@\w+\s+)*(?:(?:public|protected|private|static|final|synchronized|"
               r"internal|open|override|suspend)\s+)*(?:void|fun|Unit)\s+([A-Za-z_]\w*)\s*\("),  # java, kotlin
    re.compile(r"^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)"),  # js/ts
    re.compile(r"^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\("),
]
# Test-shaped names anywhere (a test inline in a source file).
TEST_DEF_RES = [
    re.compile(r"^\s*(?:async\s+)?def\s+(test_?\w*)"),
    re.compile(r"^\s*class\s+(Test\w*|\w+Tests?)\b"),
    re.compile(r"^\s*func\s+((?:Test|Example|Fuzz)\w*)"),
]
# Titles of js/ts tests, and C++ gtest cases.
# The title may follow a parameterised call: test.each([...])('title', ...).
TITLE_RE = re.compile(r"\b(?:it|test|describe|context|suite)(?:\.\w+)*(?:\s*\([^()]*\))?"
                      r"\s*\(\s*(['\"`])((?:(?!\1).){4,200})\1")
GTEST_RE = re.compile(r"\b(?:TEST|TEST_F|TEST_P|TYPED_TEST)\s*\(\s*(\w+)\s*,\s*(\w+)\s*\)")
RUST_TEST_ATTR_RE = re.compile(r"#\[(?:\w+::)*test\b")
COMMENT_RE = re.compile(r"^\s*(#|//|/\*|\*|--|;|<!--|%)")
TODO_RE = re.compile(r"\b(TODO|FIXME|XXX|HACK)\b")
# The code under test: a name its source uses is the repository's own
# vocabulary (a test helper named `table` in a table store), not a pointer
# at a removed test. Docs, configs and CI files never make a name vocabulary.
SOURCE_EXTS = {".rs", ".py", ".go", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".java", ".kt",
               ".kts", ".scala", ".cs", ".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh", ".rb",
               ".php", ".swift", ".m", ".mm", ".ex", ".exs", ".erl", ".hs", ".ml", ".clj", ".dart",
               ".lua", ".zig", ".nim", ".jl"}
# A line that only declares or imports a module: on its own it makes no
# name vocabulary (`mod server_quota_tests;` is the leftover, not a use).
IMPORT_LINE_RE = re.compile(r"^\s*(?:pub(?:\([^)]*\))?\s+)?(?:mod|use|import|from|extern\s+crate|"
                            r"#\s*include|require|include|using)\b|\b(?:require|import)\s*\(")
IDENT_RE = re.compile(r"[A-Za-z_$][A-Za-z0-9_$]*")
# A test runner told which tests to run or skip. The runner is found by
# its executable's name (a path to it included); a shell line is cut into
# commands at `&&`, `||`, `;` and `|`, and a backslash-continued command is
# read whole. Only what selects tests counts: a selector option's value,
# anywhere in it (`-k "not table"`, `-E 'test(quotas)'`), or a bare
# positional filter naming the test (`cargo test quotas`, `a.py::quotas`);
# never a coverage target, a report path or any other option's value. A
# pytest `addopts` setting is read as runner arguments.
RUNNERS = {"pytest", "py.test", "jest", "vitest", "mocha", "rspec", "ctest", "phpunit"}
RUNNER_PAIRS = {("cargo", "test"), ("cargo", "nextest"), ("go", "test"), ("dotnet", "test"),
                ("bun", "test"), ("deno", "test"), ("mix", "test"), ("swift", "test"),
                ("npm", "test"), ("pnpm", "test"), ("yarn", "test"), ("make", "test"),
                ("gradle", "test"), ("gradlew", "test"), ("mvn", "test")}
SELECTOR_OPTIONS = {"-k", "-E", "--filter", "--test", "--tests", "--skip", "-run", "--run", "-skip",
                    "--grep", "-g", "-t", "--testNamePattern", "--gtest_filter", "-R",
                    "--exclude-regex", "--tests-regex", "--example", "-e", "-m", "-Dtest",
                    "-Dit.test", "--testPathPattern"}
# Options known to take a value that selects nothing.
VALUE_OPTIONS = {"--features", "-F", "--package", "-p", "--manifest-path", "--target", "--profile",
                 "--cov", "--junitxml", "--log-file", "-o", "--config", "-c", "--rootdir",
                 "--color", "-j", "--jobs", "--exclude", "--reporter", "--outputFile", "--basetemp",
                 "--junit-xml", "--logger", "--results-directory", "--cargo-profile"}
COMMAND_SPLIT_RE = re.compile(r"&&|\|\||;|\|")
# Build tools whose test task may carry a prefix (`:app:test`, `integrationTest`).
TASK_RUNNERS = {"gradle", "gradlew", "mvn", "make"}
ADDOPTS_RE = re.compile(r"^\s*['\"]?addopts['\"]?\s*[=:]\s*(.*)$")


def glob_regex(pattern):
    """A workdir-relative glob (with **) as a regex over posix paths."""
    out, i = "", 0
    while i < len(pattern):
        c = pattern[i]
        if pattern.startswith("**/", i):
            out += "(?:.*/)?"
            i += 3
            continue
        if pattern.startswith("**", i):
            out += ".*"
            i += 2
            continue
        out += "[^/]*" if c == "*" else "[^/]" if c == "?" else re.escape(c)
        i += 1
    return re.compile(out + "$")


def is_test_path(rel, globs):
    return bool(TEST_FILE_RE.search(rel)) or any(glob_regex(g).match(rel) for g in globs)


HUNK_RE = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")


def split_patch(patch_text):
    """[{path, removed_file, removed, added, hunks}] per file of a unified
    diff (paths with -p1 stripped). Each hunk holds its removed and added
    lines and its whole before (`pre`) and after (`post`) image; hunk bodies
    are read by the line counts in their headers, so a removed line that
    starts with "--" is never taken for a file header."""
    files, cur = [], None
    lines = patch_text.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        i += 1
        if line.startswith("--- ") and i < len(lines) and lines[i].startswith("+++ "):
            src = line[4:].split("\t")[0].strip()
            dst = lines[i][4:].split("\t")[0].strip()
            i += 1
            removed_file = dst == "/dev/null"
            parts = (src if removed_file else dst).split("/", 1)
            cur = {"path": parts[1] if len(parts) == 2 else parts[0], "removed_file": removed_file,
                   "removed": [], "added": [], "hunks": []}
            files.append(cur)
            continue
        m = HUNK_RE.match(line)
        if not m or cur is None:
            continue
        old = int(m.group(2)) if m.group(2) is not None else 1
        new = int(m.group(4)) if m.group(4) is not None else 1
        # Where each image starts (0-based) in the old and the new file; an
        # empty image sits just past the line its header names.
        hunk = {"removed": [], "added": [], "pre": [], "post": [],
                "old_start": max(int(m.group(1)) - (1 if old else 0), 0),
                "new_start": max(int(m.group(3)) - (1 if new else 0), 0)}
        cur["hunks"].append(hunk)
        while (old > 0 or new > 0) and i < len(lines):
            body = lines[i]
            i += 1
            if body.startswith("\\"):
                continue
            tag, text = body[:1], body[1:]
            if tag == "-":
                hunk["removed"].append(text)
                hunk["pre"].append(text)
                old -= 1
            elif tag == "+":
                hunk["added"].append(text)
                hunk["post"].append(text)
                new -= 1
            else:
                hunk["pre"].append(text)
                hunk["post"].append(text)
                old -= 1
                new -= 1
        cur["removed"] += hunk["removed"]
        cur["added"] += hunk["added"]
    return files


def defined_names(lines, test_file):
    """{name: kind} the lines define: every definition in a test file, only
    test-shaped ones elsewhere; js titles and gtest cases everywhere."""
    names = {}
    after_test_attr = False
    for line in lines:
        for rx in (DEF_RES if test_file else TEST_DEF_RES):
            m = rx.match(line)
            if m:
                names.setdefault(m.group(1), "identifier")
                break
        if after_test_attr:
            m = DEF_RES[3].match(line)
            if m:
                names.setdefault(m.group(1), "identifier")
                after_test_attr = False
        if RUST_TEST_ATTR_RE.search(line):
            after_test_attr = True
        for m in TITLE_RE.finditer(line):
            names.setdefault(m.group(2), "title")
        for m in GTEST_RE.finditer(line):
            names.setdefault(m.group(2), "identifier")
    return {n: k for n, k in names.items()
            if n not in GENERIC_NAMES and (k == "title" or len(n) >= MIN_NAME_LEN)}


def scan_files(root):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in SCAN_SKIP_DIRS)
        for fn in sorted(filenames):
            p = Path(dirpath) / fn
            try:
                if p.is_symlink() or p.stat().st_size > SCAN_MAX_BYTES:
                    continue
                data = p.read_bytes()
            except OSError:
                continue
            if b"\0" in data[:8192]:
                continue
            yield p.relative_to(root).as_posix(), data.decode("utf-8", "replace")


def name_pattern(name, kind):
    if kind == "title":
        return re.compile(r"(?<!\w)" + re.escape(name) + r"(?!\w)")
    return re.compile(r"(?<![A-Za-z0-9_$])" + re.escape(name) + r"(?![A-Za-z0-9_$])")


def leftover_kind(rel, line):
    if TODO_RE.search(line):
        return "todo"
    if COMMENT_RE.match(line):
        return "comment"
    if re.search(r"(^|/)(conftest\.py|fixtures?/|testdata/|__fixtures__/|setup_tests?\.)", rel) \
            or "fixture" in line.lower():
        return "fixture"
    return "reference"


# How each source language writes comments and strings: its line comment
# marks, its block comment, and its string quotes (a triple quote first).
# Unlisted source languages read as C-like.
C_LIKE = (("//",), ("/*", "*/"), ('"', "'", "`"))
LEXICON = {
    ".py": (("#",), None, ('"""', "'''", '"', "'")),
    ".rb": (("#",), None, ('"', "'", "`")),
    ".ex": (("#",), None, ('"""', '"', "'")),
    ".exs": (("#",), None, ('"""', '"', "'")),
    ".jl": (("#",), ("#=", "=#"), ('"""', '"', "`")),
    ".nim": (("#",), ("#[", "]#"), ('"""', '"', "'")),
    ".php": (("//", "#"), ("/*", "*/"), ('"', "'", "`")),
    ".hs": (("--",), ("{-", "-}"), ('"',)),
    ".lua": (("--",), ("--[[", "]]"), ('"', "'")),
    ".erl": (("%",), None, ('"',)),
    ".clj": ((";",), None, ('"',)),
    ".ml": ((), ("(*", "*)"), ('"',)),
    ".kt": (("//",), ("/*", "*/"), ('"""', '"', "'")),
    ".kts": (("//",), ("/*", "*/"), ('"""', '"', "'")),
    ".swift": (("//",), ("/*", "*/"), ('"""', '"')),
    ".scala": (("//",), ("/*", "*/"), ('"""', '"', "'")),
    ".dart": (("//",), ("/*", "*/"), ('"""', "'''", '"', "'")),
}
RUST_CHAR_RE = re.compile(r"'(?:\\.|[^'\\])'")
DIGIT_SEPARATED_RE = re.compile(r"(?<![\w$])(?:0[xXbB][0-9A-Fa-f']*|\d[\d']*)$")


def code_lines(text, ext):
    """The file's lines with every comment and string blanked out, a block
    comment or string that spans lines included. Rust's `'a` is a
    lifetime, not a quote. Unsure text is blanked: a name read from less
    code is sought in more places, never fewer."""
    line_marks, block, quotes = LEXICON.get(ext, C_LIKE)
    if ext == ".rs":
        quotes = ('"',)
    out, cur, i, state = [], [], 0, None
    while i < len(text):
        c = text[i]
        if c == "\n":
            out.append("".join(cur))
            cur = []
            i += 1
            if state is not None and state[0] == "line":
                state = None
            continue
        if state is None:
            if ext == ".rs" and c == "'":
                m = RUST_CHAR_RE.match(text, i)
                if m:
                    cur.append(" ")
                    i = m.end()
                    continue
            mark = next((m for m in line_marks if text.startswith(m, i)), None)
            if mark is not None:
                state = ("line", None)
                i += len(mark)
                continue
            if block and text.startswith(block[0], i):
                state = ("block", block[1])
                cur.append(" ")
                i += len(block[0])
                continue
            q = next((q for q in quotes if text.startswith(q, i)), None)
            if q == "'" and DIGIT_SEPARATED_RE.search(text[max(0, i - 64):i]):
                q = None  # 1'000: a digit separator, not a quote
            if q is not None:
                state = ("string", q)
                cur.append(" ")
                i += len(q)
                continue
            cur.append(c)
            i += 1
            continue
        kind, end = state
        if kind == "string" and c == "\\":
            i += 2 if i + 1 < len(text) and text[i + 1] != "\n" else 1
            continue
        if end is not None and text.startswith(end, i):
            state = None
            i += len(end)
            continue
        i += 1
    out.append("".join(cur))
    return out


def source_vocabulary(repo, globs):
    """Every identifier the code under test uses: the non-test source
    files' code, without comments, strings, or lines that only declare or
    import a module."""
    words = set()
    for rel, text in repo.items():
        ext = Path(rel).suffix.lower()
        if ext not in SOURCE_EXTS or is_test_path(rel, globs):
            continue
        for code in code_lines(text, ext):
            if not IMPORT_LINE_RE.search(code):
                words.update(IDENT_RE.findall(code))
    return words


def command_words(command):
    """The shell words of one command, quotes removed where they parse."""
    try:
        words = shlex.split(command, comments=True)
    except ValueError:
        words = command.split()
    return [w.strip("[],") for w in words]


def runner_start(words):
    """The index just past the runner in `words`, or None."""
    for i, w in enumerate(words):
        base = w.rsplit("/", 1)[-1]
        if base in RUNNERS:
            return i + 1
        if base in ("python", "python3") or re.fullmatch(r"python[\d.]+", base):
            if words[i + 1:i + 3] in (["-m", "pytest"], ["-m", "unittest"]):
                return i + 3
        if (base, "test") in RUNNER_PAIRS or (base, "nextest") in RUNNER_PAIRS:
            # The task may follow `run` or the tool's own options
            # (`pnpm run test`, `./gradlew --no-daemon test`, `mvn -q test`).
            j = i + 1
            while j < len(words) and (words[j] == "run" or words[j].startswith("-")):
                j += 1
            if j < len(words) and ((base, words[j]) in RUNNER_PAIRS
                                   or base in TASK_RUNNERS and re.search(r"[tT]est$", words[j])):
                return j + 1
        if w.startswith("--gtest_filter"):
            return i
    return None


def selects(words, name):
    """Whether runner arguments `words` select or skip the test `name`."""
    rx = name_pattern(name, "identifier")
    i = 0
    while i < len(words):
        w = words[i]
        opt, eq, value = w.partition("=")
        if w.startswith("-") and eq:
            if opt in SELECTOR_OPTIONS and rx.search(value):
                return True
        elif w in SELECTOR_OPTIONS:
            if i + 1 < len(words) and rx.search(words[i + 1]):
                return True
            i += 1
        elif w in VALUE_OPTIONS:
            i += 1
        elif not w.startswith("-") and name in re.split(r"::|\[", w.strip("'\"^$")):
            return True
        i += 1
    return False


def runner_mentions(name):
    """Whether a logical line runs tests and selects `name`."""
    def found(line):
        m = ADDOPTS_RE.match(line)
        if m:
            return selects(command_words(m.group(1)), name)
        for command in COMMAND_SPLIT_RE.split(line):
            words = command_words(command)
            start = runner_start(words)
            if start is not None and selects(words[start:], name):
                return True
            # A whole command quoted as one value (`run: "cargo test ..."`).
            if any(" " in w and found(w) for w in words):
                return True
        return False
    return found


def logical_lines(lines):
    """Each line with the lines a trailing backslash continues it onto."""
    out = []
    for i, line in enumerate(lines):
        parts, j = [line], i
        while parts[-1].endswith("\\") and j + 1 < len(lines):
            parts[-1] = parts[-1][:-1]
            j += 1
            parts.append(lines[j])
        out.append(" ".join(parts))
    return out


def file_reference_pattern(stem):
    """A module declaration or relative import that resolves to a file
    named `stem` beside the line's own file (Rust `mod`, Python, js/ts
    relative paths, C includes)."""
    n = re.escape(stem)
    return re.compile(
        rf"^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+{n}\s*;"
        rf"|^\s*from\s+\.?{n}\s+import\b|^\s*from\s+\.\s+import\s+(?:.*[\s,(])?{n}(?![\w$])"
        rf"|^\s*import\s+{n}(?![\w$.])"
        rf"|(?P<q>['\"])\./{n}(?:\.\w+)*(?P=q)"
        rf"|#\s*include\s*\"{n}\.\w+\"")


def removal_scan(workdir, globs, patch_text, gold_files=None):
    """The static half of the clean-removal check: every place in the
    repository (and in the removal patch's own additions) that still names
    a removed test, a removed test file, or a gold test."""
    removed, removed_files, outside = {}, [], []
    patch_files = split_patch(patch_text) if patch_text else []
    for f in patch_files:
        test_file = is_test_path(f["path"], globs)
        # The patch takes tests out. In a test file anything goes; anywhere
        # else (a test inline in a source file) each hunk may only remove,
        # and must remove a test: a change to the code under test is not a
        # removal.
        if not test_file and not all(test_only_hunk(h) for h in f["hunks"]):
            outside.append(f["path"])
        for n, k in defined_names(f["removed"], test_file).items():
            removed.setdefault(n, k)
        if f["removed_file"]:
            removed_files.append(f["path"])
    gold = {}
    for rel, text in (gold_files or {}).items():
        for n, k in defined_names(text.splitlines(), True).items():
            gold.setdefault(n, k)

    repo = dict(scan_files(workdir))
    # A name the repository still defines (a same-named test elsewhere, a
    # helper the patch only moved) proves nothing; it is listed, not scanned.
    still_defined = set()
    for rel, text in repo.items():
        for n, k in defined_names(text.splitlines(), is_test_path(rel, globs)).items():
            still_defined.add(n)
    # A name the code under test uses (a helper `table` in a table store) is
    # the repository's vocabulary: its uses everywhere prove nothing, so it is
    # sought only where it can only mean the test (a module declaration or a
    # relative import of the removed file beside it, a test runner told to run
    # it) and in what the removal patch adds.
    vocabulary = source_vocabulary(repo, globs)
    targets = {}
    for n, k in list(removed.items()) + list(gold.items()):
        if n not in still_defined:
            targets.setdefault(n, (k, "removed test" if n in removed else "gold test"))
    stems, stem_dirs = {}, {}
    for path in removed_files:
        stem = Path(path).stem
        stems[path] = (re.compile(re.escape(path)), "removed file")
        if len(stem) >= MIN_NAME_LEN and stem not in GENERIC_NAMES and stem not in still_defined:
            stems[stem] = (name_pattern(stem, "identifier"), "removed file")
            stem_dirs.setdefault(stem, set()).add(str(Path(path).parent))
    reference_only = sorted({n for n, (k, _) in targets.items() if k == "identifier" and n in vocabulary}
                            | {n for n in stem_dirs if n in vocabulary})
    patterns = [(n, name_pattern(n, k), why) for n, (k, why) in sorted(targets.items())]
    patterns += [(n, rx, why) for n, (rx, why) in sorted(stems.items())]
    # (name, matcher, points at, the files it is sought in: None for all,
    # whether it reads the whole continued line)
    scans = []
    for n, rx, why in patterns:
        if n not in reference_only:
            scans.append((n, rx.search, why, None, False))
            continue
        scans.append((n, runner_mentions(n), why, None, True))
        if n in stem_dirs:
            beside = (lambda rel, dirs=stem_dirs[n]: str(Path(rel).parent) in dirs
                      or str(Path(rel).with_suffix("")) in dirs)
            scans.append((n, file_reference_pattern(n).search, why, beside, False))

    leftovers = []
    for rel, text in sorted(repo.items()):
        mine = [(n, found, why, found_whole) for n, found, why, where, found_whole in scans
                if where is None or where(rel)]
        lines = text.splitlines()
        logical = logical_lines(lines)
        for i, line in enumerate(lines, 1):
            named = set()
            for n, found, why, whole in mine:
                if n not in named and found(logical[i - 1] if whole else line):
                    named.add(n)
                    leftovers.append({"name": n, "points_at": why, "file": rel, "line": i,
                                      "kind": leftover_kind(rel, line), "text": line.strip()[:200]})
    for f in patch_files:
        for line in f["added"]:
            hit = next((n for n, rx, _ in patterns if rx.search(line)), None)
            if hit or TODO_RE.search(line):
                leftovers.append({"name": hit or "", "points_at": "removal patch addition",
                                  "file": f["path"], "line": None,
                                  "kind": leftover_kind(f["path"], line), "text": line.strip()[:200]})
    return {
        "removed_names": sorted(removed),
        "removed_files": sorted(removed_files),
        "gold_names": sorted(gold),
        "skipped_names": sorted((set(removed) | set(gold)) & still_defined),
        # Names the code under test uses: sought only where they can only
        # mean the test, and in the removal patch's additions.
        "vocabulary_names": reference_only,
        "leftovers": leftovers,
        "outside_tests": sorted(outside),
    }


RUST_TEST_ITEM_RE = re.compile(r"^\s*#\[(?:cfg\(test\)|(?:\w+::)*test\b)")


def test_only_hunk(hunk):
    """A hunk outside the test files that only takes out inline tests: it
    adds nothing, and what it removes is a run of whole Rust test items (a
    #[cfg(test)] module, or #[test] functions with their attributes), brace
    for brace, with nothing else but blank lines. Anything else, a function
    of the code under test removed beside them included, is refused."""
    if hunk["added"]:
        return False
    lines = hunk["removed"]
    i, items = 0, 0
    while i < len(lines):
        if not lines[i].strip():
            i += 1
            continue
        # The item's attributes, in any order (#[should_panic] may come
        # before #[test]); one of them must make it a test.
        attrs = []
        while i < len(lines) and lines[i].strip().startswith("#["):
            attrs.append(lines[i])
            i += 1
        if not any(RUST_TEST_ITEM_RE.match(a) for a in attrs):
            return False
        depth, opened = 0, False
        while i < len(lines):
            code = rust_code(lines[i])
            depth += code.count("{") - code.count("}")
            opened = opened or "{" in code
            i += 1
            if opened and depth == 0:
                break
        if not opened or depth != 0:
            return False
        items += 1
    return items > 0


def rust_code(line):
    """A Rust line without its strings, char literals and // comment, so
    braces inside them are not counted."""
    line = re.sub(r'"(?:\\.|[^"\\])*"', '""', line)
    line = re.sub(r"'(?:\\.|[^'\\])'", "''", line)
    return line.split("//", 1)[0]


def hunk_applied(have, hunk):
    """Whether `hunk` is applied in `have` (the file's lines), at the exact
    place its header puts it in the patched file (the image is built from
    the base with the patch applied, so nothing has moved): the after-image
    is there and, when the hunk removes lines, the before-image is not. An
    identical block elsewhere in the file plays no part either way."""
    k = hunk["new_start"]
    post, pre = hunk["post"], hunk["pre"]
    if have[k:k + len(post)] != post:
        return False
    return not hunk["removed"] or have[k:k + len(pre)] != pre


def removal_applied(workdir, patch_text):
    """Whether the removal patch is applied to the repository as it stands,
    read from the patch itself: every file it deletes is gone, and in every
    other file each hunk's after-image is there and its before-image is not.
    Exact lines, no fuzz; a deletion with no context is checked by its
    removed lines alone. Returns (applied, why not)."""
    for f in split_patch(patch_text):
        path = Path(workdir) / f["path"]
        if f["removed_file"]:
            if path.exists():
                return False, f"{f['path']} still exists; the patch deletes it"
            continue
        if not path.is_file():
            # Only a /dev/null diff deletes a file: one that empties it leaves
            # it, empty (a zero-context diff cannot tell emptying the file
            # from removing its first lines).
            return False, f"{f['path']} is missing"
        have = path.read_text(errors="replace").splitlines()
        for h in f["hunks"]:
            if not hunk_applied(have, h):
                return False, f"{f['path']}: still holds what the patch removes"
    return True, ""


class RemovalRefused(Exception):
    """The removal patch does not apply to the tree exactly."""


def parse_removal_patch(text):
    """[{path, deleted, hunks: [{old_start, pre, post}]}] of a unified diff
    (-p1), read line for line as the kit's parseUnifiedDiff reads it
    (lanes/mutation/kit/docker.ts): lines split on \\n alone, hunk bodies by
    the line counts in their headers."""
    lines = text.split("\n")
    files, cur = [], None

    def strip(p):
        t = p.split("\t")[0].strip()
        i = t.find("/")
        return t[i + 1:] if i >= 0 else t

    i = 0
    while i < len(lines):
        line = lines[i]
        i += 1
        if line.startswith("--- ") and i < len(lines) and lines[i].startswith("+++ "):
            dst = lines[i][4:].split("\t")[0].strip()
            i += 1
            deleted = dst == "/dev/null"
            cur = {"path": strip(line[4:] if deleted else dst), "deleted": deleted, "hunks": []}
            files.append(cur)
            continue
        m = HUNK_RE.match(line)
        if not m or cur is None:
            continue
        old = 1 if m.group(2) is None else int(m.group(2))
        new = 1 if m.group(4) is None else int(m.group(4))
        hunk = {"old_start": max(int(m.group(1)) - (1 if old else 0), 0), "pre": [], "post": []}
        while (old > 0 or new > 0) and i < len(lines):
            body = lines[i]
            i += 1
            if body.startswith("\\"):
                continue
            tag, rest = body[:1], body[1:]
            if tag == "-":
                hunk["pre"].append(rest)
                old -= 1
            elif tag == "+":
                hunk["post"].append(rest)
                new -= 1
            else:
                hunk["pre"].append(rest)
                hunk["post"].append(rest)
                old -= 1
                new -= 1
        cur["hunks"].append(hunk)
    return files


def apply_removal(patch_text, root):
    """Apply a removal patch to `root` with no fuzz and no offset, exactly as
    the kit's applyExactly does (lanes/mutation/kit/docker.ts; the shared
    cases in removal_apply_cases.json hold the two to the same results):
    every hunk's before-image must sit where its header says, only a
    /dev/null diff deletes a file and only when the file is exactly what it
    deletes, and no path may leave `root`. Raises RemovalRefused, having
    changed nothing, when any of that fails."""
    top = os.path.realpath(root)

    def inside(p):
        return p == top or p.startswith(top + os.sep)

    def refuse(why):
        raise RemovalRefused("tests/mutation/removal.patch does not apply to the repository exactly "
                             f"(make it with git diff from the base): {why}")

    # {path: new text, or None once deleted}: a later section of the patch
    # sees what an earlier one left, as the kit's in-place writes do.
    writes = {}
    for f in parse_removal_patch(patch_text):
        absolute = os.path.normpath(os.path.join(top, f["path"]))
        present = writes[absolute] is not None if absolute in writes else os.path.exists(absolute)
        if (not inside(absolute) or not present or os.path.islink(absolute)
                or not inside(os.path.realpath(os.path.dirname(absolute)))):
            refuse(f"{f['path']} is not a file in the repository")
        if absolute in writes:
            text = writes[absolute]
        else:
            with open(absolute, "rb") as fh:
                text = fh.read().decode("utf-8", "replace")
        ends_with_newline = text.endswith("\n")
        have = text.split("\n")
        if ends_with_newline:
            have.pop()
        if f["deleted"]:
            pre = [line for h in f["hunks"] for line in h["pre"]]
            if "\n".join(pre) != "\n".join(have):
                refuse(f"{f['path']} is not the file the patch deletes")
            writes[absolute] = None
            continue
        out, at = [], 0
        for h in f["hunks"]:
            start = h["old_start"]
            if start < at or "\n".join(have[start:start + len(h["pre"])]) != "\n".join(h["pre"]):
                refuse(f"{f['path']}: a hunk does not match at line {start + 1}")
            out += have[at:start] + h["post"]
            at = start + len(h["pre"])
        out += have[at:]
        # Emptied, not deleted: only a /dev/null diff deletes a file.
        writes[absolute] = ("\n".join(out) + ("\n" if ends_with_newline else "")) if out else ""
    for absolute, text in writes.items():
        if text is None:
            os.unlink(absolute)
        else:
            with open(absolute, "wb") as fh:
                fh.write(text.encode("utf-8"))
    return len(writes)


def cmd_apply_removal(argv):
    """score_mutants.py apply-removal <removal.patch> <root>: the platform's
    model image applies the task's removal patch with this (runner
    mutation_task.py), the kit with applyExactly; both apply it the same."""
    if len(argv) != 2:
        print("usage: score_mutants.py apply-removal <removal.patch> <root>", file=sys.stderr)
        return 2
    try:
        # Bytes, not read_text: its newline translation would turn a CRLF
        # file's lines into LF ones that no longer match the tree.
        n = apply_removal(Path(argv[0]).read_bytes().decode("utf-8", "replace"), argv[1])
    except (RemovalRefused, OSError) as e:
        print(str(e), file=sys.stderr)
        return 1
    log(f"removal patch applied to {n} file(s)")
    return 0


def suite_check(cfg):
    """The dynamic half: the repository's whole remaining suite (every file
    the test_globs match) passes on the reference; skipped tests are fine."""
    files = matching_files(cfg["workdir"], cfg["test_globs"])
    out = {"files": len(files), "tests": 0, "passed": 0, "skipped": 0, "failed": [],
           "seconds": 0.0, "timed_out": False, "error": None}
    try:
        build(cfg, "the reference")
    except Ungraded as e:
        out["error"] = str(e)
        return out
    if not files:
        return out
    results, rec = run_tests(cfg, files)
    out["seconds"] = round(rec["seconds"], 1)
    out["timed_out"] = rec["timed_out"]
    if results is None:
        out["error"] = "the suite left no report" + (" (timed out)" if rec["timed_out"]
                                                     else f": {rec['out'][-800:]}")
        return out
    out["tests"] = len(results)
    out["passed"] = sum(1 for s in results.values() if s == "passed")
    out["skipped"] = sum(1 for s in results.values() if s == "skipped")
    out["failed"] = sorted(t for t, s in results.items() if s == "failed")
    if out["failed"]:
        out["log_tail"] = rec["out"][-2000:]
    elif rec["rc"] != 0:
        # A report of passes from a run that failed anyway (collection
        # errors, a step after the tests) is not a passing suite.
        out["error"] = f"the suite exited {rec['rc']}: {rec['out'][-800:]}"
    elif not results:
        out["error"] = f"the suite reported no tests from {len(files)} file(s)"
    return out


def read_gold_files(gold_dir):
    out = {}
    if gold_dir and Path(gold_dir).is_dir():
        for p in sorted(Path(gold_dir).rglob("*")):
            if p.is_file() and p.stat().st_size <= SCAN_MAX_BYTES:
                data = p.read_bytes()
                if b"\0" not in data[:8192]:
                    out[p.relative_to(gold_dir).as_posix()] = data.decode("utf-8", "replace")
    return out


def check_removal(cfg, patch_text, gold_files=None, run_suite=True):
    report = {"suite": suite_check(cfg) if run_suite else None}
    report.update(removal_scan(cfg["workdir"], cfg["test_globs"], patch_text, gold_files))
    problems = []
    suite = report["suite"]
    if suite is not None:
        if suite["error"]:
            problems.append(f"remaining suite: {suite['error'][:300]}")
        elif suite["failed"]:
            problems.append(f"remaining suite: {len(suite['failed'])} test(s) fail without the "
                            "removed tests")
    if not patch_text and not gold_files:
        problems.append("no removal patch and no gold tests to scan against")
    if report["leftovers"]:
        problems.append(f"{len(report['leftovers'])} leftover reference(s) to removed or gold tests")
    if report["outside_tests"]:
        problems.append("the removal patch changes files outside the tests: "
                        + ", ".join(report["outside_tests"][:10]))
    if patch_text and re.search(r"^--- ", patch_text, re.M):
        applied, out = removal_applied(cfg["workdir"], patch_text)
        report["patch_applied"] = applied
        if not applied:
            problems.append(f"the removal patch is not applied to the repository: {out}")
    report["problems"] = problems
    report["ok"] = not problems
    return report


def option(argv, name, default=None):
    if name in argv:
        i = argv.index(name)
        if i + 1 < len(argv):
            return argv[i + 1]
    return default


def cmd_check_removal(argv):
    """score_mutants.py check-removal [--patch removal.patch] [--gold-dir D]
    [--no-suite] [--out report.json]: run with the gold tests NOT applied.
    Prints the JSON report; exits 1 when the removal is not clean."""
    try:
        cfg = load_config()
    except Ungraded as e:
        print(json.dumps({"ok": False, "problems": [str(e)]}))
        return 1
    patch_path = option(argv, "--patch")
    if patch_path is None and REMOVAL_PATCH_PATH.is_file():
        patch_path = str(REMOVAL_PATCH_PATH)
    patch_text = Path(patch_path).read_text(errors="replace") if patch_path else ""
    report = check_removal(cfg, patch_text, read_gold_files(option(argv, "--gold-dir")),
                           run_suite="--no-suite" not in argv)
    text = json.dumps(report, indent=1)
    out = option(argv, "--out")
    if out:
        Path(out).write_text(text + "\n")
    print(text)
    return 0 if report["ok"] else 1


def cmd_matrix(argv):
    """score_mutants.py matrix [--all-tests] [--out m.json]: the kill matrix
    without writing a verdict, for authoring. --all-tests counts every test
    the globs match, the repository's own included: a mutant the remaining
    suite already kills can be earned by copying an existing test."""
    try:
        cfg = load_config()
        mutants = load_mutants()
        baseline = ({"files": {}, "test_ids": []} if "--all-tests" in argv
                    else load_baseline(cfg))
        copies = load_reference(cfg, mutants)
        ref_program = None
        if cfg["bin"] and any(m["kind"] == "bin" for m in mutants):
            ref_program = Path(cfg["bin"]).read_bytes()
        started = time.monotonic()
        graded = score(cfg, mutants, baseline, copies, ref_program)
        graded["seconds"] = round(time.monotonic() - started, 1)
    except Ungraded as e:
        graded = {"ungraded": True, "reason": str(e)}
    text = json.dumps(graded, indent=1)
    out = option(argv, "--out")
    if out:
        Path(out).write_text(text + "\n")
    print(text)
    return 1 if graded.get("ungraded") else 0


# ─── Entry points ──────────────────────────────────────────────────────────

def cmd_verify():
    try:
        cfg = load_config()
        mutants = load_mutants()
        baseline = load_baseline(cfg)
        copies = load_reference(cfg, mutants)
        ref_program = None
        if cfg["bin"] and any(m["kind"] == "bin" for m in mutants):
            if not Path(cfg["bin"]).is_file():
                raise Ungraded(f"no program at {cfg['bin']}")
            ref_program = Path(cfg["bin"]).resolve().read_bytes()
        hide(MUTANTS_DIR, REFERENCE_DIR)
        refused = apply_change()
        if refused:
            log(f"the submitted change does not apply; scoring with nothing submitted: {refused}")
        graded = score(cfg, mutants, baseline, copies, ref_program)
        if refused:
            graded["numbers"]["apply_failed"] = 1
    except Ungraded as e:
        log(f"ungraded: {e}")
        write_ungraded(str(e))
        return 0
    write_outputs(graded)
    n = graded["numbers"]
    log(f"score {n['score']:.4f} ({n['criteria_passed']}/{n['criteria_total']} killed), "
        f"validity {n['validity']:.4f} ({n['tests_valid']}/{n['tests_total']})")
    return 0


def cmd_baseline(out_path):
    """Record the repository's own test files and test ids at the task's
    base (run before the gold tests are applied), for repo tasks."""
    cfg = load_config()
    files = matching_files(cfg["workdir"], cfg["test_globs"])
    build(cfg, "the reference")
    results, rec = run_tests(cfg, files) if files else ({}, None)
    if files and not results:
        raise SystemExit(f"the base's tests left no report: {rec['out'][-800:] if rec else ''}")
    data = {"files": {f: sha256_file(cfg["workdir"] / f) for f in files},
            "test_ids": sorted(results)}
    Path(out_path).write_text(json.dumps(data, indent=1, sort_keys=True) + "\n")
    log(f"baseline: {len(files)} file(s), {len(results)} test id(s) -> {out_path}")
    return 0


def main(argv):
    if len(argv) >= 2 and argv[1] == "verify":
        return cmd_verify()
    if len(argv) >= 2 and argv[1] == "baseline":
        return cmd_baseline(argv[2] if len(argv) > 2 else str(BASELINE_PATH))
    if len(argv) >= 2 and argv[1] == "check-removal":
        return cmd_check_removal(argv[2:])
    if len(argv) >= 2 and argv[1] == "matrix":
        return cmd_matrix(argv[2:])
    if len(argv) >= 2 and argv[1] == "apply-removal":
        return cmd_apply_removal(argv[2:])
    print("usage: score_mutants.py verify | baseline [out.json] | check-removal [--patch P] "
          "[--gold-dir D] [--no-suite] [--out F] | matrix [--all-tests] [--out F] | "
          "apply-removal <patch> <root>",
          file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
