import { createRequire } from "node:module";
var __create = Object.create;
var { getPrototypeOf: __getProtoOf, defineProperty: __defProp, getOwnPropertyNames: __getOwnPropNames } = Object;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
var __toESMCache_node, __toESMCache_esm, __toESM = (mod, isNodeMode, target) => {
  var canCache = mod != null && typeof mod === "object";
  if (canCache) {
    var cache = isNodeMode ? __toESMCache_node ??= /* @__PURE__ */ new WeakMap : __toESMCache_esm ??= /* @__PURE__ */ new WeakMap, cached = cache.get(mod);
    if (cached)
      return cached;
  }
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  let to = isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", { value: mod, enumerable: !0 }) : target;
  if (mod && typeof mod === "object" || typeof mod === "function") {
    for (let key of __getOwnPropNames(mod))
      if (!__hasOwnProp.call(to, key))
        __defProp(to, key, {
          get: __accessProp.bind(mod, key),
          enumerable: !0
        });
  }
  if (canCache)
    cache.set(mod, to);
  return to;
};
var __commonJS = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);
var __esm = (fn, res, err) => () => {
  if (fn)
    try {
      res = fn(fn = 0);
    } catch (e) {
      err = [e];
    }
  if (err)
    throw err[0];
  return res;
};
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// app/projects/gold/lanes/mutation/kit/docker.ts
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync as existsSync2,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync as readFileSync3,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, join as join2, resolve, sep as sep2 } from "node:path";
function run(cmd, args, opts = {}) {
  let res = spawnSync(cmd, args, {
    cwd: opts.cwd,
    encoding: "utf8",
    maxBuffer: 536870912,
    timeout: opts.timeoutMs,
    input: opts.input
  });
  if (opts.log)
    mkdirSync(dirname(opts.log), { recursive: !0 }), writeFileSync(opts.log, `$ ${cmd} ${args.join(" ")}
${res.stdout ?? ""}${res.stderr ?? ""}`);
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    error: res.error
  };
}
function tail(text, n = 15) {
  return text.trim().split(`
`).slice(-n).join(`
`);
}
function sha(...parts) {
  let h = createHash("sha256");
  for (let p of parts)
    h.update(p).update("\x00");
  return h.digest("hex").slice(0, 16);
}
function dockerReady() {
  if (run("docker", ["--version"]).status !== 0)
    return "docker is not installed";
  if (run("docker", ["info"]).status !== 0)
    return "the Docker daemon is not running";
  return null;
}
function platformOf(native) {
  if (!native)
    return { platform: "linux/amd64", python: (r) => r.runtimePython };
  let arch = run("docker", ["info", "--format", "{{.Architecture}}"]).stdout.trim(), arm = arch === "aarch64" || arch === "arm64";
  return {
    platform: arm ? "linux/arm64" : "linux/amd64",
    python: (r) => arm ? r.runtimePython.replace("x86_64", "aarch64") : r.runtimePython
  };
}
function build(ctx, tag, platform, log, extra = []) {
  let res = run("docker", ["build", "--platform", platform, ...extra, "-t", tag, ctx], { log });
  if (res.status !== 0)
    throw Error(`docker build ${tag} failed (log: ${log}):
${tail(`${res.stdout}${res.stderr}`)}`);
}
function buildRuntimeImage(rules, opts) {
  let { platform, python } = platformOf(opts.native), py = python(rules), tag = `mutkit-runtime:${sha(py, platform)}`;
  if (run("docker", ["image", "inspect", tag]).status === 0)
    return tag;
  let ctx = mkdtempSync(join2(tmpdir(), "mutkit-runtime-"));
  try {
    return writeFileSync(join2(ctx, "Dockerfile"), [
      "FROM ghcr.io/astral-sh/uv:0.13.1 AS uv",
      "FROM debian:bookworm-slim AS build",
      "COPY --from=uv /uv /usr/local/bin/uv",
      "ENV UV_PYTHON_INSTALL_DIR=/tmp/uv-python UV_NO_CONFIG=1 UV_PYTHON_DOWNLOADS=manual",
      `RUN uv python install --no-bin ${py} && mkdir -p /opt/judge && mv /tmp/uv-python/${py} /opt/judge/python`,
      'RUN /opt/judge/python/bin/python3 -c "import tomllib"',
      "FROM scratch",
      "COPY --from=build /opt/judge /opt/judge",
      ""
    ].join(`
`)), build(ctx, tag, platform, join2(opts.logDir, "runtime-build.log")), tag;
  } finally {
    rmSync(ctx, { recursive: !0, force: !0 });
  }
}
function taskSlug(task) {
  return `${basename(task.dir).toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").slice(0, 50) || "task"}-${sha(resolve(task.dir)).slice(0, 8)}`;
}
function stageRepository(repo, ref, removalPatch, into) {
  if (mkdirSync(into, { recursive: !0 }), ref) {
    let archive = spawnSync("git", ["-C", repo, "archive", "--format=tar", ref], {
      maxBuffer: 2147483648
    });
    if (archive.status !== 0)
      throw Error(`git archive ${ref} failed: ${tail(archive.stderr?.toString() ?? "", 3)}`);
    if (spawnSync("tar", ["-x", "-C", into], { input: archive.stdout }).status !== 0)
      throw Error("could not unpack the repository");
  } else
    cpSync(repo, into, {
      recursive: !0,
      verbatimSymlinks: !0,
      filter: (src) => basename(src) !== ".git"
    });
  if (removalPatch)
    applyExactly(readFileSync3(removalPatch, "utf8"), into);
}
function parseUnifiedDiff(text) {
  let lines = text.split(`
`), files = [], cur = null, strip = (p) => {
    let t = p.split("\t")[0].trim(), i = t.indexOf("/");
    return i >= 0 ? t.slice(i + 1) : t;
  };
  for (let i = 0;i < lines.length; ) {
    let line = lines[i++];
    if (line.startsWith("--- ") && lines[i]?.startsWith("+++ ")) {
      let dst = lines[i++].slice(4).split("\t")[0].trim(), deleted = dst === "/dev/null";
      cur = { path: strip(deleted ? line.slice(4) : dst), deleted, hunks: [] }, files.push(cur);
      continue;
    }
    let m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m || !cur)
      continue;
    let old = m[2] === void 0 ? 1 : Number(m[2]), neu = m[4] === void 0 ? 1 : Number(m[4]), hunk = {
      oldStart: Math.max(Number(m[1]) - (old ? 1 : 0), 0),
      pre: [],
      post: []
    };
    while ((old > 0 || neu > 0) && i < lines.length) {
      let body = lines[i++];
      if (body.startsWith("\\"))
        continue;
      let tag = body.slice(0, 1), rest = body.slice(1);
      if (tag === "-")
        hunk.pre.push(rest), old -= 1;
      else if (tag === "+")
        hunk.post.push(rest), neu -= 1;
      else
        hunk.pre.push(rest), hunk.post.push(rest), old -= 1, neu -= 1;
    }
    cur.hunks.push(hunk);
  }
  return files;
}
function applyExactly(patchText, root) {
  let refuse = (why) => {
    throw Error(`tests/mutation/removal.patch does not apply to the repository exactly (make it with git diff from the base): ${why}`);
  }, top = realpathSync(root), writes = /* @__PURE__ */ new Map;
  for (let f of parseUnifiedDiff(patchText)) {
    let abs = resolve(top, f.path), inside = (p) => p === top || p.startsWith(top + sep2), present = writes.has(abs) ? writes.get(abs) !== null : existsSync2(abs);
    if (!inside(abs) || !present || lstatSync(abs).isSymbolicLink() || !inside(realpathSync(dirname(abs))))
      refuse(`${f.path} is not a file in the repository`);
    let text = writes.has(abs) ? writes.get(abs) : readFileSync3(abs, "utf8"), endsWithNewline = text.endsWith(`
`), have = text.split(`
`);
    if (endsWithNewline)
      have.pop();
    if (f.deleted) {
      if (f.hunks.flatMap((h) => h.pre).join(`
`) !== have.join(`
`))
        refuse(`${f.path} is not the file the patch deletes`);
      writes.set(abs, null);
      continue;
    }
    let out = [], at = 0;
    for (let h of f.hunks) {
      if (h.oldStart < at || have.slice(h.oldStart, h.oldStart + h.pre.length).join(`
`) !== h.pre.join(`
`))
        refuse(`${f.path}: a hunk does not match at line ${h.oldStart + 1}`);
      out.push(...have.slice(at, h.oldStart), ...h.post), at = h.oldStart + h.pre.length;
    }
    out.push(...have.slice(at)), writes.set(abs, out.length ? `${out.join(`
`)}${endsWithNewline ? `
` : ""}` : "");
  }
  for (let [abs, text] of writes)
    if (text === null)
      rmSync(abs);
    else
      writeFileSync(abs, text);
}
function buildEnvironmentImage(task, repo, opts) {
  let { platform } = platformOf(opts.native), tag = `mutkit-env:${taskSlug(task)}`, ctx = mkdtempSync(join2(tmpdir(), "mutkit-env-"));
  try {
    if (task.lane === "prometheus") {
      if (!repo)
        throw Error("a Prometheus check needs --repo <working copy> (and --ref <commit>, else its working tree)");
      let tree = join2(ctx, "repo");
      stageRepository(repo.path, repo.ref, task.files.get("tests/mutation/removal.patch") ?? null, tree), build(tree, tag, platform, join2(opts.logDir, "env-build.log"), [
        "-f",
        task.files.get("environment/Dockerfile")
      ]);
    } else
      cpSync(join2(task.dir, "environment"), ctx, { recursive: !0, verbatimSymlinks: !0 }), build(ctx, tag, platform, join2(opts.logDir, "env-build.log"));
    return tag;
  } finally {
    rmSync(ctx, { recursive: !0, force: !0 });
  }
}
function buildProgramImage(task, opts) {
  let { platform } = platformOf(opts.native), tag = `mutkit-program:${taskSlug(task)}`;
  return build(join2(task.dir, "tests/program"), tag, platform, join2(opts.logDir, "program-build.log"), [
    "--build-arg",
    `PROGRAM=${basename(task.config.bin)}`
  ]), tag;
}
function buildVerifierImage(task, envTag, runtimeTag, programTag, opts) {
  let { platform } = platformOf(opts.native), tag = `mutkit-verifier:${taskSlug(task)}`, ctx = mkdtempSync(join2(tmpdir(), "mutkit-verifier-"));
  try {
    cpSync(join2(task.dir, "tests"), join2(ctx, "tests"), {
      recursive: !0,
      filter: (src) => !(programTag && src.startsWith(join2(task.dir, "tests/program")))
    });
    let lines = [`FROM ${runtimeTag} AS runtime`];
    if (programTag)
      lines.push(`FROM ${programTag} AS program`);
    if (lines.push(`FROM ${envTag}`, "ENTRYPOINT []", "USER root", "COPY --from=runtime /opt/judge /opt/judge", "COPY tests/ /tests/"), programTag)
      lines.push("COPY --from=program /out/ /tests/");
    return lines.push("RUN chmod +x /tests/test.sh", ""), writeFileSync(join2(ctx, "Dockerfile"), lines.join(`
`)), build(ctx, tag, platform, join2(opts.logDir, "verifier-build.log")), tag;
  } finally {
    rmSync(ctx, { recursive: !0, force: !0 });
  }
}
function caseScript(command, v = "/logs/verifier") {
  return [
    '_cpu() { local k n; if [ -r /sys/fs/cgroup/cpu.stat ]; then while read -r k n; do [ "$k" = usage_usec ] && { echo "${n}000"; return; }; done < /sys/fs/cgroup/cpu.stat; fi; cat /sys/fs/cgroup/cpuacct/cpuacct.usage 2>/dev/null; }',
    `mkdir -p ${v}`,
    `( while :; do echo "$EPOCHREALTIME $(_cpu)"; sleep 0.5; done ) > ${v}/${CPU_SAMPLES_FILE} 2>/dev/null &`,
    "_s=$!",
    `( ${command} ) 2>&1 | while IFS= read -r _l || [ -n "$_l" ]; do printf '%s
' "$_l"; printf '%s %s
' "$EPOCHREALTIME" "$_l" >> ${v}/${LINES_FILE}; done`,
    "_rc=${PIPESTATUS[0]}",
    "kill $_s 2>/dev/null; wait $_s 2>/dev/null",
    `echo "$EPOCHREALTIME $(_cpu)" >> ${v}/${CPU_SAMPLES_FILE}`,
    `{ cat /sys/fs/cgroup/cpu.stat 2>/dev/null || echo "usage_nsec $(cat /sys/fs/cgroup/cpuacct/cpuacct.usage 2>/dev/null)"; } > ${v}/${CPU_FILE}`,
    "exit $_rc"
  ].join(`
`);
}
function parseCpuSeconds(text) {
  let usec = text?.match(/^usage_usec (\d+)$/m);
  if (usec)
    return Number(usec[1]) / 1e6;
  let nsec = text?.match(/^usage_nsec (\d+)$/m);
  return nsec ? Number(nsec[1]) / 1e9 : null;
}
function parseCpuTrace(samples, lines) {
  if (samples === null || lines === null)
    return null;
  let s = [];
  for (let row of samples.split(`
`)) {
    let m = row.match(/^(\d+[.,]\d+) (\d+)$/);
    if (m)
      s.push([epoch(m[1]), Number(m[2]) / 1e9]);
  }
  let l = [];
  for (let row of lines.split(`
`)) {
    let m = row.match(/^(\d+[.,]\d+) (.*)$/);
    if (m)
      l.push([epoch(m[1]), m[2]]);
  }
  return s.length >= 2 && l.length > 0 ? { samples: s, lines: l } : null;
}
function runCase(image, name, command, limits, outDir, solution) {
  rmSync(outDir, { recursive: !0, force: !0 }), mkdirSync(outDir, { recursive: !0 });
  let container = `mutkit-${name}-${process.pid}-${Date.now()}`, created = run("docker", [
    "create",
    "--name",
    container,
    "--label",
    CONTAINER_LABEL,
    "--label",
    `mutkit.owner=${hostname()}:${process.pid}`,
    "--network",
    "none",
    "--cpus",
    String(limits.cpus),
    "--memory",
    `${limits.memoryMb}m`,
    image,
    "bash",
    "-c",
    caseScript(command)
  ]), cleanup = () => run("docker", ["rm", "-f", container]);
  if (created.status !== 0)
    throw cleanup(), Error(`the ${name} container was not created: ${tail(created.stderr, 3)}`);
  try {
    if (solution) {
      let cp = run("docker", ["cp", solution, `${container}:/solution`]);
      if (cp.status !== 0)
        throw Error(`solution/ was not copied in: ${tail(cp.stderr, 3)}`);
    }
    let started = Date.now(), res = run("docker", ["start", "--attach", container], {
      timeoutMs: (limits.verifierTimeoutSec + 300) * 1000
    }), seconds = (Date.now() - started) / 1000, log = `${res.stdout}${res.stderr}`;
    writeFileSync(join2(outDir, "run.log"), log), run("docker", ["cp", `${container}:/logs/verifier`, join2(outDir, "verifier")]);
    let out = join2(outDir, "verifier");
    return {
      name,
      seconds,
      cpuSeconds: parseCpuSeconds(readIf(join2(out, CPU_FILE))),
      cpuTrace: parseCpuTrace(readIf(join2(out, CPU_SAMPLES_FILE)), readIf(join2(out, LINES_FILE))),
      exitCode: res.status,
      timedOut: !!res.error,
      log,
      outDir
    };
  } finally {
    cleanup();
  }
}
function readJson(path) {
  try {
    return existsSync2(path) ? JSON.parse(readFileSync3(path, "utf8")) : null;
  } catch {
    return null;
  }
}
function streamTar(args, onEntry) {
  return new Promise((resolve, reject) => {
    let child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] }), reader = new TarReader(onEntry), stderr = "";
    child.stdout.on("data", (chunk) => {
      try {
        reader.push(chunk);
      } catch (e) {
        child.kill(), reject(e);
      }
    }), child.stderr.on("data", (c) => {
      stderr += c.toString();
    }), child.on("error", reject), child.on("close", (code) => {
      if (code !== 0)
        reject(Error(`docker ${args[0]} failed: ${tail(stderr, 3)}`));
      else
        resolve();
    });
  });
}

class TarReader {
  onEntry;
  buf = Buffer.alloc(0);
  pending = null;
  longName = null;
  paxPath = null;
  done = !1;
  constructor(onEntry) {
    this.onEntry = onEntry;
  }
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (!this.done) {
      if (!this.pending) {
        if (this.buf.length < 512)
          return;
        let h = this.buf.subarray(0, 512);
        if (this.buf = this.buf.subarray(512), h.every((b) => b === 0)) {
          this.done = !0;
          return;
        }
        let str = (a, b) => h.subarray(a, b).toString("utf8").replace(/\0.*$/s, ""), size = parseInt(str(124, 136).trim() || "0", 8), prefix = str(345, 500);
        this.pending = {
          path: prefix ? `${prefix}/${str(0, 100)}` : str(0, 100),
          type: str(156, 157) || "0",
          mode: parseInt(str(100, 108).trim() || "0", 8),
          remaining: size,
          padding: Math.ceil(size / 512) * 512 - size,
          hash: createHash("sha256"),
          chunks: size > MAX_KEPT ? null : []
        };
      }
      let p = this.pending;
      if (p.remaining > 0) {
        if (this.buf.length === 0)
          return;
        let take = this.buf.subarray(0, Math.min(p.remaining, this.buf.length));
        p.hash.update(take), p.chunks?.push(Buffer.from(take)), p.remaining -= take.length, this.buf = this.buf.subarray(take.length);
        continue;
      }
      if (p.padding > 0) {
        if (this.buf.length === 0)
          return;
        let skip = Math.min(p.padding, this.buf.length);
        p.padding -= skip, this.buf = this.buf.subarray(skip);
        continue;
      }
      this.pending = null;
      let data = p.chunks ? Buffer.concat(p.chunks) : Buffer.alloc(0);
      if (p.type === "L") {
        this.longName = data.toString("utf8").replace(/\0.*$/s, "");
        continue;
      }
      if (p.type === "x") {
        let m = /\d+ path=([^\n]*)\n/.exec(data.toString("utf8"));
        this.paxPath = m ? m[1] : null;
        continue;
      }
      if (p.type === "g")
        continue;
      let path = this.paxPath ?? this.longName ?? p.path;
      this.paxPath = null, this.longName = null, this.onEntry(path.replace(/^\.?\/+/, ""), p.type, p.mode, data, p.hash.digest("hex"));
    }
  }
}
var CONTAINER_LABEL = "mutkit.run=1", CPU_FILE = "mutkit-cpu.txt", CPU_SAMPLES_FILE = "mutkit-cpu-samples.txt", LINES_FILE = "mutkit-lines.txt", epoch = (s) => Number(s.replace(",", ".")), readIf = (path) => existsSync2(path) ? readFileSync3(path, "utf8") : null, MAX_KEPT = 67108864;
var init_docker = () => {};

// ../../../orca/workspaces/AfterQueryFront/gold-fix-runner-buildx/node_modules/adm-zip/util/constants.js
var require_constants = __commonJS(function(exports, module) {
  module.exports = {
    LOCHDR: 30,
    LOCSIG: 67324752,
    LOCVER: 4,
    LOCFLG: 6,
    LOCHOW: 8,
    LOCTIM: 10,
    LOCCRC: 14,
    LOCSIZ: 18,
    LOCLEN: 22,
    LOCNAM: 26,
    LOCEXT: 28,
    EXTSIG: 134695760,
    EXTHDR: 16,
    EXTCRC: 4,
    EXTSIZ: 8,
    EXTLEN: 12,
    CENHDR: 46,
    CENSIG: 33639248,
    CENVEM: 4,
    CENVER: 6,
    CENFLG: 8,
    CENHOW: 10,
    CENTIM: 12,
    CENCRC: 16,
    CENSIZ: 20,
    CENLEN: 24,
    CENNAM: 28,
    CENEXT: 30,
    CENCOM: 32,
    CENDSK: 34,
    CENATT: 36,
    CENATX: 38,
    CENOFF: 42,
    ENDHDR: 22,
    ENDSIG: 101010256,
    ENDSUB: 8,
    ENDTOT: 10,
    ENDSIZ: 12,
    ENDOFF: 16,
    ENDCOM: 20,
    END64HDR: 20,
    END64SIG: 117853008,
    END64START: 4,
    END64OFF: 8,
    END64NUMDISKS: 16,
    ZIP64SIG: 101075792,
    ZIP64HDR: 56,
    ZIP64LEAD: 12,
    ZIP64SIZE: 4,
    ZIP64VEM: 12,
    ZIP64VER: 14,
    ZIP64DSK: 16,
    ZIP64DSKDIR: 20,
    ZIP64SUB: 24,
    ZIP64TOT: 32,
    ZIP64SIZB: 40,
    ZIP64OFF: 48,
    ZIP64EXTRA: 56,
    STORED: 0,
    SHRUNK: 1,
    REDUCED1: 2,
    REDUCED2: 3,
    REDUCED3: 4,
    REDUCED4: 5,
    IMPLODED: 6,
    DEFLATED: 8,
    ENHANCED_DEFLATED: 9,
    PKWARE: 10,
    BZIP2: 12,
    LZMA: 14,
    IBM_TERSE: 18,
    IBM_LZ77: 19,
    AES_ENCRYPT: 99,
    FLG_ENC: 1,
    FLG_COMP1: 2,
    FLG_COMP2: 4,
    FLG_DESC: 8,
    FLG_ENH: 16,
    FLG_PATCH: 32,
    FLG_STR: 64,
    FLG_EFS: 2048,
    FLG_MSK: 4096,
    FILE: 2,
    BUFFER: 1,
    NONE: 0,
    EF_ID: 0,
    EF_SIZE: 2,
    ID_ZIP64: 1,
    ID_AVINFO: 7,
    ID_PFS: 8,
    ID_OS2: 9,
    ID_NTFS: 10,
    ID_OPENVMS: 12,
    ID_UNIX: 13,
    ID_FORK: 14,
    ID_PATCH: 15,
    ID_X509_PKCS7: 20,
    ID_X509_CERTID_F: 21,
    ID_X509_CERTID_C: 22,
    ID_STRONGENC: 23,
    ID_RECORD_MGT: 24,
    ID_X509_PKCS7_RL: 25,
    ID_IBM1: 101,
    ID_IBM2: 102,
    ID_POSZIP: 18064,
    EF_ZIP64_OR_32: 4294967295,
    EF_ZIP64_OR_16: 65535,
    EF_ZIP64_SUNCOMP: 0,
    EF_ZIP64_SCOMP: 8,
    EF_ZIP64_RHO: 16,
    EF_ZIP64_DSN: 24
  };
});

// ../../../orca/workspaces/AfterQueryFront/gold-fix-runner-buildx/node_modules/adm-zip/util/errors.js
var require_errors = __commonJS(function(exports) {
  var errors = {
    INVALID_LOC: "Invalid LOC header (bad signature)",
    INVALID_CEN: "Invalid CEN header (bad signature)",
    INVALID_END: "Invalid END header (bad signature)",
    DESCRIPTOR_NOT_EXIST: "No descriptor present",
    DESCRIPTOR_UNKNOWN: "Unknown descriptor format",
    DESCRIPTOR_FAULTY: "Descriptor data is malformed",
    NO_DATA: "Nothing to decompress",
    BAD_CRC: "CRC32 checksum failed {0}",
    FILE_IN_THE_WAY: "There is a file in the way: {0}",
    UNKNOWN_METHOD: "Invalid/unsupported compression method",
    AVAIL_DATA: "inflate::Available inflate data did not terminate",
    INVALID_DISTANCE: "inflate::Invalid literal/length or distance code in fixed or dynamic block",
    TO_MANY_CODES: "inflate::Dynamic block code description: too many length or distance codes",
    INVALID_REPEAT_LEN: "inflate::Dynamic block code description: repeat more than specified lengths",
    INVALID_REPEAT_FIRST: "inflate::Dynamic block code description: repeat lengths with no first length",
    INCOMPLETE_CODES: "inflate::Dynamic block code description: code lengths codes incomplete",
    INVALID_DYN_DISTANCE: "inflate::Dynamic block code description: invalid distance code lengths",
    INVALID_CODES_LEN: "inflate::Dynamic block code description: invalid literal/length code lengths",
    INVALID_STORE_BLOCK: "inflate::Stored block length did not match one's complement",
    INVALID_BLOCK_TYPE: "inflate::Invalid block type (type == 3)",
    CANT_EXTRACT_FILE: "Could not extract the file",
    CANT_OVERRIDE: "Target file already exists",
    DISK_ENTRY_TOO_LARGE: "Number of disk entries is too large",
    NO_ZIP: "No zip file was loaded",
    NO_ENTRY: "Entry doesn't exist",
    DIRECTORY_CONTENT_ERROR: "A directory cannot have content",
    FILE_NOT_FOUND: 'File not found: "{0}"',
    NOT_IMPLEMENTED: "Not implemented",
    INVALID_FILENAME: "Invalid filename",
    INVALID_FORMAT: "Invalid or unsupported zip format. No END header found",
    INVALID_PASS_PARAM: "Incompatible password parameter",
    WRONG_PASSWORD: "Wrong Password",
    COMMENT_TOO_LONG: "Comment is too long",
    EXTRA_FIELD_PARSE_ERROR: "Extra field parsing error"
  };
  function E(message) {
    return function(...args) {
      if (args.length)
        message = message.replace(/\{(\d)\}/g, (_, n) => args[n] || "");
      return Error("ADM-ZIP: " + message);
    };
  }
  for (let msg of Object.keys(errors))
    exports[msg] = E(errors[msg]);
});

// ../../../orca/workspaces/AfterQueryFront/gold-fix-runner-buildx/node_modules/adm-zip/util/utils.js
var require_utils = __commonJS(function(exports, module) {
  var fsystem = __require("fs"), pth = __require("path"), Constants = require_constants(), Errors = require_errors(), isWin = typeof process === "object" && process.platform === "win32", is_Obj = (obj) => typeof obj === "object" && obj !== null, crcTable = new Uint32Array(256).map((t, c) => {
    for (let k = 0;k < 8; k++)
      if ((c & 1) !== 0)
        c = 3988292384 ^ c >>> 1;
      else
        c >>>= 1;
    return c >>> 0;
  });
  function Utils(opts) {
    if (this.sep = pth.sep, this.fs = fsystem, is_Obj(opts)) {
      if (is_Obj(opts.fs) && typeof opts.fs.statSync === "function")
        this.fs = opts.fs;
    }
  }
  module.exports = Utils;
  Utils.prototype.makeDir = function(folder) {
    let self = this;
    function mkdirSync(fpath) {
      let resolvedPath = fpath.split(self.sep)[0];
      fpath.split(self.sep).forEach(function(name) {
        if (!name || name.substr(-1, 1) === ":")
          return;
        resolvedPath += self.sep + name;
        var stat;
        try {
          stat = self.fs.statSync(resolvedPath);
        } catch (e) {
          if (e.message && e.message.startsWith("ENOENT"))
            self.fs.mkdirSync(resolvedPath);
          else
            throw e;
        }
        if (stat && stat.isFile())
          throw Errors.FILE_IN_THE_WAY(`"${resolvedPath}"`);
      });
    }
    mkdirSync(folder);
  };
  Utils.prototype.writeFileTo = function(path, content, overwrite, attr) {
    let self = this;
    if (self.fs.existsSync(path)) {
      if (!overwrite)
        return !1;
      var stat = self.fs.statSync(path);
      if (stat.isDirectory())
        return !1;
    }
    var folder = pth.dirname(path);
    if (!self.fs.existsSync(folder))
      self.makeDir(folder);
    var fd;
    try {
      fd = self.fs.openSync(path, "w", 438);
    } catch (e) {
      self.fs.chmodSync(path, 438), fd = self.fs.openSync(path, "w", 438);
    }
    if (fd)
      try {
        self.fs.writeSync(fd, content, 0, content.length, 0);
      } finally {
        self.fs.closeSync(fd);
      }
    return self.fs.chmodSync(path, attr || 438), !0;
  };
  Utils.prototype.writeFileToAsync = function(path, content, overwrite, attr, callback) {
    if (typeof attr === "function")
      callback = attr, attr = void 0;
    let self = this;
    self.fs.exists(path, function(exist) {
      if (exist && !overwrite)
        return callback(!1);
      self.fs.stat(path, function(err, stat) {
        if (exist && stat && stat.isDirectory())
          return callback(!1);
        var folder = pth.dirname(path);
        self.fs.exists(folder, function(exists) {
          if (!exists)
            try {
              self.makeDir(folder);
            } catch (e) {
              return callback(!1);
            }
          let writeToFd = function(fd) {
            self.fs.write(fd, content, 0, content.length, 0, function(writeErr) {
              self.fs.close(fd, function() {
                if (writeErr)
                  return callback(!1);
                self.fs.chmod(path, attr || 438, function() {
                  callback(!0);
                });
              });
            });
          };
          self.fs.open(path, "w", 438, function(err, fd) {
            if (err)
              self.fs.chmod(path, 438, function() {
                self.fs.open(path, "w", 438, function(retryErr, fd) {
                  if (retryErr || !fd)
                    return callback(!1);
                  writeToFd(fd);
                });
              });
            else if (fd)
              writeToFd(fd);
            else
              callback(!1);
          });
        });
      });
    });
  };
  Utils.prototype.findFiles = function(path) {
    let self = this;
    function findSync(dir, pattern, recursive, visited) {
      if (typeof pattern === "boolean")
        recursive = pattern, pattern = void 0;
      let files = [];
      return self.fs.readdirSync(dir).forEach(function(file) {
        let path = pth.join(dir, file), stat = self.fs.statSync(path);
        if (!pattern || pattern.test(path))
          files.push(pth.normalize(path) + (stat.isDirectory() ? self.sep : ""));
        if (stat.isDirectory() && recursive) {
          let realDir = self.fs.realpathSync(path);
          if (!visited.has(realDir))
            visited.add(realDir), files = files.concat(findSync(path, pattern, recursive, visited));
        }
      }), files;
    }
    return findSync(path, void 0, !0, /* @__PURE__ */ new Set([self.fs.realpathSync(path)]));
  };
  Utils.prototype.findFilesAsync = function(dir, cb) {
    let self = this, results = [], finished = !1, finish = function(err) {
      if (finished)
        return;
      finished = !0, cb(err, err ? void 0 : results);
    }, walk = function(dir, visited, done) {
      self.fs.readdir(dir, function(err, list) {
        if (err)
          return done(err);
        let pending = list.length;
        if (!pending)
          return done();
        list.forEach(function(name) {
          let file = pth.join(dir, name);
          self.fs.stat(file, function(err, stat) {
            if (err)
              return done(err);
            if (!stat) {
              if (!--pending)
                done();
              return;
            }
            if (results.push(pth.normalize(file) + (stat.isDirectory() ? self.sep : "")), !stat.isDirectory()) {
              if (!--pending)
                done();
              return;
            }
            self.fs.realpath(file, function(err, realDir) {
              if (err)
                return done(err);
              if (visited.has(realDir)) {
                if (!--pending)
                  done();
                return;
              }
              visited.add(realDir), walk(file, visited, function(err) {
                if (err)
                  return done(err);
                if (!--pending)
                  done();
              });
            });
          });
        });
      });
    };
    self.fs.realpath(dir, function(err, realDir) {
      if (err)
        return finish(err);
      walk(dir, /* @__PURE__ */ new Set([realDir]), finish);
    });
  };
  Utils.prototype.getAttributes = function() {};
  Utils.prototype.setAttributes = function() {};
  Utils.crc32update = function(crc, byte) {
    return crcTable[(crc ^ byte) & 255] ^ crc >>> 8;
  };
  Utils.crc32 = function(buf) {
    if (typeof buf === "string")
      buf = Buffer.from(buf, "utf8");
    let len = buf.length, crc = -1;
    for (let off = 0;off < len; )
      crc = Utils.crc32update(crc, buf[off++]);
    return ~crc >>> 0;
  };
  Utils.methodToString = function(method) {
    switch (method) {
      case Constants.STORED:
        return "STORED (" + method + ")";
      case Constants.DEFLATED:
        return "DEFLATED (" + method + ")";
      default:
        return "UNSUPPORTED (" + method + ")";
    }
  };
  Utils.canonical = function(path) {
    if (!path)
      return "";
    let safeSuffix = pth.posix.normalize("/" + path.split("\\").join("/"));
    return pth.join(".", safeSuffix);
  };
  Utils.zipnamefix = function(path) {
    if (!path)
      return "";
    let safeSuffix = pth.posix.normalize("/" + path.split("\\").join("/"));
    return pth.posix.join(".", safeSuffix);
  };
  Utils.findLast = function(arr, callback) {
    if (!Array.isArray(arr))
      throw TypeError("arr is not array");
    let len = arr.length >>> 0;
    for (let i = len - 1;i >= 0; i--)
      if (callback(arr[i], i, arr))
        return arr[i];
    return;
  };
  Utils.sanitize = function(prefix, name) {
    prefix = pth.resolve(pth.normalize(prefix));
    var parts = name.split("/");
    for (var i = 0, l = parts.length;i < l; i++) {
      var path = pth.normalize(pth.join(prefix, parts.slice(i, l).join(pth.sep)));
      if (path === prefix || path.startsWith(prefix + pth.sep))
        return path;
    }
    return pth.normalize(pth.join(prefix, pth.basename(name)));
  };
  Utils.toBuffer = function(input, encoder) {
    if (Buffer.isBuffer(input))
      return input;
    else if (input instanceof Uint8Array)
      return Buffer.from(input);
    else
      return typeof input === "string" ? encoder(input) : Buffer.alloc(0);
  };
  Utils.readBigUInt64LE = function(buffer, index) {
    let lo = buffer.readUInt32LE(index);
    return buffer.readUInt32LE(index + 4) * 4294967296 + lo;
  };
  Utils.writeBigUInt64LE = function(buffer, value, index) {
    let lo = value >>> 0, hi = Math.floor(value / 4294967296) >>> 0;
    buffer.writeUInt32LE(lo, index), buffer.writeUInt32LE(hi, index + 4);
  };
  Utils.fromDOS2Date = function(val) {
    return new Date((val >> 25 & 127) + 1980, Math.max((val >> 21 & 15) - 1, 0), Math.max(val >> 16 & 31, 1), val >> 11 & 31, val >> 5 & 63, (val & 31) << 1);
  };
  Utils.fromDate2DOS = function(val) {
    let date = 0, time = 0;
    if (val.getFullYear() > 1979)
      date = (val.getFullYear() - 1980 & 127) << 9 | val.getMonth() + 1 << 5 | val.getDate(), time = val.getHours() << 11 | val.getMinutes() << 5 | val.getSeconds() >> 1;
    return date << 16 | time;
  };
  Utils.isWin = isWin;
  Utils.crcTable = crcTable;
});

// ../../../orca/workspaces/AfterQueryFront/gold-fix-runner-buildx/node_modules/adm-zip/util/fattr.js
var require_fattr = __commonJS(function(exports, module) {
  var pth = __require("path");
  module.exports = function(path, { fs }) {
    var _path = path || "", _obj = newAttr(), _stat = null;
    function newAttr() {
      return {
        directory: !1,
        readonly: !1,
        hidden: !1,
        executable: !1,
        mtime: 0,
        atime: 0
      };
    }
    if (_path && fs.existsSync(_path))
      _stat = fs.statSync(_path), _obj.directory = _stat.isDirectory(), _obj.mtime = _stat.mtime, _obj.atime = _stat.atime, _obj.executable = (73 & _stat.mode) !== 0, _obj.readonly = (128 & _stat.mode) === 0, _obj.hidden = pth.basename(_path)[0] === ".";
    else
      console.warn("Invalid path: " + _path);
    return {
      get directory() {
        return _obj.directory;
      },
      get readOnly() {
        return _obj.readonly;
      },
      get hidden() {
        return _obj.hidden;
      },
      get mtime() {
        return _obj.mtime;
      },
      get atime() {
        return _obj.atime;
      },
      get executable() {
        return _obj.executable;
      },
      decodeAttributes: function() {},
      encodeAttributes: function() {},
      toJSON: function() {
        return {
          path: _path,
          isDirectory: _obj.directory,
          isReadOnly: _obj.readonly,
          isHidden: _obj.hidden,
          isExecutable: _obj.executable,
          mTime: _obj.mtime,
          aTime: _obj.atime
        };
      },
      toString: function() {
        return JSON.stringify(this.toJSON(), null, "\t");
      }
    };
  };
});

// ../../../orca/workspaces/AfterQueryFront/gold-fix-runner-buildx/node_modules/adm-zip/util/decoder.js
var require_decoder = __commonJS(function(exports, module) {
  module.exports = {
    efs: !0,
    encode: (data) => Buffer.from(data, "utf8"),
    decode: (data) => data.toString("utf8")
  };
});

// ../../../orca/workspaces/AfterQueryFront/gold-fix-runner-buildx/node_modules/adm-zip/util/index.js
var require_util = __commonJS(function(exports, module) {
  module.exports = require_utils();
  module.exports.Constants = require_constants();
  module.exports.Errors = require_errors();
  module.exports.FileAttr = require_fattr();
  module.exports.decoder = require_decoder();
});

// ../../../orca/workspaces/AfterQueryFront/gold-fix-runner-buildx/node_modules/adm-zip/headers/entryHeader.js
var require_entryHeader = __commonJS(function(exports, module) {
  var Utils = require_util(), Constants = Utils.Constants;
  module.exports = function() {
    var _verMade = 20, _version = 10, _flags = 0, _method = 0, _time = 0, _crc = 0, _compressedSize = 0, _size = 0, _fnameLen = 0, _extraLen = 0, _comLen = 0, _diskStart = 0, _inattr = 0, _attr = 0, _offset = 0;
    _verMade |= Utils.isWin ? 2560 : 768, _flags |= Constants.FLG_EFS;
    let _localHeader = {
      extraLen: 0
    }, uint32 = (val) => Math.max(0, val) >>> 0, uint16 = (val) => Math.max(0, val) & 65535, uint8 = (val) => Math.max(0, val) & 255;
    return _time = Utils.fromDate2DOS(/* @__PURE__ */ new Date), {
      get made() {
        return _verMade;
      },
      set made(val) {
        _verMade = val;
      },
      get version() {
        return _version;
      },
      set version(val) {
        _version = val;
      },
      get flags() {
        return _flags;
      },
      set flags(val) {
        _flags = val;
      },
      get flags_efs() {
        return (_flags & Constants.FLG_EFS) > 0;
      },
      set flags_efs(val) {
        if (val)
          _flags |= Constants.FLG_EFS;
        else
          _flags &= ~Constants.FLG_EFS;
      },
      get flags_desc() {
        return (_flags & Constants.FLG_DESC) > 0;
      },
      set flags_desc(val) {
        if (val)
          _flags |= Constants.FLG_DESC;
        else
          _flags &= ~Constants.FLG_DESC;
      },
      get method() {
        return _method;
      },
      set method(val) {
        switch (val) {
          case Constants.STORED:
            this.version = 10;
            break;
          case Constants.DEFLATED:
          default:
            this.version = 20;
        }
        _method = val;
      },
      get time() {
        return Utils.fromDOS2Date(this.timeval);
      },
      set time(val) {
        val = new Date(val), this.timeval = Utils.fromDate2DOS(val);
      },
      get timeval() {
        return _time;
      },
      set timeval(val) {
        _time = uint32(val);
      },
      get timeHighByte() {
        return uint8(_time >>> 8);
      },
      get crc() {
        return _crc;
      },
      set crc(val) {
        _crc = uint32(val);
      },
      get compressedSize() {
        return _compressedSize;
      },
      set compressedSize(val) {
        _compressedSize = uint32(val);
      },
      get size() {
        return _size;
      },
      set size(val) {
        _size = uint32(val);
      },
      get fileNameLength() {
        return _fnameLen;
      },
      set fileNameLength(val) {
        _fnameLen = val;
      },
      get extraLength() {
        return _extraLen;
      },
      set extraLength(val) {
        _extraLen = val;
      },
      get extraLocalLength() {
        return _localHeader.extraLen;
      },
      set extraLocalLength(val) {
        _localHeader.extraLen = val;
      },
      get commentLength() {
        return _comLen;
      },
      set commentLength(val) {
        _comLen = val;
      },
      get diskNumStart() {
        return _diskStart;
      },
      set diskNumStart(val) {
        _diskStart = uint32(val);
      },
      get inAttr() {
        return _inattr;
      },
      set inAttr(val) {
        _inattr = uint32(val);
      },
      get attr() {
        return _attr;
      },
      set attr(val) {
        _attr = uint32(val);
      },
      get fileAttr() {
        return (_attr || 0) >> 16 & 4095;
      },
      get offset() {
        return _offset;
      },
      set offset(val) {
        _offset = uint32(val);
      },
      get encrypted() {
        return (_flags & Constants.FLG_ENC) === Constants.FLG_ENC;
      },
      get centralHeaderSize() {
        return Constants.CENHDR + _fnameLen + _extraLen + _comLen;
      },
      get realDataOffset() {
        return _offset + Constants.LOCHDR + _localHeader.fnameLen + _localHeader.extraLen;
      },
      get localHeader() {
        return _localHeader;
      },
      loadLocalHeaderFromBinary: function(input) {
        var data = input.slice(_offset, _offset + Constants.LOCHDR);
        if (data.readUInt32LE(0) !== Constants.LOCSIG)
          throw Utils.Errors.INVALID_LOC();
        _localHeader.version = data.readUInt16LE(Constants.LOCVER), _localHeader.flags = data.readUInt16LE(Constants.LOCFLG), _localHeader.flags_desc = (_localHeader.flags & Constants.FLG_DESC) > 0, _localHeader.method = data.readUInt16LE(Constants.LOCHOW), _localHeader.time = data.readUInt32LE(Constants.LOCTIM), _localHeader.crc = data.readUInt32LE(Constants.LOCCRC), _localHeader.compressedSize = data.readUInt32LE(Constants.LOCSIZ), _localHeader.size = data.readUInt32LE(Constants.LOCLEN), _localHeader.fnameLen = data.readUInt16LE(Constants.LOCNAM), _localHeader.extraLen = data.readUInt16LE(Constants.LOCEXT);
        let extraStart = _offset + Constants.LOCHDR + _localHeader.fnameLen, extraEnd = extraStart + _localHeader.extraLen;
        return input.slice(extraStart, extraEnd);
      },
      loadFromBinary: function(data) {
        if (data.length !== Constants.CENHDR || data.readUInt32LE(0) !== Constants.CENSIG)
          throw Utils.Errors.INVALID_CEN();
        _verMade = data.readUInt16LE(Constants.CENVEM), _version = data.readUInt16LE(Constants.CENVER), _flags = data.readUInt16LE(Constants.CENFLG), _method = data.readUInt16LE(Constants.CENHOW), _time = data.readUInt32LE(Constants.CENTIM), _crc = data.readUInt32LE(Constants.CENCRC), _compressedSize = data.readUInt32LE(Constants.CENSIZ), _size = data.readUInt32LE(Constants.CENLEN), _fnameLen = data.readUInt16LE(Constants.CENNAM), _extraLen = data.readUInt16LE(Constants.CENEXT), _comLen = data.readUInt16LE(Constants.CENCOM), _diskStart = data.readUInt16LE(Constants.CENDSK), _inattr = data.readUInt16LE(Constants.CENATT), _attr = data.readUInt32LE(Constants.CENATX), _offset = data.readUInt32LE(Constants.CENOFF);
      },
      localHeaderToBinary: function() {
        var data = Buffer.alloc(Constants.LOCHDR);
        return data.writeUInt32LE(Constants.LOCSIG, 0), data.writeUInt16LE(_version, Constants.LOCVER), data.writeUInt16LE(_flags & ~Constants.FLG_DESC, Constants.LOCFLG), data.writeUInt16LE(_method, Constants.LOCHOW), data.writeUInt32LE(_time, Constants.LOCTIM), data.writeUInt32LE(_crc, Constants.LOCCRC), data.writeUInt32LE(_compressedSize, Constants.LOCSIZ), data.writeUInt32LE(_size, Constants.LOCLEN), data.writeUInt16LE(_fnameLen, Constants.LOCNAM), data.writeUInt16LE(_localHeader.extraLen, Constants.LOCEXT), data;
      },
      centralHeaderToBinary: function() {
        var data = Buffer.alloc(Constants.CENHDR + _fnameLen + _extraLen + _comLen);
        return data.writeUInt32LE(Constants.CENSIG, 0), data.writeUInt16LE(_verMade, Constants.CENVEM), data.writeUInt16LE(_version, Constants.CENVER), data.writeUInt16LE(_flags & ~Constants.FLG_DESC, Constants.CENFLG), data.writeUInt16LE(_method, Constants.CENHOW), data.writeUInt32LE(_time, Constants.CENTIM), data.writeUInt32LE(_crc, Constants.CENCRC), data.writeUInt32LE(_compressedSize, Constants.CENSIZ), data.writeUInt32LE(_size, Constants.CENLEN), data.writeUInt16LE(_fnameLen, Constants.CENNAM), data.writeUInt16LE(_extraLen, Constants.CENEXT), data.writeUInt16LE(_comLen, Constants.CENCOM), data.writeUInt16LE(_diskStart, Constants.CENDSK), data.writeUInt16LE(_inattr, Constants.CENATT), data.writeUInt32LE(_attr, Constants.CENATX), data.writeUInt32LE(_offset, Constants.CENOFF), data;
      },
      toJSON: function() {
        let bytes = function(nr) {
          return nr + " bytes";
        };
        return {
          made: _verMade,
          version: _version,
          flags: _flags,
          method: Utils.methodToString(_method),
          time: this.time,
          crc: "0x" + _crc.toString(16).toUpperCase(),
          compressedSize: bytes(_compressedSize),
          size: bytes(_size),
          fileNameLength: bytes(_fnameLen),
          extraLength: bytes(_extraLen),
          commentLength: bytes(_comLen),
          diskNumStart: _diskStart,
          inAttr: _inattr,
          attr: _attr,
          offset: _offset,
          centralHeaderSize: bytes(Constants.CENHDR + _fnameLen + _extraLen + _comLen)
        };
      },
      toString: function() {
        return JSON.stringify(this.toJSON(), null, "\t");
      }
    };
  };
});

// ../../../orca/workspaces/AfterQueryFront/gold-fix-runner-buildx/node_modules/adm-zip/headers/mainHeader.js
var require_mainHeader = __commonJS(function(exports, module) {
  var Utils = require_util(), Constants = Utils.Constants;
  module.exports = function() {
    var _volumeEntries = 0, _totalEntries = 0, _size = 0, _offset = 0, _commentLength = 0;
    let needsZip64 = () => _volumeEntries > Constants.EF_ZIP64_OR_16 || _totalEntries > Constants.EF_ZIP64_OR_16 || _size > Constants.EF_ZIP64_OR_32 || _offset > Constants.EF_ZIP64_OR_32;
    return {
      get diskEntries() {
        return _volumeEntries;
      },
      set diskEntries(val) {
        _volumeEntries = _totalEntries = val;
      },
      get totalEntries() {
        return _totalEntries;
      },
      set totalEntries(val) {
        _totalEntries = _volumeEntries = val;
      },
      get size() {
        return _size;
      },
      set size(val) {
        _size = val;
      },
      get offset() {
        return _offset;
      },
      set offset(val) {
        _offset = val;
      },
      get commentLength() {
        return _commentLength;
      },
      set commentLength(val) {
        _commentLength = val;
      },
      get mainHeaderSize() {
        return (needsZip64() ? Constants.ZIP64HDR + Constants.END64HDR : 0) + Constants.ENDHDR + _commentLength;
      },
      loadFromBinary: function(data) {
        if ((data.length !== Constants.ENDHDR || data.readUInt32LE(0) !== Constants.ENDSIG) && (data.length < Constants.ZIP64HDR || data.readUInt32LE(0) !== Constants.ZIP64SIG))
          throw Utils.Errors.INVALID_END();
        if (data.readUInt32LE(0) === Constants.ENDSIG)
          _volumeEntries = data.readUInt16LE(Constants.ENDSUB), _totalEntries = data.readUInt16LE(Constants.ENDTOT), _size = data.readUInt32LE(Constants.ENDSIZ), _offset = data.readUInt32LE(Constants.ENDOFF), _commentLength = data.readUInt16LE(Constants.ENDCOM);
        else
          _volumeEntries = Utils.readBigUInt64LE(data, Constants.ZIP64SUB), _totalEntries = Utils.readBigUInt64LE(data, Constants.ZIP64TOT), _size = Utils.readBigUInt64LE(data, Constants.ZIP64SIZB), _offset = Utils.readBigUInt64LE(data, Constants.ZIP64OFF), _commentLength = 0;
      },
      toBinary: function() {
        if (!needsZip64()) {
          var b = Buffer.alloc(Constants.ENDHDR + _commentLength);
          return b.writeUInt32LE(Constants.ENDSIG, 0), b.writeUInt32LE(0, 4), b.writeUInt16LE(_volumeEntries, Constants.ENDSUB), b.writeUInt16LE(_totalEntries, Constants.ENDTOT), b.writeUInt32LE(_size, Constants.ENDSIZ), b.writeUInt32LE(_offset, Constants.ENDOFF), b.writeUInt16LE(_commentLength, Constants.ENDCOM), b.fill(" ", Constants.ENDHDR), b;
        }
        var b = Buffer.alloc(this.mainHeaderSize);
        let offset = 0;
        b.writeUInt32LE(Constants.ZIP64SIG, offset), Utils.writeBigUInt64LE(b, Constants.ZIP64HDR - Constants.ZIP64LEAD, offset + Constants.ZIP64SIZE), b.writeUInt16LE(45, offset + Constants.ZIP64VEM), b.writeUInt16LE(45, offset + Constants.ZIP64VER), b.writeUInt32LE(0, offset + Constants.ZIP64DSK), b.writeUInt32LE(0, offset + Constants.ZIP64DSKDIR), Utils.writeBigUInt64LE(b, _volumeEntries, offset + Constants.ZIP64SUB), Utils.writeBigUInt64LE(b, _totalEntries, offset + Constants.ZIP64TOT), Utils.writeBigUInt64LE(b, _size, offset + Constants.ZIP64SIZB), Utils.writeBigUInt64LE(b, _offset, offset + Constants.ZIP64OFF);
        let zip64EndOffset = _offset + _size;
        return offset += Constants.ZIP64HDR, b.writeUInt32LE(Constants.END64SIG, offset), b.writeUInt32LE(0, offset + Constants.END64START), Utils.writeBigUInt64LE(b, zip64EndOffset, offset + Constants.END64OFF), b.writeUInt32LE(1, offset + Constants.END64NUMDISKS), offset += Constants.END64HDR, b.writeUInt32LE(Constants.ENDSIG, offset), b.writeUInt32LE(0, offset + 4), b.writeUInt16LE(Math.min(_volumeEntries, Constants.EF_ZIP64_OR_16), offset + Constants.ENDSUB), b.writeUInt16LE(Math.min(_totalEntries, Constants.EF_ZIP64_OR_16), offset + Constants.ENDTOT), b.writeUInt32LE(Math.min(_size, Constants.EF_ZIP64_OR_32), offset + Constants.ENDSIZ), b.writeUInt32LE(Math.min(_offset, Constants.EF_ZIP64_OR_32), offset + Constants.ENDOFF), b.writeUInt16LE(_commentLength, offset + Constants.ENDCOM), b.fill(" ", offset + Constants.ENDHDR), b;
      },
      toJSON: function() {
        let offset = function(nr, len) {
          let offs = nr.toString(16).toUpperCase();
          while (offs.length < len)
            offs = "0" + offs;
          return "0x" + offs;
        };
        return {
          diskEntries: _volumeEntries,
          totalEntries: _totalEntries,
          size: _size + " bytes",
          offset: offset(_offset, 4),
          commentLength: _commentLength
        };
      },
      toString: function() {
        return JSON.stringify(this.toJSON(), null, "\t");
      }
    };
  };
});

// ../../../orca/workspaces/AfterQueryFront/gold-fix-runner-buildx/node_modules/adm-zip/headers/index.js
var require_headers = __commonJS(function(exports) {
  exports.EntryHeader = require_entryHeader();
  exports.MainHeader = require_mainHeader();
});

// ../../../orca/workspaces/AfterQueryFront/gold-fix-runner-buildx/node_modules/adm-zip/methods/deflater.js
var require_deflater = __commonJS(function(exports, module) {
  module.exports = function(inbuf) {
    var zlib = __require("zlib"), opts = { chunkSize: (parseInt(inbuf.length / 1024) + 1) * 1024 };
    return {
      deflate: function() {
        return zlib.deflateRawSync(inbuf, opts);
      },
      deflateAsync: function(callback) {
        var tmp = zlib.createDeflateRaw(opts), parts = [], total = 0;
        tmp.on("data", function(data) {
          parts.push(data), total += data.length;
        }), tmp.on("end", function() {
          var buf = Buffer.alloc(total), written = 0;
          buf.fill(0);
          for (var i = 0;i < parts.length; i++) {
            var part = parts[i];
            part.copy(buf, written), written += part.length;
          }
          callback && callback(buf);
        }), tmp.end(inbuf);
      }
    };
  };
});

// ../../../orca/workspaces/AfterQueryFront/gold-fix-runner-buildx/node_modules/adm-zip/methods/inflater.js
var require_inflater = __commonJS(function(exports, module) {
  var version = +(process?.versions?.node ?? "").split(".")[0] || 0;
  module.exports = function(inbuf, expectedLength) {
    var zlib = __require("zlib");
    let option = version >= 15 && expectedLength > 0 ? { maxOutputLength: expectedLength } : {};
    return {
      inflate: function() {
        return zlib.inflateRawSync(inbuf, option);
      },
      inflateAsync: function(callback) {
        var tmp = zlib.createInflateRaw(option), parts = [], total = 0;
        tmp.on("data", function(data) {
          parts.push(data), total += data.length;
        }), tmp.on("end", function() {
          var buf = Buffer.alloc(total), written = 0;
          buf.fill(0);
          for (var i = 0;i < parts.length; i++) {
            var part = parts[i];
            part.copy(buf, written), written += part.length;
          }
          callback && callback(buf);
        }), tmp.end(inbuf);
      }
    };
  };
});

// ../../../orca/workspaces/AfterQueryFront/gold-fix-runner-buildx/node_modules/adm-zip/methods/zipcrypto.js
var require_zipcrypto = __commonJS(function(exports, module) {
  var { randomFillSync } = __require("crypto"), Errors = require_errors(), crctable = new Uint32Array(256).map((t, crc) => {
    for (let j = 0;j < 8; j++)
      if ((crc & 1) !== 0)
        crc = crc >>> 1 ^ 3988292384;
      else
        crc >>>= 1;
    return crc >>> 0;
  }), uMul = (a, b) => Math.imul(a, b) >>> 0, crc32update = (pCrc32, bval) => crctable[(pCrc32 ^ bval) & 255] ^ pCrc32 >>> 8, genSalt = () => {
    if (typeof randomFillSync === "function")
      return randomFillSync(Buffer.alloc(12));
    else
      return genSalt.node();
  };
  genSalt.node = () => {
    let salt = Buffer.alloc(12), len = salt.length;
    for (let i = 0;i < len; i++)
      salt[i] = Math.random() * 256 & 255;
    return salt;
  };
  var config = {
    genSalt
  };
  function Initkeys(pw) {
    let pass = Buffer.isBuffer(pw) ? pw : Buffer.from(pw);
    this.keys = new Uint32Array([305419896, 591751049, 878082192]);
    for (let i = 0;i < pass.length; i++)
      this.updateKeys(pass[i]);
  }
  Initkeys.prototype.updateKeys = function(byteValue) {
    let keys = this.keys;
    return keys[0] = crc32update(keys[0], byteValue), keys[1] += keys[0] & 255, keys[1] = uMul(keys[1], 134775813) + 1, keys[2] = crc32update(keys[2], keys[1] >>> 24), byteValue;
  };
  Initkeys.prototype.next = function() {
    let k = (this.keys[2] | 2) >>> 0;
    return uMul(k, k ^ 1) >> 8 & 255;
  };
  function make_decrypter(pwd) {
    let keys = new Initkeys(pwd);
    return function(data) {
      let result = Buffer.alloc(data.length), pos = 0;
      for (let c of data)
        result[pos++] = keys.updateKeys(c ^ keys.next());
      return result;
    };
  }
  function make_encrypter(pwd) {
    let keys = new Initkeys(pwd);
    return function(data, result, pos = 0) {
      if (!result)
        result = Buffer.alloc(data.length);
      for (let c of data) {
        let k = keys.next();
        result[pos++] = c ^ k, keys.updateKeys(c);
      }
      return result;
    };
  }
  function decrypt(data, header, pwd) {
    if (!data || !Buffer.isBuffer(data) || data.length < 12)
      return Buffer.alloc(0);
    let decrypter = make_decrypter(pwd), salt = decrypter(data.slice(0, 12)), verifyByte = (header.flags & 8) === 8 ? header.timeHighByte : header.crc >>> 24;
    if (salt[11] !== verifyByte)
      throw Errors.WRONG_PASSWORD();
    return decrypter(data.slice(12));
  }
  function _salter(data) {
    if (Buffer.isBuffer(data) && data.length >= 12)
      config.genSalt = function() {
        return data.slice(0, 12);
      };
    else if (data === "node")
      config.genSalt = genSalt.node;
    else
      config.genSalt = genSalt;
  }
  function encrypt(data, header, pwd, oldlike = !1) {
    if (data == null)
      data = Buffer.alloc(0);
    if (!Buffer.isBuffer(data))
      data = Buffer.from(data.toString());
    let encrypter = make_encrypter(pwd), salt = config.genSalt();
    if (salt[11] = header.crc >>> 24 & 255, oldlike)
      salt[10] = header.crc >>> 16 & 255;
    let result = Buffer.alloc(data.length + 12);
    return encrypter(salt, result), encrypter(data, result, 12);
  }
  module.exports = { decrypt, encrypt, _salter };
});

// ../../../orca/workspaces/AfterQueryFront/gold-fix-runner-buildx/node_modules/adm-zip/methods/index.js
var require_methods = __commonJS(function(exports) {
  exports.Deflater = require_deflater();
  exports.Inflater = require_inflater();
  exports.ZipCrypto = require_zipcrypto();
});

// ../../../orca/workspaces/AfterQueryFront/gold-fix-runner-buildx/node_modules/adm-zip/zipEntry.js
var require_zipEntry = __commonJS(function(exports, module) {
  var Utils = require_util(), Headers = require_headers(), Constants = Utils.Constants, Methods = require_methods();
  module.exports = function(options, input) {
    var _centralHeader = new Headers.EntryHeader, _entryName = Buffer.alloc(0), _comment = Buffer.alloc(0), _isDirectory = !1, uncompressedData = null, _extra = Buffer.alloc(0), _extralocal = Buffer.alloc(0), _efs = !0;
    let opts = options, decoder = typeof opts.decoder === "object" ? opts.decoder : Utils.decoder;
    _efs = decoder.hasOwnProperty("efs") ? decoder.efs : !1;
    function getCompressedDataFromZip() {
      if (!input || !(input instanceof Uint8Array))
        return Buffer.alloc(0);
      return _extralocal = _centralHeader.loadLocalHeaderFromBinary(input), input.slice(_centralHeader.realDataOffset, _centralHeader.realDataOffset + _centralHeader.compressedSize);
    }
    function crc32OK(data) {
      let expectedCrc = _centralHeader.flags_desc || _centralHeader.localHeader.flags_desc ? _centralHeader.crc : _centralHeader.localHeader.crc;
      return Utils.crc32(data) === expectedCrc;
    }
    function decompress(async, callback, pass) {
      if (typeof callback > "u" && typeof async === "string")
        pass = async, async = void 0;
      if (_isDirectory) {
        if (async && callback)
          callback(Buffer.alloc(0), Utils.Errors.DIRECTORY_CONTENT_ERROR());
        return Buffer.alloc(0);
      }
      var compressedData = getCompressedDataFromZip();
      if (compressedData.length === 0) {
        if (async && callback)
          callback(compressedData);
        return compressedData;
      }
      if (_centralHeader.encrypted) {
        if (typeof pass !== "string" && !Buffer.isBuffer(pass))
          throw Utils.Errors.INVALID_PASS_PARAM();
        compressedData = Methods.ZipCrypto.decrypt(compressedData, _centralHeader, pass);
      }
      var data;
      switch (_centralHeader.method) {
        case Utils.Constants.STORED:
          if (data = Buffer.alloc(compressedData.length), compressedData.copy(data), !crc32OK(data)) {
            if (async && callback)
              callback(data, Utils.Errors.BAD_CRC());
            throw Utils.Errors.BAD_CRC();
          } else {
            if (async && callback)
              callback(data);
            return data;
          }
        case Utils.Constants.DEFLATED:
          var inflater = new Methods.Inflater(compressedData, _centralHeader.size);
          if (!async) {
            if (data = inflater.inflate(), !crc32OK(data))
              throw Utils.Errors.BAD_CRC(`"${decoder.decode(_entryName)}"`);
            return data;
          } else
            inflater.inflateAsync(function(result) {
              if (callback)
                if (!crc32OK(result))
                  callback(result, Utils.Errors.BAD_CRC());
                else
                  callback(result);
            });
          break;
        default:
          if (async && callback)
            callback(Buffer.alloc(0), Utils.Errors.UNKNOWN_METHOD());
          throw Utils.Errors.UNKNOWN_METHOD();
      }
    }
    function compress(async, callback) {
      if ((!uncompressedData || !uncompressedData.length) && Buffer.isBuffer(input)) {
        if (async && callback)
          callback(getCompressedDataFromZip());
        return getCompressedDataFromZip();
      }
      if (uncompressedData.length && !_isDirectory) {
        var compressedData;
        switch (_centralHeader.method) {
          case Utils.Constants.STORED:
            if (_centralHeader.compressedSize = _centralHeader.size, compressedData = Buffer.alloc(uncompressedData.length), uncompressedData.copy(compressedData), async && callback)
              callback(compressedData);
            return compressedData;
          default:
          case Utils.Constants.DEFLATED:
            var deflater = new Methods.Deflater(uncompressedData);
            if (!async) {
              var deflated = deflater.deflate();
              return _centralHeader.compressedSize = deflated.length, deflated;
            } else
              deflater.deflateAsync(function(data) {
                compressedData = Buffer.alloc(data.length), _centralHeader.compressedSize = data.length, data.copy(compressedData), callback && callback(compressedData);
              });
            deflater = null;
            break;
        }
      } else if (async && callback)
        callback(Buffer.alloc(0));
      else
        return Buffer.alloc(0);
    }
    function readUInt64LE(buffer, offset) {
      return Utils.readBigUInt64LE(buffer, offset);
    }
    function parseExtra(data) {
      try {
        var offset = 0, signature, size, part;
        while (offset + 4 < data.length)
          if (signature = data.readUInt16LE(offset), offset += 2, size = data.readUInt16LE(offset), offset += 2, part = data.slice(offset, offset + size), offset += size, Constants.ID_ZIP64 === signature)
            parseZip64ExtendedInformation(part);
      } catch (error) {
        throw Utils.Errors.EXTRA_FIELD_PARSE_ERROR();
      }
    }
    function parseZip64ExtendedInformation(data) {
      var size, compressedSize, offset, diskNumStart;
      if (data.length >= Constants.EF_ZIP64_SCOMP) {
        if (size = readUInt64LE(data, Constants.EF_ZIP64_SUNCOMP), _centralHeader.size === Constants.EF_ZIP64_OR_32)
          _centralHeader.size = size;
      }
      if (data.length >= Constants.EF_ZIP64_RHO) {
        if (compressedSize = readUInt64LE(data, Constants.EF_ZIP64_SCOMP), _centralHeader.compressedSize === Constants.EF_ZIP64_OR_32)
          _centralHeader.compressedSize = compressedSize;
      }
      if (data.length >= Constants.EF_ZIP64_DSN) {
        if (offset = readUInt64LE(data, Constants.EF_ZIP64_RHO), _centralHeader.offset === Constants.EF_ZIP64_OR_32)
          _centralHeader.offset = offset;
      }
      if (data.length >= Constants.EF_ZIP64_DSN + 4) {
        if (diskNumStart = data.readUInt32LE(Constants.EF_ZIP64_DSN), _centralHeader.diskNumStart === Constants.EF_ZIP64_OR_16)
          _centralHeader.diskNumStart = diskNumStart;
      }
    }
    return {
      get entryName() {
        return decoder.decode(_entryName);
      },
      get rawEntryName() {
        return _entryName;
      },
      set entryName(val) {
        _entryName = Utils.toBuffer(val, decoder.encode);
        var lastChar = _entryName[_entryName.length - 1];
        _isDirectory = lastChar === 47 || lastChar === 92, _centralHeader.fileNameLength = _entryName.length;
      },
      get efs() {
        if (typeof _efs === "function")
          return _efs(this.entryName);
        else
          return _efs;
      },
      get extra() {
        return _extra;
      },
      set extra(val) {
        _extra = val, _centralHeader.extraLength = val.length, parseExtra(val);
      },
      get comment() {
        return decoder.decode(_comment);
      },
      set comment(val) {
        if (_comment = Utils.toBuffer(val, decoder.encode), _centralHeader.commentLength = _comment.length, _comment.length > 65535)
          throw Utils.Errors.COMMENT_TOO_LONG();
      },
      get name() {
        let n = decoder.decode(_entryName);
        return _isDirectory ? n.replace(/[/\\]$/, "").split("/").pop() : n.split("/").pop();
      },
      get isDirectory() {
        return _isDirectory;
      },
      getCompressedData: function() {
        return compress(!1, null);
      },
      getCompressedDataAsync: function(callback) {
        compress(!0, callback);
      },
      setData: function(value) {
        if (uncompressedData = Utils.toBuffer(value, Utils.decoder.encode), !_isDirectory && uncompressedData.length)
          _centralHeader.size = uncompressedData.length, _centralHeader.method = Utils.Constants.DEFLATED, _centralHeader.crc = Utils.crc32(value), _centralHeader.changed = !0;
        else
          _centralHeader.method = Utils.Constants.STORED;
      },
      getData: function(pass) {
        if (_centralHeader.changed)
          return uncompressedData;
        else
          return decompress(!1, null, pass);
      },
      getDataAsync: function(callback, pass) {
        if (_centralHeader.changed)
          callback(uncompressedData);
        else
          decompress(!0, callback, pass);
      },
      set attr(attr) {
        _centralHeader.attr = attr;
      },
      get attr() {
        return _centralHeader.attr;
      },
      set header(data) {
        _centralHeader.loadFromBinary(data);
      },
      get header() {
        return _centralHeader;
      },
      packCentralHeader: function() {
        _centralHeader.flags_efs = this.efs, _centralHeader.extraLength = _extra.length;
        var header = _centralHeader.centralHeaderToBinary(), addpos = Utils.Constants.CENHDR;
        return _entryName.copy(header, addpos), addpos += _entryName.length, _extra.copy(header, addpos), addpos += _centralHeader.extraLength, _comment.copy(header, addpos), header;
      },
      packLocalHeader: function() {
        let addpos = 0;
        _centralHeader.flags_efs = this.efs, _centralHeader.extraLocalLength = _extralocal.length;
        let localHeaderBuf = _centralHeader.localHeaderToBinary(), localHeader = Buffer.alloc(localHeaderBuf.length + _entryName.length + _centralHeader.extraLocalLength);
        return localHeaderBuf.copy(localHeader, addpos), addpos += localHeaderBuf.length, _entryName.copy(localHeader, addpos), addpos += _entryName.length, _extralocal.copy(localHeader, addpos), addpos += _extralocal.length, localHeader;
      },
      toJSON: function() {
        let bytes = function(nr) {
          return "<" + (nr && nr.length + " bytes buffer" || "null") + ">";
        };
        return {
          entryName: this.entryName,
          name: this.name,
          comment: this.comment,
          isDirectory: this.isDirectory,
          header: _centralHeader.toJSON(),
          compressedData: bytes(input),
          data: bytes(uncompressedData)
        };
      },
      toString: function() {
        return JSON.stringify(this.toJSON(), null, "\t");
      }
    };
  };
});

// ../../../orca/workspaces/AfterQueryFront/gold-fix-runner-buildx/node_modules/adm-zip/zipFile.js
var require_zipFile = __commonJS(function(exports, module) {
  var ZipEntry = require_zipEntry(), Headers = require_headers(), Utils = require_util();
  module.exports = function(inBuffer, options) {
    var entryList = [], entryTable = Object.create(null), _comment = Buffer.alloc(0), mainHeader = new Headers.MainHeader, loadedEntries = !1, password = null;
    let temporary = /* @__PURE__ */ new Set, opts = options, { noSort, decoder } = opts;
    if (inBuffer)
      readMainHeader(opts.readEntries);
    else
      loadedEntries = !0;
    function makeTemporaryFolders() {
      let foldersList = /* @__PURE__ */ new Set;
      for (let elem of Object.keys(entryTable)) {
        let elements = elem.split("/");
        if (elements.pop(), !elements.length)
          continue;
        for (let i = 0;i < elements.length; i++) {
          let sub = elements.slice(0, i + 1).join("/") + "/";
          foldersList.add(sub);
        }
      }
      for (let elem of foldersList)
        if (!(elem in entryTable)) {
          let tempfolder = new ZipEntry(opts);
          tempfolder.entryName = elem, tempfolder.attr = 16, tempfolder.temporary = !0, entryList.push(tempfolder), entryTable[tempfolder.entryName] = tempfolder, temporary.add(tempfolder);
        }
    }
    function readEntries() {
      if (loadedEntries = !0, entryTable = Object.create(null), mainHeader.diskEntries > (inBuffer.length - mainHeader.offset) / Utils.Constants.CENHDR)
        throw Utils.Errors.DISK_ENTRY_TOO_LARGE();
      entryList = Array(mainHeader.diskEntries);
      var index = mainHeader.offset;
      for (var i = 0;i < entryList.length; i++) {
        var tmp = index, entry = new ZipEntry(opts, inBuffer);
        if (entry.header = inBuffer.slice(tmp, tmp += Utils.Constants.CENHDR), entry.entryName = inBuffer.slice(tmp, tmp += entry.header.fileNameLength), entry.header.extraLength)
          entry.extra = inBuffer.slice(tmp, tmp += entry.header.extraLength);
        if (entry.header.commentLength)
          entry.comment = inBuffer.slice(tmp, tmp + entry.header.commentLength);
        index += entry.header.centralHeaderSize, entryList[i] = entry, entryTable[entry.entryName] = entry;
      }
      temporary.clear(), makeTemporaryFolders();
    }
    function readMainHeader(readNow) {
      var i = inBuffer.length - Utils.Constants.ENDHDR, max = Math.max(0, i - 65535), n = max, endStart = inBuffer.length, endOffset = -1, commentEnd = 0;
      if (typeof opts.trailingSpace === "boolean" ? opts.trailingSpace : !1)
        max = 0;
      for (i;i >= n; i--) {
        if (inBuffer[i] !== 80)
          continue;
        if (inBuffer.readUInt32LE(i) === Utils.Constants.ENDSIG) {
          endOffset = i, commentEnd = i, endStart = i + Utils.Constants.ENDHDR, n = i - Utils.Constants.END64HDR;
          continue;
        }
        if (inBuffer.readUInt32LE(i) === Utils.Constants.END64SIG) {
          n = max;
          continue;
        }
        if (inBuffer.readUInt32LE(i) === Utils.Constants.ZIP64SIG) {
          endOffset = i, endStart = i + Utils.readBigUInt64LE(inBuffer, i + Utils.Constants.ZIP64SIZE) + Utils.Constants.ZIP64LEAD;
          break;
        }
      }
      if (endOffset == -1)
        throw Utils.Errors.INVALID_FORMAT();
      if (mainHeader.loadFromBinary(inBuffer.slice(endOffset, endStart)), mainHeader.commentLength)
        _comment = inBuffer.slice(commentEnd + Utils.Constants.ENDHDR);
      if (readNow)
        readEntries();
    }
    function sortEntries() {
      if (entryList.length > 1 && !noSort)
        entryList = entryList.map((entry) => ({ entry, key: entry.entryName.toLowerCase() })).sort((a, b) => a.key.localeCompare(b.key)).map((pair) => pair.entry);
    }
    return {
      get entries() {
        if (!loadedEntries)
          readEntries();
        return entryList.filter((e) => !temporary.has(e));
      },
      get comment() {
        return decoder.decode(_comment);
      },
      set comment(val) {
        _comment = Utils.toBuffer(val, decoder.encode), mainHeader.commentLength = _comment.length;
      },
      getEntryCount: function() {
        if (!loadedEntries)
          return mainHeader.diskEntries;
        return entryList.length;
      },
      forEach: function(callback) {
        this.entries.forEach(callback);
      },
      getEntry: function(entryName) {
        if (!loadedEntries)
          readEntries();
        return entryTable[entryName] || null;
      },
      setEntry: function(entry) {
        if (!loadedEntries)
          readEntries();
        entryList.push(entry), entryTable[entry.entryName] = entry, mainHeader.totalEntries = entryList.length;
      },
      deleteFile: function(entryName, withsubfolders = !0) {
        if (!loadedEntries)
          readEntries();
        let entry = entryTable[entryName];
        this.getEntryChildren(entry, withsubfolders).map((child) => child.entryName).forEach(this.deleteEntry);
      },
      deleteEntry: function(entryName) {
        if (!loadedEntries)
          readEntries();
        let entry = entryTable[entryName], index = entryList.indexOf(entry);
        if (index >= 0)
          entryList.splice(index, 1), delete entryTable[entryName], mainHeader.totalEntries = entryList.length;
      },
      getEntryChildren: function(entry, subfolders = !0) {
        if (!loadedEntries)
          readEntries();
        if (typeof entry === "object")
          if (entry.isDirectory && subfolders) {
            let list = [], name = entry.entryName;
            for (let zipEntry of entryList)
              if (zipEntry.entryName.startsWith(name))
                list.push(zipEntry);
            return list;
          } else
            return [entry];
        return [];
      },
      getChildCount: function(entry) {
        if (entry && entry.isDirectory) {
          let list = this.getEntryChildren(entry);
          return list.includes(entry) ? list.length - 1 : list.length;
        }
        return 0;
      },
      compressToBuffer: function() {
        if (!loadedEntries)
          readEntries();
        sortEntries();
        let dataBlock = [], headerBlocks = [], totalSize = 0, dindex = 0;
        mainHeader.size = 0, mainHeader.offset = 0;
        let totalEntries = 0;
        for (let entry of this.entries) {
          let compressedData = entry.getCompressedData();
          entry.header.offset = dindex;
          let localHeader = entry.packLocalHeader(), dataLength = localHeader.length + compressedData.length;
          dindex += dataLength, dataBlock.push(localHeader), dataBlock.push(compressedData);
          let centralHeader = entry.packCentralHeader();
          headerBlocks.push(centralHeader), mainHeader.size += centralHeader.length, totalSize += dataLength + centralHeader.length, totalEntries++;
        }
        totalSize += mainHeader.mainHeaderSize, mainHeader.offset = dindex, mainHeader.totalEntries = totalEntries, dindex = 0;
        let outBuffer = Buffer.alloc(totalSize);
        for (let content of dataBlock)
          content.copy(outBuffer, dindex), dindex += content.length;
        for (let content of headerBlocks)
          content.copy(outBuffer, dindex), dindex += content.length;
        let mh = mainHeader.toBinary();
        if (_comment)
          _comment.copy(mh, mh.length - _comment.length);
        return mh.copy(outBuffer, dindex), inBuffer = outBuffer, loadedEntries = !1, outBuffer;
      },
      toAsyncBuffer: function(onSuccess, onFail, onItemStart, onItemEnd) {
        try {
          if (!loadedEntries)
            readEntries();
          sortEntries();
          let dataBlock = [], centralHeaders = [], totalSize = 0, dindex = 0, totalEntries = 0;
          mainHeader.size = 0, mainHeader.offset = 0;
          let compress2Buffer = function(entryLists) {
            if (entryLists.length > 0) {
              let entry = entryLists.shift(), name = entry.entryName + entry.extra.toString();
              if (onItemStart)
                onItemStart(name);
              entry.getCompressedDataAsync(function(compressedData) {
                if (onItemEnd)
                  onItemEnd(name);
                entry.header.offset = dindex;
                let localHeader = entry.packLocalHeader(), dataLength = localHeader.length + compressedData.length;
                dindex += dataLength, dataBlock.push(localHeader), dataBlock.push(compressedData);
                let centalHeader = entry.packCentralHeader();
                centralHeaders.push(centalHeader), mainHeader.size += centalHeader.length, totalSize += dataLength + centalHeader.length, totalEntries++, compress2Buffer(entryLists);
              });
            } else {
              totalSize += mainHeader.mainHeaderSize, mainHeader.offset = dindex, mainHeader.totalEntries = totalEntries, dindex = 0;
              let outBuffer = Buffer.alloc(totalSize);
              dataBlock.forEach(function(content) {
                content.copy(outBuffer, dindex), dindex += content.length;
              }), centralHeaders.forEach(function(content) {
                content.copy(outBuffer, dindex), dindex += content.length;
              });
              let mh = mainHeader.toBinary();
              if (_comment)
                _comment.copy(mh, mh.length - _comment.length);
              mh.copy(outBuffer, dindex), inBuffer = outBuffer, loadedEntries = !1, onSuccess(outBuffer);
            }
          };
          compress2Buffer(Array.from(this.entries));
        } catch (e) {
          onFail(e);
        }
      }
    };
  };
});

// ../../../orca/workspaces/AfterQueryFront/gold-fix-runner-buildx/node_modules/adm-zip/adm-zip.js
var require_adm_zip = __commonJS(function(exports, module) {
  var Utils = require_util(), pth = __require("path"), ZipEntry = require_zipEntry(), ZipFile = require_zipFile(), get_Bool = (...val) => Utils.findLast(val, (c) => typeof c === "boolean"), get_Str = (...val) => Utils.findLast(val, (c) => typeof c === "string"), get_Fun = (...val) => Utils.findLast(val, (c) => typeof c === "function"), defaultOptions = {
    noSort: !1,
    readEntries: !1,
    method: Utils.Constants.NONE,
    fs: null
  };
  module.exports = function(input, options) {
    let inBuffer = null, opts = Object.assign(Object.create(null), defaultOptions);
    if (input && typeof input === "object") {
      if (!(input instanceof Uint8Array)) {
        if (Object.assign(opts, input), input = opts.input ? opts.input : void 0, opts.input)
          delete opts.input;
      }
      if (Buffer.isBuffer(input))
        inBuffer = input, opts.method = Utils.Constants.BUFFER, input = void 0;
    }
    Object.assign(opts, options);
    let filetools = new Utils(opts), applyDirAttributes = (dirEntries) => {
      dirEntries.filter((d) => d.attr).sort((a, b) => b.path.length - a.path.length).forEach((d) => filetools.fs.chmodSync(d.path, d.attr));
    };
    if (typeof opts.decoder !== "object" || typeof opts.decoder.encode !== "function" || typeof opts.decoder.decode !== "function")
      opts.decoder = Utils.decoder;
    if (input && typeof input === "string")
      if (filetools.fs.existsSync(input))
        opts.method = Utils.Constants.FILE, opts.filename = input, inBuffer = filetools.fs.readFileSync(input);
      else
        throw Utils.Errors.INVALID_FILENAME();
    let _zip = new ZipFile(inBuffer, opts), { canonical, sanitize, zipnamefix } = Utils;
    function getEntry(entry) {
      if (entry && _zip) {
        var item;
        if (typeof entry === "string")
          item = _zip.getEntry(pth.posix.normalize(entry));
        if (typeof entry === "object" && typeof entry.entryName < "u" && typeof entry.header < "u")
          item = _zip.getEntry(entry.entryName);
        if (item)
          return item;
      }
      return null;
    }
    function fixPath(zipPath) {
      let { join, normalize, sep } = pth.posix;
      return join(pth.isAbsolute(zipPath) ? "/" : ".", normalize(sep + zipPath.split("\\").join(sep) + sep));
    }
    function filenameFilter(filterfn) {
      if (filterfn instanceof RegExp)
        return function(rx) {
          return function(filename) {
            return rx.test(filename);
          };
        }(filterfn);
      else if (typeof filterfn !== "function")
        return () => !0;
      return filterfn;
    }
    let relativePath = (local, entry) => {
      let lastChar = entry.slice(-1);
      return lastChar = lastChar === filetools.sep ? filetools.sep : "", pth.relative(local, entry) + lastChar;
    };
    return {
      readFile: function(entry, pass) {
        var item = getEntry(entry);
        return item && item.getData(pass) || null;
      },
      childCount: function(entry) {
        let item = getEntry(entry);
        if (item)
          return _zip.getChildCount(item);
      },
      readFileAsync: function(entry, callback) {
        var item = getEntry(entry);
        if (item)
          item.getDataAsync(callback);
        else
          callback(null, "getEntry failed for:" + entry);
      },
      readAsText: function(entry, encoding) {
        var item = getEntry(entry);
        if (item) {
          var data = item.getData();
          if (data && data.length)
            return data.toString(encoding || "utf8");
        }
        return "";
      },
      readAsTextAsync: function(entry, callback, encoding) {
        var item = getEntry(entry);
        if (item)
          item.getDataAsync(function(data, err) {
            if (err) {
              callback(data, err);
              return;
            }
            if (data && data.length)
              callback(data.toString(encoding || "utf8"));
            else
              callback("");
          });
        else
          callback("");
      },
      deleteFile: function(entry, withsubfolders = !0) {
        var item = getEntry(entry);
        if (item)
          _zip.deleteFile(item.entryName, withsubfolders);
      },
      deleteEntry: function(entry) {
        var item = getEntry(entry);
        if (item)
          _zip.deleteEntry(item.entryName);
      },
      addZipComment: function(comment) {
        _zip.comment = comment;
      },
      getZipComment: function() {
        return _zip.comment || "";
      },
      addZipEntryComment: function(entry, comment) {
        var item = getEntry(entry);
        if (item)
          item.comment = comment;
      },
      getZipEntryComment: function(entry) {
        var item = getEntry(entry);
        if (item)
          return item.comment || "";
        return "";
      },
      updateFile: function(entry, content) {
        var item = getEntry(entry);
        if (item)
          item.setData(content);
      },
      addLocalFile: function(localPath, zipPath, zipName, comment) {
        if (filetools.fs.existsSync(localPath)) {
          zipPath = zipPath ? fixPath(zipPath) : "";
          let p = pth.win32.basename(pth.win32.normalize(localPath));
          zipPath += zipName ? zipName : p;
          let _attr = filetools.fs.statSync(localPath), data = _attr.isFile() ? filetools.fs.readFileSync(localPath) : Buffer.alloc(0);
          if (_attr.isDirectory())
            zipPath += filetools.sep;
          this.addFile(zipPath, data, comment, _attr);
        } else
          throw Utils.Errors.FILE_NOT_FOUND(localPath);
      },
      addLocalFileAsync: function(options, callback) {
        options = typeof options === "object" ? options : { localPath: options };
        let localPath = pth.resolve(options.localPath), { comment } = options, { zipPath, zipName } = options, self = this;
        filetools.fs.stat(localPath, function(err, stats) {
          if (err)
            return callback(err, !1);
          zipPath = zipPath ? fixPath(zipPath) : "";
          let p = pth.win32.basename(pth.win32.normalize(localPath));
          if (zipPath += zipName ? zipName : p, stats.isFile())
            filetools.fs.readFile(localPath, function(err, data) {
              if (err)
                return callback(err, !1);
              return self.addFile(zipPath, data, comment, stats), setImmediate(callback, void 0, !0);
            });
          else if (stats.isDirectory())
            return zipPath += filetools.sep, self.addFile(zipPath, Buffer.alloc(0), comment, stats), setImmediate(callback, void 0, !0);
        });
      },
      addLocalFolder: function(localPath, zipPath, filter) {
        if (filter = filenameFilter(filter), zipPath = zipPath ? fixPath(zipPath) : "", localPath = pth.normalize(localPath), filetools.fs.existsSync(localPath)) {
          let items = filetools.findFiles(localPath), self = this;
          if (items.length)
            for (let filepath of items) {
              let p = pth.join(zipPath, relativePath(localPath, filepath));
              if (filter(p))
                self.addLocalFile(filepath, pth.dirname(p));
            }
        } else
          throw Utils.Errors.FILE_NOT_FOUND(localPath);
      },
      addLocalFolderAsync: function(localPath, callback, zipPath, filter) {
        filter = filenameFilter(filter), zipPath = zipPath ? fixPath(zipPath) : "", localPath = pth.normalize(localPath);
        var self = this;
        filetools.fs.open(localPath, "r", function(err) {
          if (err && err.code === "ENOENT")
            callback(void 0, Utils.Errors.FILE_NOT_FOUND(localPath));
          else if (err)
            callback(void 0, err);
          else {
            var items = filetools.findFiles(localPath), i = -1, next = function() {
              if (i += 1, i < items.length) {
                var filepath = items[i], p = relativePath(localPath, filepath).split("\\").join("/");
                if (p = p.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7E]/g, ""), filter(p))
                  filetools.fs.stat(filepath, function(er0, stats) {
                    if (er0)
                      callback(void 0, er0);
                    if (stats.isFile())
                      filetools.fs.readFile(filepath, function(er1, data) {
                        if (er1)
                          callback(void 0, er1);
                        else
                          self.addFile(zipPath + p, data, "", stats), next();
                      });
                    else
                      self.addFile(zipPath + p + "/", Buffer.alloc(0), "", stats), next();
                  });
                else
                  process.nextTick(() => {
                    next();
                  });
              } else
                callback(!0, void 0);
            };
            next();
          }
        });
      },
      addLocalFolderAsync2: function(options, callback) {
        let self = this;
        options = typeof options === "object" ? options : { localPath: options };
        let localPath = pth.resolve(fixPath(options.localPath)), { zipPath, filter, namefix } = options;
        if (filter instanceof RegExp)
          filter = function(rx) {
            return function(filename) {
              return rx.test(filename);
            };
          }(filter);
        else if (typeof filter !== "function")
          filter = function() {
            return !0;
          };
        if (zipPath = zipPath ? fixPath(zipPath) : "", namefix === "latin1")
          namefix = (str) => str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7E]/g, "");
        if (typeof namefix !== "function")
          namefix = (str) => str;
        let relPathFix = (entry) => pth.join(zipPath, namefix(relativePath(localPath, entry))), fileNameFix = (entry) => pth.win32.basename(pth.win32.normalize(namefix(entry)));
        filetools.fs.open(localPath, "r", function(err) {
          if (err && err.code === "ENOENT")
            callback(void 0, Utils.Errors.FILE_NOT_FOUND(localPath));
          else if (err)
            callback(void 0, err);
          else
            filetools.findFilesAsync(localPath, function(err, fileEntries) {
              if (err)
                return callback(err);
              if (fileEntries = fileEntries.filter((dir) => filter(relPathFix(dir))), !fileEntries.length)
                callback(void 0, !1);
              setImmediate(fileEntries.reverse().reduce(function(next, entry) {
                return function(err, done) {
                  if (err || done === !1)
                    return setImmediate(next, err, !1);
                  self.addLocalFileAsync({
                    localPath: entry,
                    zipPath: pth.dirname(relPathFix(entry)),
                    zipName: fileNameFix(entry)
                  }, next);
                };
              }, callback));
            });
        });
      },
      addLocalFolderPromise: function(localPath, props) {
        return new Promise((resolve, reject) => {
          this.addLocalFolderAsync2(Object.assign({ localPath }, props), (err, done) => {
            if (err)
              reject(err);
            if (done)
              resolve(this);
          });
        });
      },
      addFile: function(entryName, content, comment, attr) {
        entryName = zipnamefix(entryName);
        let entry = getEntry(entryName), update = entry != null;
        if (!update)
          entry = new ZipEntry(opts), entry.entryName = entryName;
        entry.comment = comment || "";
        let isStat = typeof attr === "object" && attr instanceof filetools.fs.Stats;
        if (isStat)
          entry.header.time = attr.mtime;
        var fileattr = entry.isDirectory ? 16 : 0;
        let unix = entry.isDirectory ? 16384 : 32768;
        if (isStat)
          unix |= 4095 & attr.mode;
        else if (typeof attr === "number")
          unix |= 4095 & attr;
        else
          unix |= entry.isDirectory ? 493 : 420;
        if (fileattr = (fileattr | unix << 16) >>> 0, entry.attr = fileattr, entry.setData(content), !update)
          _zip.setEntry(entry);
        return entry;
      },
      getEntries: function(password) {
        return _zip.password = password, _zip ? _zip.entries : [];
      },
      getEntry: function(name) {
        return getEntry(name);
      },
      getEntryCount: function() {
        return _zip.getEntryCount();
      },
      forEach: function(callback) {
        return _zip.forEach(callback);
      },
      extractEntryTo: function(entry, targetPath, maintainEntryPath, overwrite, keepOriginalPermission, outFileName) {
        overwrite = get_Bool(!1, overwrite), keepOriginalPermission = get_Bool(!1, keepOriginalPermission), maintainEntryPath = get_Bool(!0, maintainEntryPath), outFileName = get_Str(keepOriginalPermission, outFileName);
        var item = getEntry(entry);
        if (!item)
          throw Utils.Errors.NO_ENTRY();
        var entryName = canonical(item.entryName), target = sanitize(targetPath, outFileName && !item.isDirectory ? canonical(outFileName) : maintainEntryPath ? entryName : pth.basename(entryName));
        if (item.isDirectory) {
          var children = _zip.getEntryChildren(item);
          return children.forEach(function(child) {
            if (child.isDirectory)
              return;
            var content = child.getData();
            if (!content)
              throw Utils.Errors.CANT_EXTRACT_FILE();
            var name = canonical(maintainEntryPath ? child.entryName : child.entryName.substring(item.entryName.length)), childName = sanitize(targetPath, name);
            let fileAttr = keepOriginalPermission ? child.header.fileAttr : void 0;
            filetools.writeFileTo(childName, content, overwrite, fileAttr);
          }), !0;
        }
        var content = item.getData(_zip.password);
        if (!content)
          throw Utils.Errors.CANT_EXTRACT_FILE();
        if (filetools.fs.existsSync(target) && !overwrite)
          throw Utils.Errors.CANT_OVERRIDE();
        let fileAttr = keepOriginalPermission ? entry.header.fileAttr : void 0;
        return filetools.writeFileTo(target, content, overwrite, fileAttr), !0;
      },
      test: function(pass) {
        if (!_zip)
          return !1;
        for (var entry of _zip.entries)
          try {
            if (entry.isDirectory)
              continue;
            var content = entry.getData(pass);
            if (!content)
              return !1;
          } catch (err) {
            return !1;
          }
        return !0;
      },
      extractAllTo: function(targetPath, overwrite, keepOriginalPermission, pass) {
        if (keepOriginalPermission = get_Bool(!1, keepOriginalPermission), pass = get_Str(keepOriginalPermission, pass), overwrite = get_Bool(!1, overwrite), !_zip)
          throw Utils.Errors.NO_ZIP();
        let dirEntries = [];
        _zip.entries.forEach(function(entry) {
          var entryName = sanitize(targetPath, canonical(entry.entryName));
          if (entry.isDirectory) {
            if (filetools.makeDir(entryName), keepOriginalPermission)
              dirEntries.push({ path: entryName, attr: entry.header.fileAttr });
            return;
          }
          var content = entry.getData(pass);
          if (!content)
            throw Utils.Errors.CANT_EXTRACT_FILE();
          let fileAttr = keepOriginalPermission ? entry.header.fileAttr : void 0;
          filetools.writeFileTo(entryName, content, overwrite, fileAttr);
          try {
            filetools.fs.utimesSync(entryName, entry.header.time, entry.header.time);
          } catch (err) {}
        }), applyDirAttributes(dirEntries);
      },
      extractAllToAsync: function(targetPath, overwrite, keepOriginalPermission, callback) {
        if (callback = get_Fun(overwrite, keepOriginalPermission, callback), keepOriginalPermission = get_Bool(!1, keepOriginalPermission), overwrite = get_Bool(!1, overwrite), !callback)
          return new Promise((resolve, reject) => {
            this.extractAllToAsync(targetPath, overwrite, keepOriginalPermission, function(err) {
              if (err)
                reject(err);
              else
                resolve(this);
            });
          });
        if (!_zip) {
          callback(Utils.Errors.NO_ZIP());
          return;
        }
        targetPath = pth.resolve(targetPath);
        let getPath = (entry) => sanitize(targetPath, pth.normalize(canonical(entry.entryName))), getError = (msg, file) => Error(msg + ': "' + file + '"'), dirEntries = [], fileEntries = [];
        _zip.entries.forEach((e) => {
          if (e.isDirectory)
            dirEntries.push(e);
          else
            fileEntries.push(e);
        });
        let deferredDirAttr = [];
        for (let entry of dirEntries) {
          let dirPath = getPath(entry), dirAttr = keepOriginalPermission ? entry.header.fileAttr : void 0;
          try {
            filetools.makeDir(dirPath);
          } catch (er) {
            callback(getError("Unable to create folder", dirPath));
            continue;
          }
          if (dirAttr)
            deferredDirAttr.push({ path: dirPath, attr: dirAttr });
          try {
            filetools.fs.utimesSync(dirPath, entry.header.time, entry.header.time);
          } catch (er) {}
        }
        let done = (err) => {
          if (!err)
            try {
              applyDirAttributes(deferredDirAttr);
            } catch (er) {
              return callback(getError("Unable to set folder permissions", er.path || ""));
            }
          callback(err);
        };
        fileEntries.reverse().reduce(function(next, entry) {
          return function(err) {
            if (err)
              next(err);
            else {
              let entryName = pth.normalize(canonical(entry.entryName)), filePath = sanitize(targetPath, entryName);
              entry.getDataAsync(function(content, err_1) {
                if (err_1)
                  next(err_1);
                else if (!content)
                  next(Utils.Errors.CANT_EXTRACT_FILE());
                else {
                  let fileAttr = keepOriginalPermission ? entry.header.fileAttr : void 0;
                  filetools.writeFileToAsync(filePath, content, overwrite, fileAttr, function(succ) {
                    if (!succ)
                      return next(getError("Unable to write file", filePath));
                    filetools.fs.utimes(filePath, entry.header.time, entry.header.time, function() {
                      next();
                    });
                  });
                }
              });
            }
          };
        }, done)();
      },
      writeZip: function(targetFileName, callback) {
        if (arguments.length === 1) {
          if (typeof targetFileName === "function")
            callback = targetFileName, targetFileName = "";
        }
        if (!targetFileName && opts.filename)
          targetFileName = opts.filename;
        if (!targetFileName)
          return;
        var zipData = _zip.compressToBuffer();
        if (zipData) {
          var ok = filetools.writeFileTo(targetFileName, zipData, !0);
          if (typeof callback === "function")
            callback(!ok ? Error("failed") : null, "");
        }
      },
      writeZipPromise: function(targetFileName, props) {
        let { overwrite, perm } = Object.assign({ overwrite: !0 }, props);
        return new Promise((resolve, reject) => {
          if (!targetFileName && opts.filename)
            targetFileName = opts.filename;
          if (!targetFileName)
            reject("ADM-ZIP: ZIP File Name Missing");
          this.toBufferPromise().then((zipData) => {
            let ret = (done) => done ? resolve(done) : reject("ADM-ZIP: Wasn't able to write zip file");
            filetools.writeFileToAsync(targetFileName, zipData, overwrite, perm, ret);
          }, reject);
        });
      },
      toBufferPromise: function() {
        return new Promise((resolve, reject) => {
          _zip.toAsyncBuffer(resolve, reject);
        });
      },
      toBuffer: function(onSuccess, onFail, onItemStart, onItemEnd) {
        if (typeof onSuccess === "function")
          return _zip.toAsyncBuffer(onSuccess, onFail, onItemStart, onItemEnd), null;
        return _zip.compressToBuffer();
      }
    };
  };
});

// app/projects/gold/lanes/mutation/kit/entry.ts
import { existsSync as existsSync5 } from "node:fs";
import { dirname as dirname4, join as join6 } from "node:path";
import { fileURLToPath } from "node:url";

// app/projects/gold/lanes/mutation/kit/cli.ts
import { existsSync as existsSync4, mkdirSync as mkdirSync4, readFileSync as readFileSync6, writeFileSync as writeFileSync4 } from "node:fs";
import { basename as basename3, dirname as dirname3, join as join5, resolve as resolve2 } from "node:path";

// app/projects/gold/lanes/mutation/kit/commands.ts
var MUTKIT_COMMANDS = [
  {
    name: "scaffold",
    usage: "mutkit scaffold tasks/<name> --lane prometheus|titan --lang <language> [--program rust|go|c|cpp|python|node|java --program-name <bin>]",
    summary: "Start a task folder: the instruction, task.toml, the agent image, the reference tests, the verifier files and a scoring.toml whose run_tests writes JUnit for your language (python, go, rust, java-maven, java-gradle, typescript-jest, typescript-vitest, cpp)."
  },
  {
    name: "check",
    usage: "mutkit check tasks/<name> [--repo <working copy> [--ref <commit>]] [--static] [--no-leakage] [--native]",
    summary: "Static checks, then the task end to end in Docker with the network off: reference and empty through the scorer, the kill matrix, what the repository already kills and the clean-removal check (Prometheus), timings against the lane's verifier limit, the task.toml fields the submit reads, and the leakage scan."
  },
  {
    name: "baseline",
    usage: "mutkit baseline tasks/<name> --repo <working copy> [--ref <commit>] [--native]",
    summary: "Prometheus: record the repository's own test files and test ids inside the agent's image into tests/mutation/baseline.json, so they never earn credit."
  },
  {
    name: "leakage",
    usage: "mutkit leakage tasks/<name> [--repo <working copy> [--ref <commit>]] [--native]",
    summary: "Scan the agent's image for a .git history, the program's source or binaries, mutants, hidden folders and reference test names."
  },
  {
    name: "pack",
    usage: "mutkit pack tasks/<name> [--out <file.zip>]",
    summary: "Run the static checks and zip the task folder with a manifest for the task page. Run check first: its summary goes in the zip."
  },
  {
    name: "rules",
    usage: "mutkit rules",
    summary: "The numbers every check uses. Ranges, not targets."
  }
];

// app/projects/gold/lanes/mutation/kit/rules.ts
var DEFAULT_RULES = {
  kit: "dev",
  format: 1,
  timeoutWarnFraction: 0.6,
  maxMutants: 1000,
  runtimePython: "cpython-3.12.15-linux-x86_64-gnu",
  lanes: {
    prometheus: {
      verifierTimeoutSec: 5400,
      cpus: 8,
      memoryMb: 16384,
      minMutants: 20,
      warnBelowMutants: 0
    },
    titan: {
      verifierTimeoutSec: 3600,
      cpus: 4,
      memoryMb: 8192,
      minMutants: 50,
      warnBelowMutants: 60
    }
  }
}, ONE_CPU_TIMEOUT_MULTIPLE = 2;
function laneRules(rules, lane) {
  return rules.lanes[lane];
}

// app/projects/gold/lanes/mutation/kit/static-checks.ts
import { readFileSync as readFileSync2 } from "node:fs";

// ../../../orca/workspaces/AfterQueryFront/gold-fix-runner-buildx/node_modules/smol-toml/dist/error.js
/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
function getLineColFromPtr(string, ptr) {
  let lines = string.slice(0, ptr).split(/\r\n|\n|\r/g);
  return [lines.length, lines.pop().length + 1];
}
function makeCodeBlock(string, line, column) {
  let lines = string.split(/\r\n|\n|\r/g), codeblock = "", numberLen = (Math.log10(line + 1) | 0) + 1;
  for (let i = line - 1;i <= line + 1; i++) {
    let l = lines[i - 1];
    if (!l)
      continue;
    if (codeblock += i.toString().padEnd(numberLen, " "), codeblock += ":  ", codeblock += l, codeblock += `
`, i === line)
      codeblock += " ".repeat(numberLen + column + 2), codeblock += `^
`;
  }
  return codeblock;
}

class TomlError extends Error {
  line;
  column;
  codeblock;
  constructor(message, options) {
    let [line, column] = getLineColFromPtr(options.toml, options.ptr), codeblock = makeCodeBlock(options.toml, line, column);
    super(`Invalid TOML document: ${message}

${codeblock}`, options);
    this.line = line, this.column = column, this.codeblock = codeblock;
  }
}

// ../../../orca/workspaces/AfterQueryFront/gold-fix-runner-buildx/node_modules/smol-toml/dist/util.js
/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
function isEscaped(str, ptr) {
  let i = 0;
  while (str[ptr - ++i] === "\\")
    ;
  return --i && i % 2;
}
function indexOfNewline(str, start = 0, end = str.length) {
  let idx = str.indexOf(`
`, start);
  if (str[idx - 1] === "\r")
    idx--;
  return idx <= end ? idx : -1;
}
function skipComment(str, ptr) {
  for (let i = ptr;i < str.length; i++) {
    let c = str[i];
    if (c === `
`)
      return i;
    if (c === "\r" && str[i + 1] === `
`)
      return i + 1;
    if (c < " " && c !== "\t" || c === "")
      throw new TomlError("control characters are not allowed in comments", {
        toml: str,
        ptr
      });
  }
  return str.length;
}
function skipVoid(str, ptr, banNewLines, banComments) {
  let c;
  while (!0) {
    while ((c = str[ptr]) === " " || c === "\t" || !banNewLines && (c === `
` || c === "\r" && str[ptr + 1] === `
`))
      ptr++;
    if (banComments || c !== "#")
      break;
    ptr = skipComment(str, ptr);
  }
  return ptr;
}
function skipUntil(str, ptr, sep, end, banNewLines = !1) {
  if (!end)
    return ptr = indexOfNewline(str, ptr), ptr < 0 ? str.length : ptr;
  for (let i = ptr;i < str.length; i++) {
    let c = str[i];
    if (c === "#")
      i = indexOfNewline(str, i);
    else if (c === sep)
      return i + 1;
    else if (c === end || banNewLines && (c === `
` || c === "\r" && str[i + 1] === `
`))
      return i;
  }
  throw new TomlError("cannot find end of structure", {
    toml: str,
    ptr
  });
}
function getStringEnd(str, seek) {
  let first = str[seek], target = first === str[seek + 1] && str[seek + 1] === str[seek + 2] ? str.slice(seek, seek + 3) : first;
  seek += target.length - 1;
  do
    seek = str.indexOf(target, ++seek);
  while (seek > -1 && first !== "'" && isEscaped(str, seek));
  if (seek > -1) {
    if (seek += target.length, target.length > 1) {
      if (str[seek] === first)
        seek++;
      if (str[seek] === first)
        seek++;
    }
  }
  return seek;
}

// ../../../orca/workspaces/AfterQueryFront/gold-fix-runner-buildx/node_modules/smol-toml/dist/date.js
/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
var DATE_TIME_RE = /^(\d{4}-\d{2}-\d{2})?[T ]?(?:(\d{2}):\d{2}(?::\d{2}(?:\.\d+)?)?)?(Z|[-+]\d{2}:\d{2})?$/i;

class TomlDate extends Date {
  #hasDate = !1;
  #hasTime = !1;
  #offset = null;
  constructor(date) {
    let hasDate = !0, hasTime = !0, offset = "Z";
    if (typeof date === "string") {
      let match = date.match(DATE_TIME_RE);
      if (match) {
        if (!match[1])
          hasDate = !1, date = `0000-01-01T${date}`;
        if (hasTime = !!match[2], hasTime && date[10] === " " && (date = date.replace(" ", "T")), match[2] && +match[2] > 23)
          date = "";
        else if (offset = match[3] || null, date = date.toUpperCase(), !offset && hasTime)
          date += "Z";
      } else
        date = "";
    }
    super(date);
    if (!isNaN(this.getTime()))
      this.#hasDate = hasDate, this.#hasTime = hasTime, this.#offset = offset;
  }
  isDateTime() {
    return this.#hasDate && this.#hasTime;
  }
  isLocal() {
    return !this.#hasDate || !this.#hasTime || !this.#offset;
  }
  isDate() {
    return this.#hasDate && !this.#hasTime;
  }
  isTime() {
    return this.#hasTime && !this.#hasDate;
  }
  isValid() {
    return this.#hasDate || this.#hasTime;
  }
  toISOString() {
    let iso = super.toISOString();
    if (this.isDate())
      return iso.slice(0, 10);
    if (this.isTime())
      return iso.slice(11, 23);
    if (this.#offset === null)
      return iso.slice(0, -1);
    if (this.#offset === "Z")
      return iso;
    let offset = +this.#offset.slice(1, 3) * 60 + +this.#offset.slice(4, 6);
    return offset = this.#offset[0] === "-" ? offset : -offset, new Date(this.getTime() - offset * 60000).toISOString().slice(0, -1) + this.#offset;
  }
  static wrapAsOffsetDateTime(jsDate, offset = "Z") {
    let date = new TomlDate(jsDate);
    return date.#offset = offset, date;
  }
  static wrapAsLocalDateTime(jsDate) {
    let date = new TomlDate(jsDate);
    return date.#offset = null, date;
  }
  static wrapAsLocalDate(jsDate) {
    let date = new TomlDate(jsDate);
    return date.#hasTime = !1, date.#offset = null, date;
  }
  static wrapAsLocalTime(jsDate) {
    let date = new TomlDate(jsDate);
    return date.#hasDate = !1, date.#offset = null, date;
  }
}

// ../../../orca/workspaces/AfterQueryFront/gold-fix-runner-buildx/node_modules/smol-toml/dist/primitive.js
/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
var INT_REGEX = /^((0x[0-9a-fA-F](_?[0-9a-fA-F])*)|(([+-]|0[ob])?\d(_?\d)*))$/, FLOAT_REGEX = /^[+-]?\d(_?\d)*(\.\d(_?\d)*)?([eE][+-]?\d(_?\d)*)?$/, LEADING_ZERO = /^[+-]?0[0-9_]/, ESCAPE_REGEX = /^[0-9a-f]{2,8}$/i, ESC_MAP = {
  b: "\b",
  t: "\t",
  n: `
`,
  f: "\f",
  r: "\r",
  e: "\x1B",
  '"': '"',
  "\\": "\\"
};
function parseString(str, ptr = 0, endPtr = str.length) {
  let isLiteral = str[ptr] === "'", isMultiline = str[ptr++] === str[ptr] && str[ptr] === str[ptr + 1];
  if (isMultiline) {
    if (endPtr -= 2, str[ptr += 2] === "\r")
      ptr++;
    if (str[ptr] === `
`)
      ptr++;
  }
  let tmp = 0, isEscape, parsed = "", sliceStart = ptr;
  while (ptr < endPtr - 1) {
    let c = str[ptr++];
    if (c === `
` || c === "\r" && str[ptr] === `
`) {
      if (!isMultiline)
        throw new TomlError("newlines are not allowed in strings", {
          toml: str,
          ptr: ptr - 1
        });
    } else if (c < " " && c !== "\t" || c === "")
      throw new TomlError("control characters are not allowed in strings", {
        toml: str,
        ptr: ptr - 1
      });
    if (isEscape) {
      if (isEscape = !1, c === "x" || c === "u" || c === "U") {
        let code = str.slice(ptr, ptr += c === "x" ? 2 : c === "u" ? 4 : 8);
        if (!ESCAPE_REGEX.test(code))
          throw new TomlError("invalid unicode escape", {
            toml: str,
            ptr: tmp
          });
        try {
          parsed += String.fromCodePoint(parseInt(code, 16));
        } catch {
          throw new TomlError("invalid unicode escape", {
            toml: str,
            ptr: tmp
          });
        }
      } else if (isMultiline && (c === `
` || c === " " || c === "\t" || c === "\r")) {
        if (ptr = skipVoid(str, ptr - 1, !0), str[ptr] !== `
` && str[ptr] !== "\r")
          throw new TomlError("invalid escape: only line-ending whitespace may be escaped", {
            toml: str,
            ptr: tmp
          });
        ptr = skipVoid(str, ptr);
      } else if (c in ESC_MAP)
        parsed += ESC_MAP[c];
      else
        throw new TomlError("unrecognized escape sequence", {
          toml: str,
          ptr: tmp
        });
      sliceStart = ptr;
    } else if (!isLiteral && c === "\\")
      tmp = ptr - 1, isEscape = !0, parsed += str.slice(sliceStart, tmp);
  }
  return parsed + str.slice(sliceStart, endPtr - 1);
}
function parseValue(value, toml, ptr, integersAsBigInt) {
  if (value === "true")
    return !0;
  if (value === "false")
    return !1;
  if (value === "-inf")
    return -1 / 0;
  if (value === "inf" || value === "+inf")
    return 1 / 0;
  if (value === "nan" || value === "+nan" || value === "-nan")
    return NaN;
  if (value === "-0")
    return integersAsBigInt ? 0n : 0;
  let isInt = INT_REGEX.test(value);
  if (isInt || FLOAT_REGEX.test(value)) {
    if (LEADING_ZERO.test(value))
      throw new TomlError("leading zeroes are not allowed", {
        toml,
        ptr
      });
    value = value.replace(/_/g, "");
    let numeric = +value;
    if (isNaN(numeric))
      throw new TomlError("invalid number", {
        toml,
        ptr
      });
    if (isInt) {
      if ((isInt = !Number.isSafeInteger(numeric)) && !integersAsBigInt)
        throw new TomlError("integer value cannot be represented losslessly", {
          toml,
          ptr
        });
      if (isInt || integersAsBigInt === !0)
        numeric = BigInt(value);
    }
    return numeric;
  }
  let date = new TomlDate(value);
  if (!date.isValid())
    throw new TomlError("invalid value", {
      toml,
      ptr
    });
  return date;
}

// ../../../orca/workspaces/AfterQueryFront/gold-fix-runner-buildx/node_modules/smol-toml/dist/extract.js
/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
function sliceAndTrimEndOf(str, startPtr, endPtr) {
  let value = str.slice(startPtr, endPtr), commentIdx = value.indexOf("#");
  if (commentIdx > -1)
    skipComment(str, commentIdx), value = value.slice(0, commentIdx);
  return [value.trimEnd(), commentIdx];
}
function extractValue(str, ptr, end, depth, integersAsBigInt) {
  if (depth === 0)
    throw new TomlError("document contains excessively nested structures. aborting.", {
      toml: str,
      ptr
    });
  let c = str[ptr];
  if (c === "[" || c === "{") {
    let [value, endPtr] = c === "[" ? parseArray(str, ptr, depth, integersAsBigInt) : parseInlineTable(str, ptr, depth, integersAsBigInt);
    if (end) {
      if (endPtr = skipVoid(str, endPtr), str[endPtr] === ",")
        endPtr++;
      else if (str[endPtr] !== end)
        throw new TomlError("expected comma or end of structure", {
          toml: str,
          ptr: endPtr
        });
    }
    return [value, endPtr];
  }
  let endPtr;
  if (c === '"' || c === "'") {
    endPtr = getStringEnd(str, ptr);
    let parsed = parseString(str, ptr, endPtr);
    if (end) {
      if (endPtr = skipVoid(str, endPtr), str[endPtr] && str[endPtr] !== "," && str[endPtr] !== end && str[endPtr] !== `
` && str[endPtr] !== "\r")
        throw new TomlError("unexpected character encountered", {
          toml: str,
          ptr: endPtr
        });
      endPtr += +(str[endPtr] === ",");
    }
    return [parsed, endPtr];
  }
  endPtr = skipUntil(str, ptr, ",", end);
  let slice = sliceAndTrimEndOf(str, ptr, endPtr - +(str[endPtr - 1] === ","));
  if (!slice[0])
    throw new TomlError("incomplete key-value declaration: no value specified", {
      toml: str,
      ptr
    });
  if (end && slice[1] > -1)
    endPtr = skipVoid(str, ptr + slice[1]), endPtr += +(str[endPtr] === ",");
  return [
    parseValue(slice[0], str, ptr, integersAsBigInt),
    endPtr
  ];
}

// ../../../orca/workspaces/AfterQueryFront/gold-fix-runner-buildx/node_modules/smol-toml/dist/struct.js
/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
var KEY_PART_RE = /^[a-zA-Z0-9-_]+[ \t]*$/;
function parseKey(str, ptr, end = "=") {
  let dot = ptr - 1, parsed = [], endPtr = str.indexOf(end, ptr);
  if (endPtr < 0)
    throw new TomlError("incomplete key-value: cannot find end of key", {
      toml: str,
      ptr
    });
  do {
    let c = str[ptr = ++dot];
    if (c !== " " && c !== "\t")
      if (c === '"' || c === "'") {
        if (c === str[ptr + 1] && c === str[ptr + 2])
          throw new TomlError("multiline strings are not allowed in keys", {
            toml: str,
            ptr
          });
        let eos = getStringEnd(str, ptr);
        if (eos < 0)
          throw new TomlError("unfinished string encountered", {
            toml: str,
            ptr
          });
        dot = str.indexOf(".", eos);
        let strEnd = str.slice(eos, dot < 0 || dot > endPtr ? endPtr : dot), newLine = indexOfNewline(strEnd);
        if (newLine > -1)
          throw new TomlError("newlines are not allowed in keys", {
            toml: str,
            ptr: ptr + dot + newLine
          });
        if (strEnd.trimStart())
          throw new TomlError("found extra tokens after the string part", {
            toml: str,
            ptr: eos
          });
        if (endPtr < eos) {
          if (endPtr = str.indexOf(end, eos), endPtr < 0)
            throw new TomlError("incomplete key-value: cannot find end of key", {
              toml: str,
              ptr
            });
        }
        parsed.push(parseString(str, ptr, eos));
      } else {
        dot = str.indexOf(".", ptr);
        let part = str.slice(ptr, dot < 0 || dot > endPtr ? endPtr : dot);
        if (!KEY_PART_RE.test(part))
          throw new TomlError("only letter, numbers, dashes and underscores are allowed in keys", {
            toml: str,
            ptr
          });
        parsed.push(part.trimEnd());
      }
  } while (dot + 1 && dot < endPtr);
  return [parsed, skipVoid(str, endPtr + 1, !0, !0)];
}
function parseInlineTable(str, ptr, depth, integersAsBigInt) {
  let res = {}, seen = /* @__PURE__ */ new Set, c;
  ptr++;
  while ((c = str[ptr++]) !== "}" && c)
    if (c === ",")
      throw new TomlError("expected value, found comma", {
        toml: str,
        ptr: ptr - 1
      });
    else if (c === "#")
      ptr = skipComment(str, ptr);
    else if (c !== " " && c !== "\t" && c !== `
` && c !== "\r") {
      let k, t = res, hasOwn = !1, [key, keyEndPtr] = parseKey(str, ptr - 1);
      for (let i = 0;i < key.length; i++) {
        if (i)
          t = hasOwn ? t[k] : t[k] = {};
        if (k = key[i], (hasOwn = Object.hasOwn(t, k)) && (typeof t[k] !== "object" || seen.has(t[k])))
          throw new TomlError("trying to redefine an already defined value", {
            toml: str,
            ptr
          });
        if (!hasOwn && k === "__proto__")
          Object.defineProperty(t, k, { enumerable: !0, configurable: !0, writable: !0 });
      }
      if (hasOwn)
        throw new TomlError("trying to redefine an already defined value", {
          toml: str,
          ptr
        });
      let [value, valueEndPtr] = extractValue(str, keyEndPtr, "}", depth - 1, integersAsBigInt);
      seen.add(value), t[k] = value, ptr = valueEndPtr;
    }
  if (!c)
    throw new TomlError("unfinished table encountered", {
      toml: str,
      ptr
    });
  return [res, ptr];
}
function parseArray(str, ptr, depth, integersAsBigInt) {
  let res = [], c;
  ptr++;
  while ((c = str[ptr++]) !== "]" && c)
    if (c === ",")
      throw new TomlError("expected value, found comma", {
        toml: str,
        ptr: ptr - 1
      });
    else if (c === "#")
      ptr = skipComment(str, ptr);
    else if (c !== " " && c !== "\t" && c !== `
` && c !== "\r") {
      let e = extractValue(str, ptr - 1, "]", depth - 1, integersAsBigInt);
      res.push(e[0]), ptr = e[1];
    }
  if (!c)
    throw new TomlError("unfinished array encountered", {
      toml: str,
      ptr
    });
  return [res, ptr];
}

// ../../../orca/workspaces/AfterQueryFront/gold-fix-runner-buildx/node_modules/smol-toml/dist/parse.js
/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
function peekTable(key, table, meta, type) {
  let t = table, m = meta, k, hasOwn = !1, state;
  for (let i = 0;i < key.length; i++) {
    if (i) {
      if (t = hasOwn ? t[k] : t[k] = {}, m = (state = m[k]).c, type === 0 && (state.t === 1 || state.t === 2))
        return null;
      if (state.t === 2) {
        let l = t.length - 1;
        t = t[l], m = m[l].c;
      }
    }
    if (k = key[i], (hasOwn = Object.hasOwn(t, k)) && m[k]?.t === 0 && m[k]?.d)
      return null;
    if (!hasOwn) {
      if (k === "__proto__")
        Object.defineProperty(t, k, { enumerable: !0, configurable: !0, writable: !0 }), Object.defineProperty(m, k, { enumerable: !0, configurable: !0, writable: !0 });
      m[k] = {
        t: i < key.length - 1 && type === 2 ? 3 : type,
        d: !1,
        i: 0,
        c: {}
      };
    }
  }
  if (state = m[k], state.t !== type && !(type === 1 && state.t === 3))
    return null;
  if (type === 2) {
    if (!state.d)
      state.d = !0, t[k] = [];
    t[k].push(t = {}), state.c[state.i++] = state = { t: 1, d: !1, i: 0, c: {} };
  }
  if (state.d)
    return null;
  if (state.d = !0, type === 1)
    t = hasOwn ? t[k] : t[k] = {};
  else if (type === 0 && hasOwn)
    return null;
  return [k, t, state.c];
}
function parse(toml, { maxDepth = 1000, integersAsBigInt } = {}) {
  let res = {}, meta = {}, tbl = res, m = meta;
  for (let ptr = skipVoid(toml, 0);ptr < toml.length; ) {
    if (toml[ptr] === "[") {
      let isTableArray = toml[++ptr] === "[", k = parseKey(toml, ptr += +isTableArray, "]");
      if (isTableArray) {
        if (toml[k[1] - 1] !== "]")
          throw new TomlError("expected end of table declaration", {
            toml,
            ptr: k[1] - 1
          });
        k[1]++;
      }
      let p = peekTable(k[0], res, meta, isTableArray ? 2 : 1);
      if (!p)
        throw new TomlError("trying to redefine an already defined table or value", {
          toml,
          ptr
        });
      m = p[2], tbl = p[1], ptr = k[1];
    } else {
      let k = parseKey(toml, ptr), p = peekTable(k[0], tbl, m, 0);
      if (!p)
        throw new TomlError("trying to redefine an already defined table or value", {
          toml,
          ptr
        });
      let v = extractValue(toml, k[1], void 0, maxDepth, integersAsBigInt);
      p[1][p[0]] = v[0], ptr = v[1];
    }
    if (ptr = skipVoid(toml, ptr, !0), toml[ptr] && toml[ptr] !== `
` && toml[ptr] !== "\r")
      throw new TomlError("each key-value declaration must be followed by an end-of-line", {
        toml,
        ptr
      });
    ptr = skipVoid(toml, ptr);
  }
  return res;
}

// ../../../orca/workspaces/AfterQueryFront/gold-fix-runner-buildx/node_modules/smol-toml/dist/stringify.js
/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

// ../../../orca/workspaces/AfterQueryFront/gold-fix-runner-buildx/node_modules/smol-toml/dist/index.js
/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

// app/projects/gold/lanes/titan/checks/requirements.ts
var ID_BODY = String.raw`(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))+`, REQUIREMENT_ID_RE = new RegExp(`^REQ-${ID_BODY}$`), MUTANT_ID_TRACE_RE = new RegExp(`^(REQ-${ID_BODY})-([1-9]\\d*)$`), DECLARATION_RE = new RegExp(String.raw`^\s*(?:>\s*)*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)?(?:\*\*|__|\*|_|\x60|\[)?(REQ-${ID_BODY})(?!\.?\d)`), FENCE_RE = /^([ \t]*)(`{3,}|~{3,})(.*)$/;
function columns(indent) {
  let n = 0;
  for (let c of indent)
    n = c === "\t" ? n + 4 - n % 4 : n + 1;
  return n;
}
function sectionOf(id) {
  return id.slice(4).split(".")[0];
}
function parseSpecRequirements(instruction) {
  let requirements = [], seen = /* @__PURE__ */ new Set, duplicates = /* @__PURE__ */ new Set, sections = [], fence = null;
  return instruction.split(/\r?\n/).forEach((text, i) => {
    let f = FENCE_RE.exec(text);
    if (fence === null) {
      if (f) {
        fence = { run: f[2], indent: columns(f[1]) };
        return;
      }
    } else {
      if (f !== null && f[2][0] === fence.run[0] && f[2].length >= fence.run.length && f[3].trim() === "" && columns(f[1]) <= fence.indent + 3)
        fence = null;
      return;
    }
    let m = DECLARATION_RE.exec(text);
    if (!m)
      return;
    let id = m[1];
    if (seen.has(id)) {
      duplicates.add(id);
      return;
    }
    seen.add(id);
    let section = sectionOf(id);
    if (!sections.includes(section))
      sections.push(section);
    requirements.push({ id, section, line: i + 1 });
  }), { requirements, sections, duplicates: [...duplicates].sort() };
}

// app/projects/gold/lanes/titan/checks/spec-bar.ts
var HEADING_RE = /^\s{0,3}#{1,6}\s/, FENCE_RE2 = /^\s*(`{3,}|~{3,})/, LIST_ITEM_RE = /^(\s*)(?:[-*+]|\d+[.)])\s+/, TABLE_ROW_RE = /^\s*\|/, EXIT_STATUS_READ_RE = /\breturncode\b|\bexit_?code\b|\bExitCode\(\)|\bexitCode\b|\.status\b|\.success\(\)|\.code\(\)|\bexit_?status\b|\.Run\(\)|\bcheck\s*=\s*True\b|\bcheck_(?:call|output)\b/, EXIT_WORD_RE = /\bexit/i, ZERO = String.raw`(?:(?<![\w.-])\x60?0\x60?(?![\w]|\.\d)|(?<!\bnon-?|\bnot\s+)\bzero\b)`, EXIT_ZERO_RE = new RegExp(String.raw`\bexit\w*\b((?:(?!\bexit)[^.;,\n\d]){0,40}?)${ZERO}`, "gi"), CONDITION = String.raw`\b(?:if|when|unless|where|while)\b`, INPUT_CONDITION_RE = new RegExp(String.raw`^(?:(?!\b(?:status|code)\b).)*${CONDITION}|\b(?:errors?|fail\w*)\b.*${CONDITION}`, "i"), NAMED_STATUS_RE = /\b(?:status|code)(?:\s+(?:of|is|=))?\s*$/i, exitNamesZero = (sentence) => [...sentence.matchAll(EXIT_ZERO_RE)].some((m) => NAMED_STATUS_RE.test(m[1]) || !INPUT_CONDITION_RE.test(m[1])), ZERO_SUCCESS_RE = new RegExp(String.raw`${ZERO}.*\bsucce|\bsucce.*${ZERO}`, "i"), ZERO_CELL_RE = new RegExp(String.raw`^${ZERO}$`, "i"), STATUS_HEADER_RE = /\b(?:exit|status|code)/i, TABLE_RULE_RE = /^\s*\|?[\s:|-]+\|?\s*$/;
function cells(row) {
  return row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}
function zeroInStatusColumn(block) {
  let columns = null;
  for (let line of block.split(`
`))
    if (!TABLE_ROW_RE.test(line))
      columns = null;
    else if (columns === null)
      columns = cells(line).flatMap((c, i) => STATUS_HEADER_RE.test(c) ? [i] : []);
    else if (!TABLE_RULE_RE.test(line)) {
      let row = cells(line);
      if (columns.some((i) => ZERO_CELL_RE.test(row[i] ?? "")))
        return !0;
    }
  return !1;
}
var NORMATIVE_RE = /\b(?:must|shall|always|never|(?:is|are) (?:ignored|rejected|required|treated as|read as)|is an error)\b/i, ABOUT_TESTS_RE = /\$?\bBIN\b|\b(?:the|your) tests?\b/i, MAX_LISTED = 5;
function uncommented(instruction) {
  return instruction.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ""));
}
var declaredRequirements = (instruction) => parseSpecRequirements(uncommented(instruction)).requirements;
function proseLines(instruction) {
  let fence = null;
  return uncommented(instruction).split(/\r?\n/).map((text) => {
    let f = FENCE_RE2.exec(text);
    if (fence !== null) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length)
        fence = null;
      return { text, fenced: !0 };
    }
    if (f)
      return fence = f[1], { text, fenced: !0 };
    return { text, fenced: !1 };
  });
}
function requirementBlocks(instruction) {
  let lines = proseLines(instruction), starts = declaredRequirements(instruction).map((r) => r.line - 1), startSet = new Set(starts);
  return starts.map((start) => {
    let out = [lines[start].text];
    for (let i = start + 1;i < lines.length; i++) {
      if (startSet.has(i) || !lines[i].fenced && HEADING_RE.test(lines[i].text))
        break;
      out.push(lines[i].text);
    }
    return out.join(`
`);
  });
}
function softUnits(block) {
  let units = [], joinable = !1;
  for (let line of block.split(`
`))
    if (line.trim() === "")
      joinable = !1;
    else if (joinable && !LIST_ITEM_RE.test(line) && !TABLE_ROW_RE.test(line))
      units[units.length - 1] += ` ${line.trim()}`;
    else
      units.push(line), joinable = !TABLE_ROW_RE.test(line) && !HEADING_RE.test(line);
  return units;
}
var statesInWords = (text) => text.split(/(?<=[.!?])\s+/).some((x) => exitNamesZero(x) || ZERO_SUCCESS_RE.test(x));
function statesSuccessExitStatus(instruction) {
  return requirementBlocks(instruction).some((b) => EXIT_WORD_RE.test(b) && (zeroInStatusColumn(b) || softUnits(b).some((u) => TABLE_ROW_RE.test(u) ? cells(u).some(statesInWords) : statesInWords(u))));
}
function checkSuccessExitStatus(instruction, goldTestFiles) {
  let declared = declaredRequirements(instruction).length > 0, readsStatus = Object.values(goldTestFiles).some((t) => EXIT_STATUS_READ_RE.test(t));
  if (!declared || !readsStatus || statesSuccessExitStatus(instruction))
    return { errors: [], warnings: [] };
  return {
    errors: [],
    warnings: [
      "The reference tests check exit statuses, but no requirement in instruction.md states the exit status of a successful run. Give it an id (for example in the exit status requirement), so a test may assert it."
    ]
  };
}
function unnumberedRuleLines(instruction) {
  let lines = proseLines(instruction), declared = new Set(declaredRequirements(instruction).map((r) => r.line - 1)), out = [], owner = null, prevBlank = !0, open = null, close = () => {
    let sentences = open?.text.split(/(?<=[.!?])\s+/) ?? [];
    if (open && sentences.some((x) => NORMATIVE_RE.test(x) && !ABOUT_TESTS_RE.test(x)))
      out.push(open.line);
    open = null;
  };
  return lines.forEach(({ text, fenced }, i) => {
    let blank = text.trim() === "";
    if (fenced || blank || TABLE_ROW_RE.test(text)) {
      close(), prevBlank = blank;
      return;
    }
    let item = LIST_ITEM_RE.exec(text), indent = item ? item[1].length : text.length - text.trimStart().length;
    if (declared.has(i))
      close(), owner = item ? { indent } : HEADING_RE.test(text) ? "heading" : "paragraph";
    else if (HEADING_RE.test(text)) {
      close(), owner = null, prevBlank = !0;
      return;
    } else {
      if (!(owner === "heading" ? !0 : owner === "paragraph" ? item !== null || indent > 0 || !prevBlank : owner !== null && (item ? indent > owner.indent : indent > 0 || !prevBlank)))
        owner = null;
      if (item !== null || prevBlank) {
        if (close(), owner === null)
          open = { line: i + 1, text };
      } else if (open)
        open.text += ` ${text.trim()}`;
    }
    prevBlank = !1;
  }), close(), out;
}
function checkUnnumberedRules(instruction) {
  if (declaredRequirements(instruction).length === 0)
    return { errors: [], warnings: [] };
  let found = unnumberedRuleLines(instruction);
  if (found.length === 0)
    return { errors: [], warnings: [] };
  let shown = found.slice(0, MAX_LISTED).join(", "), more = found.length > MAX_LISTED ? ` and ${found.length - MAX_LISTED} more` : "";
  return {
    errors: [],
    warnings: [
      `instruction.md has rules with no requirement id (${found.length === 1 ? "line" : "lines"} ${shown}${more}). A general rule (encoding, line endings, the final newline, empty input, one that applies to every mode) is a requirement too: give each its own REQ id.`
    ]
  };
}

// app/projects/gold/lib/verifier/placeholder.ts
var PLACEHOLDER_MARKER = "<<EDIT-ME>>";

// app/projects/gold/db/types/submission-db-type.ts
var MAINTAINER_TASK_TYPES = [
  "feature",
  "bug_fix",
  "security",
  "performance",
  "refactor",
  "build_toolchain"
];
var TEST_LEVEL_TASK_TYPES = [
  "unit",
  "integration",
  "acceptance"
], PROGRAM_TASK_TYPES = [
  "text_processing",
  "format_conversion",
  "interpreter",
  "parser_formatter",
  "encoding_binary",
  "file_utility"
], QUESTION_TASK_TYPES = [
  "localization",
  "static_mechanism",
  "runtime_mechanism",
  "intent_history",
  "change_impact",
  "symptom_explanation",
  "usage_operation"
], GOLD_LANE_TASK_TYPES = [
  ...MAINTAINER_TASK_TYPES,
  ...TEST_LEVEL_TASK_TYPES,
  ...PROGRAM_TASK_TYPES,
  ...QUESTION_TASK_TYPES
];
var GOLD_REJECTION_REASONS = [
  "reward-hackable",
  "too-easy",
  "too-hard",
  "verifier-defect",
  "instruction-low-quality",
  "insufficient-scope",
  "environment-broken",
  "tests-not-behavioral",
  "solution-not-original",
  "other"
], JUDGMENT_REJECTION_REASONS = [
  "reward-hackable",
  "too-easy",
  "too-hard",
  "rubric-unverifiable",
  "trap-leaked",
  "golden-incomplete",
  "marks-unstable",
  "criteria-overfit",
  "criteria-unrelated",
  "honesty-criteria-missing",
  "instruction-low-quality",
  "environment-broken",
  "solution-not-original",
  "other"
], MAINTAINER_REJECTION_REASONS = [
  "unrealistic-change",
  "prompt-unfair",
  "reward-hackable",
  "criteria-overfit",
  "blocker-not-hard-stop",
  "blocker-not-inferable",
  "scope-brittle",
  "too-easy",
  "environment-broken",
  "hidden-asset-leak",
  "solution-not-original",
  "other"
], ALL_GOLD_REJECTION_REASONS = [
  .../* @__PURE__ */ new Set([
    ...GOLD_REJECTION_REASONS,
    ...JUDGMENT_REJECTION_REASONS,
    ...MAINTAINER_REJECTION_REASONS
  ])
];

// app/projects/gold/lanes/mutation/bundle/task-metadata.ts
var MUTATION_DIFFICULTIES = ["easy", "medium", "hard"], MUTATION_TEST_LEVELS = ["unit", "integration", "acceptance"], EMPTY = {
  difficulty: null,
  testLevel: null,
  functionalities: [],
  mutantCount: null,
  module: null,
  program: null,
  programVersion: null,
  programType: null
};
function isRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function text(v) {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function readMutationTaskMetadata(toml, kind) {
  if (toml === void 0)
    return { metadata: { ...EMPTY }, problems: [] };
  let raw;
  try {
    raw = parse(toml);
  } catch {
    return { metadata: { ...EMPTY }, problems: [] };
  }
  let meta = isRecord(raw) && isRecord(raw.metadata) ? raw.metadata : {}, problems = [], out = { ...EMPTY, functionalities: [] }, difficulty = text(meta.difficulty);
  if (difficulty && MUTATION_DIFFICULTIES.includes(difficulty))
    out.difficulty = difficulty;
  else
    problems.push(`[metadata] difficulty must be one of ${MUTATION_DIFFICULTIES.join(", ")}.`);
  let level = text(meta.test_level);
  if (level && MUTATION_TEST_LEVELS.includes(level))
    out.testLevel = level;
  else
    problems.push(`[metadata] test_level must be one of ${MUTATION_TEST_LEVELS.join(", ")}.`);
  let functionalities = Array.isArray(meta.functionalities) ? meta.functionalities : null;
  if (!functionalities || functionalities.length === 0 || !functionalities.every((f) => text(f)))
    problems.push("[metadata] functionalities must list the behaviours the tests cover, one short phrase each.");
  else
    out.functionalities = functionalities.map((f) => f.trim());
  let count = meta.mutant_count;
  if (typeof count === "number" && Number.isInteger(count) && count >= 0)
    out.mutantCount = count;
  else
    problems.push("[metadata] mutant_count must be the number of mutants under tests/mutants/.");
  if (kind === "repo") {
    if (out.module = text(meta.module), !out.module)
      problems.push("[metadata] module must name the module whose tests were removed.");
  } else {
    if (out.program = text(meta.program), !out.program)
      problems.push("[metadata] program must name the program under test.");
    if (out.programVersion = text(meta.program_version), !out.programVersion)
      problems.push("[metadata] program_version must name the version the specification describes.");
    let programType = text(meta.program_type);
    if (programType && PROGRAM_TASK_TYPES.includes(programType))
      out.programType = programType;
    else
      problems.push(`[metadata] program_type must be one of ${PROGRAM_TASK_TYPES.join(", ")}.`);
  }
  return { metadata: out, problems };
}

// app/projects/gold/lanes/mutation/leakage-core.ts
var SYSTEM_PREFIXES = [
  "proc/",
  "sys/",
  "dev/",
  "usr/lib/",
  "usr/share/",
  "usr/include/",
  "usr/libexec/",
  "lib/",
  "lib64/",
  "var/lib/",
  "var/cache/",
  "etc/",
  "usr/local/lib/python",
  "usr/local/cargo/registry/",
  "usr/local/cargo/git/",
  "usr/local/rustup/",
  "root/.cargo/registry/",
  "root/.cargo/git/",
  "root/.rustup/",
  "usr/local/go/",
  "go/pkg/mod/",
  "root/go/pkg/mod/",
  "root/.m2/",
  "root/.gradle/",
  "home/gradle/.gradle/",
  "opt/java/",
  "usr/local/lib/node_modules/",
  "root/.npm/",
  "root/.cache/"
];
var MIN_SOURCE_BYTES = 200;
var MIN_NEEDLE_MUTANT_ID = 10;
function isSystemPath(path) {
  return SYSTEM_PREFIXES.some((p) => path.startsWith(p));
}
function distinctiveSourceLines(text) {
  let out = [];
  for (let line of text.split(`
`)) {
    let t = line.trim();
    if (t.length >= 40 && !/^(\/\/|#|\*|\/\*)/.test(t) && !/licen[cs]e/i.test(t))
      out.push(t);
  }
  return out;
}
function looksBinary(data) {
  return data.subarray(0, 4096).includes(0);
}
function escape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function needleRegex(inputs) {
  let names = [...inputs.needles.keys()].sort((a, b) => b.length - a.length);
  return names.length ? new RegExp(names.map(escape).join("|"), "g") : null;
}
var decoder = /* @__PURE__ */ new TextDecoder;
function scanFile(inputs, needleRe, path, type, mode, data, identity, out) {
  let err = (code, message) => out.push({ level: "error", code, message }), system = isSystemPath(path), segs = path.split("/");
  if (segs.includes(".git") && !system) {
    let root = segs.slice(0, segs.indexOf(".git") + 1).join("/");
    if (!out.some((f) => f.code === "git_history" && f.message.includes(`/${root} `)))
      err("git_history", `/${root} is in the image: a repository history`);
  }
  if (/^(tests|solution)(\/|$)/.test(path)) {
    if (!out.some((f) => f.code === "hidden_folder" && f.message.startsWith(`/${segs[0]}`)))
      err("hidden_folder", `/${segs[0]} is in the agent's image`);
  }
  if (type !== "0" && type !== "\x00" && type !== "")
    return;
  let what = inputs.hashes.get(identity);
  if (what && identity !== "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
    err("identical_file", `/${path} is identical to ${what}`);
  if (inputs.programName && segs[segs.length - 1] === inputs.programName && mode & 73)
    out.push({
      level: "warning",
      code: "program_name",
      message: `/${path} is an executable named like the program`
    });
  if (system || data.length === 0 || data.length > 2097152 || looksBinary(data))
    return;
  let textBody = decoder.decode(data);
  if (needleRe) {
    let found = /* @__PURE__ */ new Set;
    for (let m of textBody.matchAll(needleRe))
      found.add(m[0]);
    for (let n of found)
      err("name_leak", `/${path} names ${n} (${inputs.needles.get(n)})`);
  }
  if (inputs.sourceLines.size > 0) {
    let hits = 0;
    for (let line of textBody.split(`
`))
      if (inputs.sourceLines.has(line.trim())) {
        if (hits += 1, hits >= 3) {
          err("program_source_lines", `/${path} shares source lines with the program`);
          break;
        }
      }
  }
}
function dockerfileCopySources(dockerfile) {
  let out = [], lines = dockerfile.replace(/\\\r?\n/g, " ").split(`
`);
  for (let line of lines) {
    let m = /^\s*(?:COPY|ADD)\s+(.*)$/i.exec(line);
    if (!m)
      continue;
    let rest = m[1].trim(), flags = [];
    while (rest.startsWith("--")) {
      let f = /^--\S+\s*/.exec(rest)[0];
      flags.push(f.trim()), rest = rest.slice(f.length);
    }
    if (flags.some((f) => /^--from=/i.test(f)))
      continue;
    let args;
    if (rest.startsWith("["))
      try {
        args = JSON.parse(rest).map(String);
      } catch {
        args = rest.split(/\s+/);
      }
    else
      args = rest.split(/\s+/).filter(Boolean);
    out.push(...args.slice(0, -1));
  }
  return out;
}
function sourceSegments(src) {
  return src.replace(/^["']|["']$/g, "").split("/").filter((s) => s && s !== ".");
}
var HIDDEN_SOURCE_SEGMENTS = /* @__PURE__ */ new Set(["tests", "program", "mutants", "solution"]);
function dockerfileHiddenCopies(dockerfile, kind) {
  let git = [], hidden = [];
  for (let src of dockerfileCopySources(dockerfile)) {
    if (/^https?:\/\//i.test(src))
      continue;
    let segs = sourceSegments(src);
    if (segs.includes(".git"))
      git.push(src);
    else if (kind === "binary" && segs.some((s) => HIDDEN_SOURCE_SEGMENTS.has(s)))
      hidden.push(src);
  }
  return { git, hidden };
}
var DOCKERFILE_FETCHES_RE = /\bgit\s+clone\b|\bcurl\b[^\n]*\|\s*(sh|bash)|\bcargo\s+install\b(?![^\n]*nextest)|^\s*ADD\s+[^\n]*\bhttps?:\/\/[^\s]*\.git\b/im, NAME_RES = [
  /^\s*(?:async\s+)?def\s+(test_\w+)/,
  /^\s*class\s+(Test\w+)/,
  /^\s*func\s+((?:Test|Example|Fuzz)\w+)/,
  /^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/,
  /^\s*(?:@\w+\s+)*(?:(?:public|protected|private|static|final)\s+)*void\s+(\w+)\s*\(/
], TITLE_RE = /\b(?:it|test|describe)(?:\.\w+)*\s*\(\s*(['"`])((?:(?!\1).){6,200})\1/g, GTEST_RE = /\b(?:TEST|TEST_F|TEST_P)\s*\(\s*\w+\s*,\s*(\w+)\s*\)/g, GENERIC = /* @__PURE__ */ new Set([
  "main",
  "setup",
  "setUp",
  "tearDown",
  "helper",
  "replace_me",
  "replaceMe"
]);
function goldTestNames(gold) {
  let names = /* @__PURE__ */ new Set;
  for (let text of gold.values())
    for (let line of text.split(`
`)) {
      for (let re of NAME_RES) {
        let m = re.exec(line);
        if (m) {
          names.add(m[1]);
          break;
        }
      }
      for (let m of line.matchAll(TITLE_RE))
        names.add(m[2]);
      for (let m of line.matchAll(GTEST_RE))
        names.add(m[1]);
    }
  return [...names].filter((n) => n.length >= 8 && !GENERIC.has(n)).sort();
}

// app/projects/gold/lanes/mutation/kit/task.ts
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
var KIT_LOCAL_DIR = ".mutkit", MUTANT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/, SKIP_DIRS = /* @__PURE__ */ new Set([
  KIT_LOCAL_DIR,
  ".git",
  "node_modules",
  "target",
  "__pycache__",
  ".pytest_cache",
  ".venv"
]), SKIP_FILES = /* @__PURE__ */ new Set([".DS_Store"]);
function walk(dir, skip = SKIP_DIRS) {
  let out = /* @__PURE__ */ new Map, visit = (d) => {
    for (let name of readdirSync(d).sort()) {
      let abs = join(d, name), st = statSync(abs, { throwIfNoEntry: !1 });
      if (!st)
        continue;
      if (st.isDirectory()) {
        if (!skip.has(name))
          visit(abs);
      } else if (st.isFile() && !SKIP_FILES.has(name))
        out.set(relative(dir, abs).split(sep).join("/"), abs);
    }
  };
  return visit(dir), out;
}
function patchedFiles(text) {
  let out = [];
  for (let line of text.split(`
`))
    if (line.startsWith("+++ ")) {
      let target = line.slice(4).split("\t")[0].trim();
      if (target === "/dev/null")
        continue;
      let i = target.indexOf("/");
      out.push(i >= 0 ? target.slice(i + 1) : target);
    }
  return out;
}
function parseScoring(text) {
  let raw = parse(text), kind = raw.kind;
  if (kind !== "repo" && kind !== "binary")
    throw Error("kind must be 'repo' or 'binary'");
  if (typeof raw.run_tests !== "string" || !raw.run_tests.trim())
    throw Error("run_tests is required");
  let globs = raw.test_globs;
  if (!Array.isArray(globs) || globs.length === 0 || !globs.every((g) => typeof g === "string" && g))
    throw Error("test_globs must be a non-empty list");
  let workdir = typeof raw.workdir === "string" ? raw.workdir : "/app", cfg = {
    kind,
    workdir,
    run_tests: raw.run_tests,
    build: typeof raw.build === "string" ? raw.build : "",
    test_globs: globs,
    source_dir: typeof raw.source_dir === "string" ? raw.source_dir : workdir,
    bin: typeof raw.bin === "string" ? raw.bin : "",
    timeout_sec: Number(raw.timeout_sec ?? 900),
    build_timeout_sec: Number(raw.build_timeout_sec ?? 900)
  };
  if (kind === "binary" && !cfg.bin)
    throw Error("binary tasks need bin");
  return cfg;
}
function listMutants(files, lane) {
  let out = [], patchDir = lane === "titan" ? "tests/program/mutants/" : "tests/mutants/";
  for (let [rel, abs] of files) {
    if (rel.startsWith(patchDir) && rel.endsWith(".patch") && !rel.slice(patchDir.length).includes("/"))
      out.push({
        id: rel.slice(patchDir.length, -6),
        path: rel,
        kind: "patch",
        files: patchedFiles(readFileSync(abs, "utf8"))
      });
    let bin = /^tests\/mutants\/([^/]+)\/bin$/.exec(rel);
    if (bin)
      out.push({ id: bin[1], path: rel, kind: "bin", files: [] });
  }
  return out.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
function laneOf(files, config) {
  if (config)
    return config.kind === "binary" ? "titan" : "prometheus";
  return files.has("tests/program/Dockerfile") ? "titan" : "prometheus";
}
function readTask(dir) {
  if (!existsSync(dir))
    throw Error(`no task folder at ${dir}`);
  let files = walk(dir), config = null, configError = null, scoring = files.get("tests/mutation/scoring.toml");
  if (!scoring)
    configError = "tests/mutation/scoring.toml is missing";
  else
    try {
      config = parseScoring(readFileSync(scoring, "utf8"));
    } catch (e) {
      configError = `tests/mutation/scoring.toml: ${e.message}`;
    }
  let lane = laneOf(files, config), gold = /* @__PURE__ */ new Map;
  for (let [rel, abs] of files)
    if (rel.startsWith("solution/files/"))
      gold.set(rel.slice(15), readFileSync(abs, "utf8"));
  return { dir, files, lane, config, configError, mutants: listMutants(files, lane), gold };
}
function globRegex(pattern) {
  let out = "";
  for (let i = 0;i < pattern.length; )
    if (pattern.startsWith("**/", i))
      out += "(?:.*/)?", i += 3;
    else if (pattern.startsWith("**", i))
      out += ".*", i += 2;
    else {
      let c = pattern[i];
      out += c === "*" ? "[^/]*" : c === "?" ? "[^/]" : c.replace(/[.+^${}()|[\]\\]/g, "\\$&"), i += 1;
    }
  return new RegExp(`^${out}$`);
}
function matchesGlobs(rel, globs) {
  return globs.some((g) => globRegex(g).test(rel));
}

// app/projects/gold/lanes/mutation/kit/static-checks.ts
var REQUIRED = [
  "instruction.md",
  "task.toml",
  "environment/Dockerfile",
  "solution/solve.sh",
  "tests/test.sh",
  "tests/mutation/score_mutants.py",
  "tests/mutation/scoring.toml"
], STOP_EARLY = /(^|\s)(-x|--exitfirst|--maxfail(=|\s)\d+|--bail\b|-failfast|--fail-fast|--failfast)(\s|$)/;
function text2(task, rel) {
  let abs = task.files.get(rel);
  return abs ? readFileSync2(abs, "utf8") : null;
}
function staticChecks(task, rules, platform) {
  let out = [], err = (code, message) => out.push({ level: "error", code, message }), warn = (code, message) => out.push({ level: "warning", code, message }), limits = laneRules(rules, task.lane);
  for (let rel of REQUIRED)
    if (!task.files.has(rel))
      err("missing_file", `${rel} is missing`);
  let toml = text2(task, "task.toml");
  if (toml !== null)
    try {
      parse(toml);
    } catch (e) {
      err("task_toml", `task.toml is not valid TOML: ${e.message.split(`
`)[0]}`);
    }
  let metadata = toml === null ? null : readMutationTaskMetadata(toml, task.lane === "titan" ? "binary" : "repo");
  if (toml !== null && toml.includes(PLACEHOLDER_MARKER))
    err("task_toml_placeholder", `task.toml still holds ${PLACEHOLDER_MARKER} placeholders`);
  for (let problem of metadata?.problems ?? [])
    err("task_toml_metadata", `task.toml ${problem}`);
  if (task.files.has("tests/mutation/score_mutants.py") && text2(task, "tests/mutation/score_mutants.py") !== platform.scorer)
    err("scorer_changed", "tests/mutation/score_mutants.py differs from the platform copy (mutkit scaffold writes it; never edit it)");
  if (task.files.has("tests/test.sh") && text2(task, "tests/test.sh") !== platform.testSh)
    err("test_sh_changed", "tests/test.sh differs from the platform copy");
  let instruction = text2(task, "instruction.md") ?? "";
  if (!instruction.replace(/<!--[\s\S]*?-->/g, "").trim())
    err("instruction_empty", "instruction.md has no text outside comments");
  if (task.configError)
    return err("scoring_toml", task.configError), out;
  let cfg = task.config;
  if (!cfg.run_tests.includes("JUNIT_OUT"))
    err("run_tests", "run_tests must write JUnit XML to $JUNIT_OUT");
  if (!cfg.run_tests.includes("TEST_FILES"))
    warn("run_tests_all", "run_tests ignores $TEST_FILES and runs every test: slower on every mutant (the base tests still never count)");
  if (STOP_EARLY.test(cfg.run_tests))
    err("run_tests_stops_early", "run_tests stops at the first failure; every test must report on every mutant");
  for (let [name, sec] of [
    ["timeout_sec", cfg.timeout_sec],
    ["build_timeout_sec", cfg.build_timeout_sec]
  ])
    if (!Number.isFinite(sec) || sec <= 0 || sec > limits.verifierTimeoutSec)
      err("timeouts", `${name} must be between 1 and ${limits.verifierTimeoutSec}`);
  let runs = task.mutants.length + 3, worst = runs * cfg.timeout_sec + (cfg.build ? (runs - 1) * cfg.build_timeout_sec : 0);
  if (task.mutants.length > 0 && worst > limits.verifierTimeoutSec)
    warn("timeout_budget", `if every run hung, ${runs} runs x timeout_sec${cfg.build ? " (+ builds)" : ""} = ${worst}s, past the verifier's ${limits.verifierTimeoutSec}s: lower timeout_sec toward a few times the reference run`);
  let ids = /* @__PURE__ */ new Map;
  for (let m of task.mutants) {
    if (ids.set(m.id, (ids.get(m.id) ?? 0) + 1), !MUTANT_ID_RE.test(m.id))
      err("mutant_id", `mutant id not allowed: ${m.id} (letters, digits, _ . : -, up to 80)`);
    if (m.kind === "patch" && m.files.length === 0)
      err("mutant_patch", `${m.path} is not a unified diff that writes a file`);
  }
  for (let [id, n] of ids)
    if (n > 1)
      err("mutant_duplicate", `two mutants share the id ${id}`);
  let n = ids.size, declared = metadata?.metadata.mutantCount ?? null;
  if (declared !== null && declared !== n)
    err("mutant_count_mismatch", `task.toml says mutant_count = ${declared}; the task carries ${n}`);
  let laneName = task.lane === "titan" ? "Titan" : "Prometheus";
  if (n < limits.minMutants)
    err("mutant_count", `${n} mutant(s); a ${laneName} task carries at least ${limits.minMutants}`);
  else if (n < limits.warnBelowMutants)
    warn("mutant_count_low", `${n} mutant(s); ${limits.warnBelowMutants} or more are recommended for a ${laneName} task`);
  if (n > rules.maxMutants)
    err("mutant_count", `${n} mutant(s) is past the kit's ${rules.maxMutants}: generated by mistake?`);
  if (task.gold.size === 0)
    err("gold_missing", "solution/files/ holds no reference tests");
  for (let rel of task.gold.keys())
    if (!matchesGlobs(rel, cfg.test_globs))
      warn("gold_outside_globs", `solution/files/${rel} matches no test_globs entry: the scorer never runs it`);
  let names = goldTestNames(task.gold), ids2 = [...ids.keys()].filter((id) => id.length >= 6);
  for (let needle of [...names, ...ids2])
    if (instruction.includes(needle))
      err("instruction_leak", `instruction.md names ${needle} (a reference test or mutant)`);
  if (task.lane === "prometheus") {
    if (cfg.kind !== "repo")
      err("kind", 'a Prometheus task is kind = "repo"');
    if (!task.files.has("tests/mutation/baseline.json"))
      err("baseline_missing", "tests/mutation/baseline.json is missing (mutkit baseline writes it)");
    else
      try {
        let b = JSON.parse(text2(task, "tests/mutation/baseline.json"));
        if (!Array.isArray(b.test_ids))
          err("baseline", "baseline.json has no test_ids list");
      } catch {
        err("baseline", "baseline.json is not JSON");
      }
    if (!/\bpatch\b|(?<![.\w/-])git(?![\w-])/.test(text2(task, "environment/Dockerfile") ?? ""))
      warn("patch_tool", "the scorer applies mutants with patch(1), or git apply where patch is missing: make sure the agent's image has one");
    if (!/^--- /m.test(text2(task, "tests/mutation/removal.patch") ?? ""))
      warn("removal_patch_missing", "tests/mutation/removal.patch holds no diff: the leftover scan only has the reference test names");
    for (let m of task.mutants) {
      if (m.kind !== "patch") {
        err("mutant_kind", `${m.path}: a Prometheus mutant is a patch`);
        continue;
      }
      for (let f of m.files) {
        if (!task.files.has(`tests/mutation/reference/${f}`))
          err("reference_missing", `${m.id} touches ${f}, which has no copy in tests/mutation/reference/`);
        if (matchesGlobs(f, cfg.test_globs))
          err("mutant_touches_tests", `${m.id} changes ${f}, a test file`);
      }
    }
  } else {
    if (cfg.kind !== "binary")
      err("kind", 'a Titan task is kind = "binary"');
    if (!cfg.bin.startsWith("/tests/program/"))
      err("bin_location", "bin must be under /tests/program/, where the verifier image builds the program");
    if (cfg.build.trim())
      err("build_not_empty", "build must be empty: the program and its mutants are built with the verifier image");
    if (!task.files.has("tests/program/Dockerfile"))
      err("program_dockerfile", "tests/program/Dockerfile is missing: it builds the program and its mutants");
    for (let m of task.mutants)
      if (m.kind === "bin")
        err("mutant_kind", `${m.path}: Titan mutants are patches under tests/program/mutants/, built with the verifier image, never binaries in the bundle`);
    for (let rel of task.files.keys())
      if (rel.startsWith("environment/") && rel !== "environment/Dockerfile") {
        let body = text2(task, rel) ?? "";
        if (/\0/.test(body.slice(0, 4096)))
          err("environment_binary", `${rel} is a binary file in the agent's environment`);
      }
    let dockerfile = text2(task, "environment/Dockerfile") ?? "", copies = dockerfileHiddenCopies(dockerfile, "binary");
    if (copies.hidden.length > 0 || copies.git.length > 0)
      err("environment_copies_hidden", "environment/Dockerfile copies hidden material into the agent's image");
    if (DOCKERFILE_FETCHES_RE.test(dockerfile))
      warn("environment_fetches", "environment/Dockerfile fetches code: make sure it is not the program (mutkit leakage scans the built image)");
    let gold = Object.fromEntries(task.gold);
    for (let message of checkSuccessExitStatus(instruction, gold).warnings)
      warn("spec_success_status", message);
    for (let message of checkUnnumberedRules(instruction).warnings)
      warn("spec_unnumbered_rules", message);
  }
  return out;
}

// app/projects/gold/lanes/mutation/kit/check.ts
import { copyFileSync, mkdirSync as mkdirSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join3 } from "node:path";
init_docker();

// app/projects/gold/lanes/mutation/kit/leakage.ts
import { createHash as createHash2 } from "node:crypto";
import { readFileSync as readFileSync4 } from "node:fs";
init_docker();
function sha256(data) {
  return createHash2("sha256").update(data).digest("hex");
}
function leakageInputs(task, built) {
  let hashes = /* @__PURE__ */ new Map, needles = /* @__PURE__ */ new Map, sourceLines = /* @__PURE__ */ new Set;
  for (let [rel, abs] of task.files) {
    let data = readFileSync4(abs);
    if (rel.startsWith("tests/program/") && rel !== "tests/program/Dockerfile") {
      if (rel.startsWith("tests/program/mutants/"))
        hashes.set(sha256(data), `mutant ${rel}`);
      else if (data.length >= MIN_SOURCE_BYTES) {
        if (hashes.set(sha256(data), `program source ${rel}`), !looksBinary(data))
          for (let line of distinctiveSourceLines(data.toString("utf8")))
            sourceLines.add(line);
      }
    } else if (rel.startsWith("tests/mutants/"))
      hashes.set(sha256(data), `hidden ${rel}`);
    else if (rel.startsWith("solution/files/") && data.length >= MIN_SOURCE_BYTES)
      hashes.set(sha256(data), `reference test ${rel}`);
  }
  for (let [path, hash] of built)
    hashes.set(hash, `built ${path}`);
  for (let name of goldTestNames(task.gold))
    needles.set(name, "reference test name");
  for (let m of task.mutants)
    if (m.id.length >= MIN_NEEDLE_MUTANT_ID)
      needles.set(m.id, "mutant id");
  let bin = task.config?.bin ? task.config.bin.split("/").pop() : null;
  return { hashes, needles, sourceLines, programName: task.lane === "titan" ? bin : null };
}
function scanEntry(inputs, needleRe, path, type, mode, data, out, hash = sha256(data)) {
  scanFile(inputs, needleRe, path, type, mode, data, hash, out);
}
async function scanImage(image, inputs) {
  await Promise.resolve().then(() => init_docker());
  let created = run("docker", ["create", image, "true"]);
  if (created.status !== 0)
    throw Error(`could not create a container from ${image}: ${created.stderr.trim()}`);
  let id = created.stdout.trim(), out = [], re = needleRegex(inputs);
  try {
    await streamTar(["export", id], (path, type, mode, data, hash) => scanEntry(inputs, re, path, type, mode, data, out, hash));
  } finally {
    run("docker", ["rm", "-f", id]);
  }
  return out;
}
async function imageFiles(image, dir) {
  await Promise.resolve().then(() => init_docker());
  let created = run("docker", ["create", image, "true"]);
  if (created.status !== 0)
    throw Error(`could not create a container from ${image}`);
  let id = created.stdout.trim(), files = /* @__PURE__ */ new Map;
  try {
    await streamTar(["cp", `${id}:${dir}`, "-"], (path, type, _mode, _data, hash) => {
      if (type === "0" || type === "\x00" || type === "")
        files.set(path, hash);
    });
  } finally {
    run("docker", ["rm", "-f", id]);
  }
  return files;
}

// app/projects/gold/lanes/mutation/kit/check.ts
var PY = "/opt/judge/python/bin/python3 -I /tests/mutation/score_mutants.py";
function verdict(run) {
  let v = join3(run.outDir, "verifier"), ungraded = readJson(join3(v, "ungraded.json"));
  return {
    grade: readJson(join3(v, "grade.json")),
    reward: readJson(join3(v, "reward.json")),
    ungraded: ungraded ? ungraded.reason ?? "ungraded" : null
  };
}
function judgeRuns(task, rules, gold, empty, base, removal) {
  let findings = [], err = (code, message) => findings.push({ level: "error", code, message }), warn = (code, message) => findings.push({ level: "warning", code, message }), rows = [];
  if (gold.ungraded || !gold.reward || !gold.grade)
    err("gold_ungraded", `the reference run was not graded: ${gold.ungraded ?? tailOf(gold.log)}`);
  else {
    let matrix = gold.grade.kill_matrix ?? {}, expected = new Set(task.mutants.map((m) => m.id)), scored = new Set(Object.keys(matrix)), missing = [...expected].filter((id) => !scored.has(id)).sort(), extra = [...scored].filter((id) => !expected.has(id)).sort();
    if (missing.length)
      err("mutant_not_scored", `the reference run did not score ${missing.length} mutant(s): ${missing.slice(0, 10).join(", ")} (did the program builder build them all?)`);
    if (extra.length)
      err("mutant_unexpected", `the reference run scored mutants the task does not carry: ${extra.slice(0, 10).join(", ")}`);
    let seconds = new Map((gold.grade.criteria ?? []).map((c) => [c.id, c.seconds ?? null]));
    for (let id of Object.keys(matrix).sort()) {
      let killers = matrix[id].length;
      if (rows.push({
        id,
        goldKillers: killers,
        seconds: seconds.get(id) ?? null,
        baseKillers: base?.kill_matrix ? base.kill_matrix[id]?.length ?? 0 : null
      }), killers === 0)
        err("gold_survivor", `the reference tests do not kill ${id}: an equivalent mutant, or the tests miss it`);
      let s = seconds.get(id);
      if (task.config && s !== null && s !== void 0 && s >= task.config.timeout_sec * 0.95)
        warn("mutant_timeout", `${id} ran into timeout_sec (${task.config.timeout_sec}s) and counts as killed by every test: a hang, not a failing assertion`);
    }
    if ((gold.grade.tests_total ?? 0) === 0)
      err("gold_no_tests", "the reference run found no submitted tests (check test_globs and solution/files/)");
    else if (gold.grade.validity !== 1) {
      let bad = Object.entries(gold.grade.tests ?? {}).filter(([, s]) => s !== "passed").map(([t, s]) => `${t} (${s})`);
      err("gold_invalid_tests", `reference tests that do not pass on the reference code or were disqualified: ${bad.slice(0, 10).join(", ")}`);
    }
  }
  let limit = laneRules(rules, task.lane).verifierTimeoutSec;
  if (gold.seconds > limit)
    err("timeout", `the reference run took ${Math.round(gold.seconds)}s; the verifier stops at ${limit}s`);
  else if (gold.seconds > limit * rules.timeoutWarnFraction)
    warn("timeout_margin", `the reference run took ${Math.round(gold.seconds)}s of the verifier's ${limit}s: keep a margin for slower machines`);
  if (empty.ungraded || !empty.reward)
    err("empty_ungraded", `the empty run was not graded: ${empty.ungraded ?? tailOf(empty.log)}`);
  else if (empty.reward.reward !== 0)
    err("empty_scores", `an empty submission scores ${empty.reward.reward}; it must score 0`);
  if (task.lane === "prometheus") {
    if (!base || base.ungraded || !base.kill_matrix)
      err("base_run", `the run of the repository's own tests against the mutants did not finish: ${base?.reason ?? "no report"}`);
    else {
      let missing = rows.filter((r) => !(r.id in base.kill_matrix)).map((r) => r.id);
      if (missing.length)
        err("base_run", `the base run has no result for ${missing.slice(0, 5).join(", ")}`);
    }
    for (let r of rows)
      if (r.baseKillers && r.baseKillers > 0)
        err("base_kills", `the repository's own tests already kill ${r.id}: a copied existing test would earn it`);
    if (!removal)
      err("removal_check", "the clean-removal check left no report");
    else if (!removal.ok) {
      for (let p of removal.problems ?? [])
        err("removal", p);
      for (let l of (removal.leftovers ?? []).slice(0, 20))
        err("leftover", `${l.file}${l.line ? `:${l.line}` : ""} (${l.kind}) names ${l.name || "a removed test"}: ${l.text}`);
    }
  }
  return { findings, rows };
}
var REFERENCE_RUN_LINE = /reference run: \d+ test\(s\) in (\d+)s(?! \(timed out\))/;
function cpuAt(samples, t) {
  for (let i = 1;i < samples.length; i++) {
    let [t0, c0] = samples[i - 1], [t1, c1] = samples[i];
    if (t0 <= t && t <= t1)
      return t1 > t0 ? c0 + (c1 - c0) * (t - t0) / (t1 - t0) : c1;
  }
  return null;
}
function referenceRunCpuShare(trace, wall) {
  if (!trace || !(wall > 0))
    return null;
  let stamped = trace.lines.find(([, line]) => REFERENCE_RUN_LINE.test(line));
  if (!stamped)
    return null;
  let end = cpuAt(trace.samples, stamped[0]), start = cpuAt(trace.samples, stamped[0] - wall);
  return end === null || start === null ? null : (end - start) / wall;
}
function cpuTimeoutFindings(config, cpus, reference, empty) {
  let findings = [];
  if (!config)
    return findings;
  let warn = (code, message) => findings.push({ level: "warning", code, message }), advise = (what, wall, est, name, limit) => `${what} took ${Math.round(wall)}s here on up to ${cpus} CPUs, about ${est}s on one CPU; the platform's verifiers get roughly 1 to 1.5 CPUs, so ${name} = ${limit} can cut it short (a reference run cut short scores the task 0): set ${name} to at least ${ONE_CPU_TIMEOUT_MULTIPLE * est}`, run = reference.log.match(REFERENCE_RUN_LINE);
  if (run) {
    let wall = Number(run[1]), share = referenceRunCpuShare(reference.cpuTrace, wall), est = Math.ceil(wall * Math.min(cpus, Math.max(1, share ?? cpus)));
    if (est > 0 && config.timeout_sec < ONE_CPU_TIMEOUT_MULTIPLE * est)
      warn("timeout_cpu", advise("the reference tests", wall, est, "timeout_sec", config.timeout_sec));
  }
  if (config.build.trim() && empty.seconds > 0) {
    let est = Math.ceil(Math.max(empty.seconds, empty.cpuSeconds ?? empty.seconds * cpus));
    if (config.build_timeout_sec < ONE_CPU_TIMEOUT_MULTIPLE * est)
      warn("build_timeout_cpu", advise("a build with no tests submitted", empty.seconds, est, "build_timeout_sec", config.build_timeout_sec));
  }
  return findings;
}
function tailOf(log) {
  return log.trim().split(`
`).slice(-5).join(" | ");
}
async function checkTask(dir, opts) {
  let say = opts.log, task = readTask(dir), report = {
    task: dir,
    lane: task.lane,
    findings: staticChecks(task, opts.rules, opts.platform),
    rows: [],
    timings: {},
    gold: null,
    empty: null,
    removal: null
  }, blocking = report.findings.some((f) => f.level === "error" && ["missing_file", "scoring_toml"].includes(f.code));
  if (opts.staticOnly || blocking)
    return report;
  let problem = dockerReady();
  if (problem)
    return report.findings.push({ level: "error", code: "docker", message: problem }), report;
  let runsDir = join3(dir, KIT_LOCAL_DIR, "runs");
  mkdirSync2(runsDir, { recursive: !0 });
  let docker = { native: opts.native, log: say, logDir: runsDir }, limits = laneRules(opts.rules, task.lane), timed = (key, f) => {
    let t = Date.now(), out = f();
    return report.timings[key] = Math.round((Date.now() - t) / 100) / 10, out;
  };
  try {
    say("building the judge runtime (cached after the first run)…");
    let runtime = timed("runtime_build_sec", () => buildRuntimeImage(opts.rules, docker));
    say("building the agent's image…");
    let env = timed("environment_build_sec", () => buildEnvironmentImage(task, opts.repo, docker)), program = null;
    if (task.lane === "titan")
      say("building the program and every mutant…"), program = timed("program_build_sec", () => buildProgramImage(task, docker));
    say("building the verifier image…");
    let verifier = timed("verifier_build_sec", () => buildVerifierImage(task, env, runtime, program, docker)), solution = join3(dir, "solution");
    say("reference: the reference tests through the scorer…");
    let gold = runCase(verifier, "reference", "bash /solution/solve.sh && bash /tests/test.sh", limits, join3(runsDir, "reference"), solution);
    report.timings.gold_sec = Math.round(gold.seconds), say(`  ${Math.round(gold.seconds)}s`), say("empty: no tests submitted…");
    let empty = runCase(verifier, "empty", "bash /tests/test.sh", limits, join3(runsDir, "empty"), null);
    report.timings.empty_sec = Math.round(empty.seconds);
    let base = null, removal = null;
    if (task.lane === "prometheus") {
      say("base: what the repository's own tests already kill…");
      let b = runCase(verifier, "base", `mkdir -p /logs/verifier && ${PY} matrix --all-tests --out /logs/verifier/matrix.json`, limits, join3(runsDir, "base"), null);
      report.timings.base_sec = Math.round(b.seconds), base = readJson(join3(b.outDir, "verifier", "matrix.json")) ?? {
        ungraded: !0,
        reason: b.timedOut ? "it did not finish in time" : tailOf(b.log)
      }, say("removal: the remaining suite and leftover references…");
      let r = runCase(verifier, "removal", `mkdir -p /logs/verifier && ${PY} check-removal --gold-dir /solution/files --out /logs/verifier/removal.json`, limits, join3(runsDir, "removal"), solution);
      report.timings.removal_sec = Math.round(r.seconds), removal = readJson(join3(r.outDir, "verifier", "removal.json"));
    }
    let g = verdict(gold), e = verdict(empty);
    report.gold = g.reward, report.empty = e.reward, report.removal = removal;
    let judged = judgeRuns(task, opts.rules, { ...g, seconds: gold.seconds, log: gold.log }, { ...e, log: empty.log }, base, removal);
    if (report.findings.push(...judged.findings), report.rows = judged.rows, !gold.timedOut && !empty.timedOut)
      report.findings.push(...cpuTimeoutFindings(task.config, limits.cpus, gold, empty));
    if (opts.leakage) {
      say("leakage: scanning the agent's image…");
      let built = program ? await imageFiles(program, "/out") : /* @__PURE__ */ new Map, t = Date.now();
      report.findings.push(...await scanImage(env, leakageInputs(task, built))), report.timings.leakage_sec = Math.round((Date.now() - t) / 1000);
    }
  } catch (e) {
    report.findings.push({ level: "error", code: "docker_run", message: e.message });
  }
  return writeFileSync2(join3(dir, KIT_LOCAL_DIR, "check-report.json"), `${JSON.stringify(report, null, 2)}
`), report;
}
async function writeBaseline(dir, opts) {
  let task = readTask(dir);
  if (task.lane !== "prometheus")
    throw Error("baseline is for Prometheus (repo) tasks");
  if (task.configError)
    throw Error(task.configError);
  let problem = dockerReady();
  if (problem)
    throw Error(problem);
  let runsDir = join3(dir, KIT_LOCAL_DIR, "runs");
  mkdirSync2(runsDir, { recursive: !0 });
  let docker = { native: opts.native, log: opts.log, logDir: runsDir }, runtime = buildRuntimeImage(opts.rules, docker), env = buildEnvironmentImage(task, opts.repo, docker), verifier = buildVerifierImage(task, env, runtime, null, docker), run = runCase(verifier, "baseline", `mkdir -p /logs/verifier && ${PY} baseline /logs/verifier/baseline.json`, laneRules(opts.rules, task.lane), join3(runsDir, "baseline"), null), out = join3(run.outDir, "verifier", "baseline.json");
  if (!readJson(out))
    throw Error(`baseline did not run:
${tailOf(run.log)}`);
  let dest = join3(dir, "tests/mutation/baseline.json");
  return copyFileSync(out, dest), dest;
}
async function leakageOnly(dir, opts) {
  let task = readTask(dir), problem = dockerReady();
  if (problem)
    throw Error(problem);
  let runsDir = join3(dir, KIT_LOCAL_DIR, "runs");
  mkdirSync2(runsDir, { recursive: !0 });
  let docker = { native: opts.native, log: opts.log, logDir: runsDir }, env = buildEnvironmentImage(task, opts.repo, docker), built = task.lane === "titan" && task.config ? await imageFiles(buildProgramImage(task, docker), "/out") : /* @__PURE__ */ new Map;
  return scanImage(env, leakageInputs(task, built));
}
function formatMatrix(rows, lane) {
  if (rows.length === 0)
    return "";
  let w = Math.max(6, ...rows.map((r) => r.id.length)), head = `  ${"mutant".padEnd(w)}   ref kills  seconds${lane === "prometheus" ? "  base kills" : ""}`, lines = rows.map((r) => `  ${r.id.padEnd(w)}  ${String(r.goldKillers).padStart(10)}  ${(r.seconds === null ? "-" : r.seconds.toFixed(1)).padStart(7)}${lane === "prometheus" ? `  ${String(r.baseKillers ?? "-").padStart(10)}` : ""}${r.goldKillers === 0 ? "  SURVIVED" : ""}`);
  return [head, ...lines].join(`
`);
}

// app/projects/gold/lanes/mutation/kit/pack.ts
var import_adm_zip = __toESM(require_adm_zip());
import { createHash as createHash3 } from "node:crypto";
import { readFileSync as readFileSync5 } from "node:fs";

// app/projects/gold/lib/kit/bundle-limits.ts
var KIT_BUNDLE_FORMAT = 1, KIT_BUNDLE_MAX_BYTES = 2097152;

// app/projects/gold/lanes/mutation/kit/pack.ts
var PACK_MANIFEST = "manifest.json", PACK_REPORT = "check_report.json";
function packTask(dir, rules, findings, lastCheck) {
  let task = readTask(dir), zip = new import_adm_zip.default, hashes = {}, paths = [...task.files.keys()].sort();
  for (let rel of paths) {
    let bytes = readFileSync5(task.files.get(rel));
    if (bytes.subarray(0, 8192).includes(0))
      throw Error(`${rel} is a binary file; a bundle carries text only`);
    hashes[rel] = createHash3("sha256").update(bytes).digest("hex"), zip.addFile(rel, bytes, "", rel.endsWith(".sh") ? 493 : 420);
  }
  let manifest = {
    format: KIT_BUNDLE_FORMAT,
    kit: rules.kit,
    lane: task.lane,
    files: hashes
  };
  zip.addFile(PACK_MANIFEST, Buffer.from(`${JSON.stringify(manifest, null, 2)}
`));
  let report = {
    kit: rules.kit,
    static_errors: findings.filter((f) => f.level === "error").map((f) => f.code),
    static_warnings: findings.filter((f) => f.level === "warning").map((f) => f.code),
    last_check: lastCheck ? {
      errors: (lastCheck.findings ?? []).filter((f) => f.level === "error").map((f) => f.code),
      timings: lastCheck.timings ?? {}
    } : null
  };
  zip.addFile(PACK_REPORT, Buffer.from(`${JSON.stringify(report, null, 2)}
`));
  let out = zip.toBuffer();
  if (out.length > KIT_BUNDLE_MAX_BYTES)
    throw Error(`the bundle is ${(out.length / 1024 / 1024).toFixed(1)} MB; the task page takes up to ${KIT_BUNDLE_MAX_BYTES / 1024 / 1024} MB`);
  return { zip: out, files: paths };
}

// app/projects/gold/lanes/mutation/kit/scaffold.ts
import { chmodSync, existsSync as existsSync3, mkdirSync as mkdirSync3, readdirSync as readdirSync2, writeFileSync as writeFileSync3 } from "node:fs";
import { basename as basename2, dirname as dirname2, join as join4 } from "node:path";

// app/projects/gold/lanes/mutation/kit/templates.ts
var LANES = ["prometheus", "titan"], LANGUAGES = [
  "python",
  "go",
  "rust",
  "java-maven",
  "java-gradle",
  "typescript-jest",
  "typescript-vitest",
  "cpp"
], PROGRAM_LANGUAGES = ["rust", "go", "c", "cpp", "python", "node", "java"], MERGE = (glob) => `{ echo '<testsuites>'; for f in ${glob}; do [ -f "$f" ] && sed '1{/^<?xml/d;}' "$f"; done; echo '</testsuites>'; } > "$JUNIT_OUT"`, LANGUAGE_SPECS = {
  python: {
    image: "python:3.12-slim-bookworm",
    setup: ["pip install --no-cache-dir pytest==8.4.2"],
    repoSetup: [],
    titanSetup: [],
    run_tests: 'python -m pytest -p no:cacheprovider -o addopts="" -q --junitxml="$JUNIT_OUT" $TEST_FILES',
    build: "",
    test_globs: ["tests/**/test_*.py", "tests/**/*_test.py"],
    goldPath: "tests/test_behaviour.py",
    goldTest: (kind) => kind === "binary" ? `import os
import subprocess

BIN = os.environ["BIN"]


def run(*args, stdin=b""):
    return subprocess.run([BIN, *args], input=stdin, capture_output=True, timeout=30)


def test_help_exits_zero():
    assert run("--help").returncode == 0
` : `def test_replace_me():
    assert True
`
  },
  go: {
    image: "golang:1.26-bookworm",
    setup: ["go install gotest.tools/gotestsum@v1.12.3"],
    repoSetup: [],
    titanSetup: ["go mod init behaviour"],
    run_tests: 'gotestsum --junitfile "$JUNIT_OUT" -- -count=1 $(for f in $TEST_FILES; do echo "./$(dirname "$f")"; done | sort -u)',
    build: "go build ./...",
    test_globs: ["**/*_test.go"],
    goldPath: "behaviour_test.go",
    goldTest: (kind) => kind === "binary" ? `package behaviour

import (
	"os"
	"os/exec"
	"testing"
)

func TestHelpExitsZero(t *testing.T) {
	if err := exec.Command(os.Getenv("BIN"), "--help").Run(); err != nil {
		t.Fatal(err)
	}
}
` : `package main

import "testing"

func TestReplaceMe(t *testing.T) {}
`
  },
  rust: {
    image: "rust:1-slim-bookworm",
    setup: [
      "cargo install --locked cargo-nextest@0.9.104",
      `mkdir -p /root/.config/nextest && printf '[profile.mutation]\\nfail-fast = false\\n[profile.mutation.junit]\\npath = "junit.xml"\\n' > /root/.config/nextest/config.toml`
    ],
    repoSetup: [],
    titanSetup: ["cargo init --vcs none --name behaviour ."],
    run_tests: 'rm -f target/nextest/mutation/junit.xml; cargo nextest run --offline --no-fail-fast --tool-config-file mutation:/root/.config/nextest/config.toml --profile mutation $(for f in $TEST_FILES; do echo --test "$(basename "$f" .rs)"; done); rc=$?; cp target/nextest/mutation/junit.xml "$JUNIT_OUT"; exit $rc',
    build: "cargo build --offline",
    test_globs: ["tests/*.rs"],
    goldPath: "tests/behaviour.rs",
    goldTest: (kind) => kind === "binary" ? `use std::process::Command;

fn bin() -> Command {
    Command::new(std::env::var("BIN").expect("BIN"))
}

#[test]
fn help_exits_zero() {
    assert!(bin().arg("--help").status().unwrap().success());
}
` : `#[test]
fn replace_me() {}
`
  },
  "java-maven": {
    image: "maven:3.9-eclipse-temurin-21",
    setup: [],
    repoSetup: [],
    titanSetup: null,
    run_tests: `find . -type d -name surefire-reports -prune -exec rm -rf {} +; mvn -o -q -Dmaven.test.failure.ignore=true -Dsurefire.failIfNoSpecifiedTests=false -Dtest="$(for f in $TEST_FILES; do c=\${f#*src/test/java/}; c=\${c%.java}; printf '%s,' "\${c//\\//.}"; done)" test; rc=$?; ${MERGE('$(find . -path "*/surefire-reports/TEST-*.xml")')}; exit $rc`,
    build: "mvn -o -q compile",
    test_globs: ["**/src/test/java/**/*Test.java"],
    goldPath: "src/test/java/behaviour/BehaviourTest.java",
    goldTest: () => `package behaviour;

import org.junit.jupiter.api.Test;

class BehaviourTest {
    @Test
    void replaceMe() {}
}
`
  },
  "java-gradle": {
    image: "gradle:8.14-jdk21",
    setup: [],
    repoSetup: [],
    titanSetup: null,
    run_tests: `find . -type d -path "*/build/test-results" -prune -exec rm -rf {} +; gradle test --offline --continue -q $(for f in $TEST_FILES; do c=\${f#*src/test/java/}; c=\${c%.java}; echo --tests "\${c//\\//.}"; done); rc=$?; ${MERGE('$(find . -path "*/test-results/test/TEST-*.xml")')}; exit $rc`,
    build: "gradle compileJava --offline -q",
    test_globs: ["**/src/test/java/**/*Test.java"],
    goldPath: "src/test/java/behaviour/BehaviourTest.java",
    goldTest: () => `package behaviour;

import org.junit.jupiter.api.Test;

class BehaviourTest {
    @Test
    void replaceMe() {}
}
`
  },
  "typescript-jest": {
    image: "node:22-bookworm-slim",
    setup: [],
    repoSetup: ["npm ci && npm install --no-save jest-junit@16"],
    titanSetup: null,
    run_tests: 'JEST_JUNIT_OUTPUT_FILE="$JUNIT_OUT" JEST_JUNIT_CLASSNAME="{filepath}" JEST_JUNIT_TITLE="{classname} {title}" npx jest --ci --reporters=jest-junit --runTestsByPath $TEST_FILES',
    build: "",
    test_globs: ["**/*.test.ts", "**/*.spec.ts", "**/__tests__/**/*.ts"],
    goldPath: "tests/behaviour.test.ts",
    goldTest: (kind) => kind === "binary" ? `import { spawnSync } from 'node:child_process';

const BIN = process.env.BIN as string;

test('help exits zero', () => {
  expect(spawnSync(BIN, ['--help']).status).toBe(0);
});
` : `test('replace me', () => {
  expect(true).toBe(true);
});
`
  },
  "typescript-vitest": {
    image: "node:22-bookworm-slim",
    setup: [],
    repoSetup: ["npm ci"],
    titanSetup: ["npm init -y >/dev/null && npm install vitest@3"],
    run_tests: 'npx vitest run --reporter=junit --outputFile="$JUNIT_OUT" $TEST_FILES',
    build: "",
    test_globs: ["**/*.test.ts", "**/*.spec.ts"],
    goldPath: "tests/behaviour.test.ts",
    goldTest: (kind) => kind === "binary" ? `import { spawnSync } from 'node:child_process';
import { expect, test } from 'vitest';

const BIN = process.env.BIN as string;

test('help exits zero', () => {
  expect(spawnSync(BIN, ['--help']).status).toBe(0);
});
` : `import { expect, test } from 'vitest';

test('replace me', () => {
  expect(true).toBe(true);
});
`
  },
  cpp: {
    image: "debian:bookworm",
    setup: [
      "apt-get update && apt-get install -y --no-install-recommends cmake g++ make libgtest-dev && rm -rf /var/lib/apt/lists/*"
    ],
    repoSetup: [],
    titanSetup: null,
    run_tests: 'cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug >/dev/null && cmake --build build -j2 && ctest --test-dir build --output-junit "$JUNIT_OUT" --no-tests=ignore',
    build: "cmake -S . -B build >/dev/null && cmake --build build -j2",
    test_globs: ["tests/**/*_test.cpp"],
    goldPath: "tests/behaviour_test.cpp",
    goldTest: (kind) => kind === "binary" ? `#include <cstdlib>
#include <string>
#include <gtest/gtest.h>

TEST(Behaviour, HelpExitsZero) {
    std::string cmd = std::string(std::getenv("BIN")) + " --help >/dev/null";
    EXPECT_EQ(std::system(cmd.c_str()), 0);
}
` : `#include <gtest/gtest.h>

TEST(Behaviour, ReplaceMe) {}
`
  }
}, BUILD_LOOP = (build, artifact) => `RUN set -eu; mkdir -p /out/program /out/mutants; \\
    ( ${build} ) || { echo "the program does not build"; exit 1; }; \\
    cp ${artifact} /out/program/$PROGRAM; \\
    for p in /src/mutants/*.patch; do \\
      [ -e "$p" ] || continue; id=$(basename "$p" .patch); \\
      patch -p1 --forward --batch --silent -i "$p"; \\
      ${build} || { echo "mutant $id does not build"; exit 1; }; \\
      mkdir -p /out/mutants/$id && cp ${artifact} /out/mutants/$id/bin; \\
      patch -p1 -R --batch --silent -i "$p"; \\
    done`, PROGRAM_SPECS = {
  rust: {
    dockerfile: `FROM rust:1-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends patch && rm -rf /var/lib/apt/lists/*
ARG PROGRAM=program
ENV PROGRAM=$PROGRAM
WORKDIR /src
COPY . /src
# Dependencies come over the network while the image builds; the verifier
# itself runs offline.
RUN cargo fetch --locked
${BUILD_LOOP('cargo build --release --offline --quiet --bin "$PROGRAM"', "target/release/$PROGRAM")}
`,
    note: "Cargo.toml and Cargo.lock at tests/program/; PROGRAM is the [[bin]] name."
  },
  go: {
    dockerfile: `FROM golang:1.26-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends patch && rm -rf /var/lib/apt/lists/*
ARG PROGRAM=program
ENV PROGRAM=$PROGRAM CGO_ENABLED=0
# The main package, relative to go.mod (./cmd/<name> in most repositories).
ARG MAIN_PKG=.
WORKDIR /src
COPY . /src
RUN go mod download
${BUILD_LOOP('go build -o /tmp/$PROGRAM "$MAIN_PKG"', "/tmp/$PROGRAM")}
`,
    note: "go.mod at tests/program/; set MAIN_PKG to the main package (shfmt: ./cmd/shfmt)."
  },
  c: {
    dockerfile: `FROM debian:bookworm
RUN apt-get update && apt-get install -y --no-install-recommends autoconf automake libtool make gcc pkg-config bison flex patch && rm -rf /var/lib/apt/lists/*
ARG PROGRAM=program
ENV PROGRAM=$PROGRAM
# Runs once, before the program and its mutants build. An autotools project
# generates and runs configure (jq: autoreconf -i && ./configure
# --with-oniguruma=builtin --disable-docs --enable-all-static); a plain
# Makefile project needs nothing (CONFIGURE=true).
ARG CONFIGURE="if [ -f configure.ac ]; then autoreconf -fi && ./configure; elif [ -x configure ]; then ./configure; fi"
# Builds the program; make rebuilds only what a mutant touched (lz4:
# make -C programs lz4; jq: plain make, which builds its bundled oniguruma
# first).
ARG MAKE_CMD="make -j2"
# Where the build leaves the program, relative to tests/program/ (lz4:
# programs/lz4).
ARG ARTIFACT=$PROGRAM
WORKDIR /src
COPY . /src
RUN sh -c "$CONFIGURE"
${BUILD_LOOP('sh -c "$MAKE_CMD"', '"$ARTIFACT"')}
`,
    note: "The source at tests/program/ with its Makefile or configure.ac; set CONFIGURE, MAKE_CMD and ARTIFACT. A vendored submodule (jq: vendor/oniguruma) is not in a plain download of the repository: copy its source in at the commit the parent pins. Keep the whole tracked tree (lz4 needs its build/ folder)."
  },
  cpp: {
    dockerfile: `FROM debian:bookworm
RUN apt-get update && apt-get install -y --no-install-recommends cmake g++ make patch && rm -rf /var/lib/apt/lists/*
ARG PROGRAM=program
ENV PROGRAM=$PROGRAM
# The CMake target that builds the program, and where it lands relative to
# tests/program/ (cmark: CMAKE_TARGET=cmark_exe, ARTIFACT=build/src/cmark).
ARG CMAKE_TARGET=$PROGRAM
ARG ARTIFACT=build/$PROGRAM
WORKDIR /src
COPY . /src
${BUILD_LOOP('cmake -S . -B build -DCMAKE_BUILD_TYPE=Release >/dev/null && cmake --build build -j2 --target "$CMAKE_TARGET"', '"$ARTIFACT"')}
`,
    note: "CMakeLists.txt at tests/program/; set CMAKE_TARGET and ARTIFACT when the executable target is not named PROGRAM or does not land in build/."
  },
  python: {
    dockerfile: `ARG PYTHON_IMAGE=python:3.12-slim-bookworm
FROM \${PYTHON_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends patch && rm -rf /var/lib/apt/lists/*
ARG PROGRAM=program
ENV PROGRAM=$PROGRAM
WORKDIR /src
COPY . /src
# A runnable entry point: a zipapp of the package (python -m zipapp), run by
# the agent image's own python3. Dependencies must be pure Python, vendored
# into the app with pip install --target.
RUN if [ -f requirements.txt ]; then pip install --no-cache-dir --target /src/app -r requirements.txt; fi
${BUILD_LOOP('rm -f /tmp/$PROGRAM && python -m zipapp app -p "/usr/bin/env python3" -o /tmp/$PROGRAM', "/tmp/$PROGRAM")}
`,
    note: "The package under tests/program/app/ with a __main__.py; the agent image needs python3."
  },
  node: {
    dockerfile: `FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends patch && rm -rf /var/lib/apt/lists/*
ARG PROGRAM=program
ENV PROGRAM=$PROGRAM
WORKDIR /src
COPY . /src
RUN npm ci && npm install --no-save esbuild@0.25
# The entry point: src/main.ts, or the program's own CLI file (marked:
# bin/marked.js, which reaches the TypeScript sources).
ARG ENTRY=src/main.ts
# A runnable entry point: one bundled file with a node shebang (the entry's
# own, kept by esbuild, or one added), run by the agent image's own node (20
# or newer, which current programs such as marked require; the agent image
# carries node 22). It ends inside a // comment, so the scorer's neutral copy
# (one trailing byte) still runs.
${BUILD_LOOP(`npx esbuild "$ENTRY" --bundle --platform=node --target=node20 --keep-names --outfile=/tmp/$PROGRAM && { head -c2 /tmp/$PROGRAM | grep -q '#!' || sed -i '1i #!/usr/bin/env node' /tmp/$PROGRAM; } && printf "\\n//" >> /tmp/$PROGRAM && chmod +x /tmp/$PROGRAM`, "/tmp/$PROGRAM")}
`,
    note: 'package.json and package-lock.json at tests/program/, entry src/main.ts (set ENTRY otherwise); the agent image needs node 20 or newer. A CLI that imports its built output (marked: ../lib/marked.esm.js) needs that path pointed at the TypeScript sources (export * from "../src/marked.ts"), and a createRequire of package.json removed so esbuild inlines it.'
  },
  java: {
    dockerfile: `ARG JDK_IMAGE=eclipse-temurin:21-jdk
FROM \${JDK_IMAGE}
ARG MAVEN_VERSION=3.9.14
RUN apt-get update && apt-get install -y --no-install-recommends curl patch && rm -rf /var/lib/apt/lists/* \\
 && curl -fsSL https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/$MAVEN_VERSION/apache-maven-$MAVEN_VERSION-bin.tar.gz | tar xz -C /opt \\
 && ln -s /opt/apache-maven-$MAVEN_VERSION/bin/mvn /usr/local/bin/mvn
ARG PROGRAM=program
ENV PROGRAM=$PROGRAM
# Extra Maven arguments (one module of a multi-module build: -pl tool -am;
# release plugins off: -Dmaven.javadoc.skip=true -Dmaven.source.skip=true
# -Dgpg.skip), and the exact path of the runnable jar the package step leaves
# (shaded, or with its dependencies), relative to tests/program/: it is
# quoted, so a glob does not expand.
ARG MVN_ARGS=""
ARG JAR=target/$PROGRAM.jar
WORKDIR /src
COPY . /src
# Dependencies and plugins come over the network here, once; the program and
# every mutant then build offline.
RUN mvn -B -q $MVN_ARGS package -DskipTests && mvn -B -q $MVN_ARGS clean
# A runnable entry point: the jar behind a /bin/sh stub (java -jar reads a
# jar from its end), run by the agent image's own java. Every build starts
# clean: a mutant that deletes a class or resource must not find the
# reference's compiled copy still in target/.
${BUILD_LOOP(`mvn -B -q -o $MVN_ARGS clean package -DskipTests && { printf '#!/bin/sh\\nexec java -jar "$0" "$@"\\n'; cat "$JAR"; } > /tmp/$PROGRAM && chmod +x /tmp/$PROGRAM`, "/tmp/$PROGRAM")}
`,
    note: "pom.xml at tests/program/; set JAR to the runnable (shaded) jar and MVN_ARGS for one module. The agent image copies in a JDK: some programs (google-java-format) load the compiler at run time."
  }
};
function scoringToml(lane, lang, program = "program") {
  let spec = LANGUAGE_SPECS[lang], kind = lane === "prometheus" ? "repo" : "binary", lines = [
    `kind = "${kind}"`,
    'workdir = "/app"',
    "# Runs $TEST_FILES (newline-separated, workdir-relative) and writes ONE",
    "# JUnit XML to $JUNIT_OUT. It must run every test and never stop at the",
    "# first failure.",
    `run_tests = ${JSON.stringify(spec.run_tests)}`
  ];
  if (kind === "repo")
    lines.push("# Rebuilds after a mutant is applied; a mutant that does not build is", "# the task's fault, never a kill.", `build = ${JSON.stringify(spec.build)}`, 'source_dir = "/app"');
  else
    lines.push("# The reference program, built from tests/program/ with the verifier", "# image; each mutant is swapped in at this path.", `bin = "/tests/program/${program}"`);
  return lines.push(`test_globs = ${JSON.stringify(spec.test_globs)}`, "# One test run. A mutant can loop forever: its run is cut here and", "# counts as a kill, so keep this a few times the reference run's time,", "# and (mutants + 3) x timeout_sec well under the lane's verifier limit", "# (Prometheus 90 minutes, Titan 60; mutkit rules). The platform's", "# verifier gets roughly 1 to 1.5 CPUs, fewer than mutkit check uses:", "# size this and build_timeout_sec for one CPU (check warns when not).", `timeout_sec = ${kind === "binary" ? 60 : 180}`, "build_timeout_sec = 600", ""), lines.join(`
`);
}
function runtimeFor(lang, program) {
  if (program === "python" && lang !== "python")
    return `# The program is a Python zipapp: it runs on this python3.
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*
`;
  if (program === "node" && !lang.startsWith("typescript"))
    return `# The program is a bundled Node entry point: it runs on this node (22).
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 && rm -rf /var/lib/apt/lists/*
COPY --from=node:22-bookworm-slim /usr/local/bin/node /usr/local/bin/node
`;
  if (program === "java")
    return `# The program is a runnable jar: it runs on this java (a JDK, the builder's JDK_IMAGE).
COPY --from=eclipse-temurin:21-jdk /opt/java/openjdk /opt/java/openjdk
ENV JAVA_HOME=/opt/java/openjdk PATH=/opt/java/openjdk/bin:$PATH
`;
  return "";
}
function programDockerfile(program, lang) {
  let text = PROGRAM_SPECS[program].dockerfile;
  return program === "python" && lang !== "python" ? text.replace("ARG PYTHON_IMAGE=python:3.12-slim-bookworm", "ARG PYTHON_IMAGE=python:3.11-slim-bookworm") : text;
}
function environmentDockerfile(lane, lang, program = null) {
  let spec = LANGUAGE_SPECS[lang], run = (lines) => lines.map((s) => `RUN ${s}`).join(`
`);
  if (lane === "prometheus")
    return `# The agent's image: the repository at the task's base with the removed
# tests taken out (tests/mutation/removal.patch), no .git.
# mutkit check builds it with that repository as its context.
FROM ${spec.image}
WORKDIR /app
# The scorer applies each mutant with patch(1).
RUN (command -v patch >/dev/null || (apt-get update && apt-get install -y --no-install-recommends patch && rm -rf /var/lib/apt/lists/*))
COPY . /app
${run(spec.setup)}
# Install the project's dependencies here: the verifier runs offline.
${run(spec.repoSetup)}
`;
  return `# The agent's image: the toolchain and test framework the tests need, and
# the spec. Never the program, its source, a binary of it, the mutants or
# the reference tests (mutkit leakage checks).
FROM ${spec.image}
${run(spec.setup)}
WORKDIR /app
${run([...spec.titanSetup ?? [], "mkdir -p /app/tests"])}
${runtimeFor(lang, program)}`;
}
function instructionMd(lane) {
  return lane === "prometheus" ? `<!-- The ticket: name the module, say why its coverage matters, and list the
missing scenarios in plain words, each a behaviour and when it happens.
Declare each scenario in task.toml as a [[scenarios]] table. Never name the
removed tests, a test file, or the implementation files or functions under
test, and say nothing about how the tests are graded. -->
` : TITAN_INSTRUCTION_MD;
}
var TITAN_INSTRUCTION_MD = `<!-- The program's specification, written the way its documentation would be.
Start each requirement's line with its own id, REQ-<section>.<n> (for
example "- REQ-3.2: ..."), each id stated once; <section> is the number of
the section it sits in. The program itself is not in your environment; it
is reachable at grading time through the BIN environment variable.

The bar: a black-box tester reads only this file. Every byte, position and
exit status a reference test asserts must follow from a numbered
requirement: state it, or have the test assert less. Rename, split or add
sections to fit the program (one per command or mode is fine); keep every
topic below covered. Replace every comment. -->

## 1. Command line

<!-- Every argument and option: what it does, its accepted values, its
default, and what happens when it repeats. -->

## 2. Input formats

<!-- What the program reads and from where: files, stdin, encodings, and
what it does with input it does not accept. -->

## 3. Output formats

<!-- The exact bytes: order, separators, quoting, spacing, case, the final
newline. Say whether output equals, starts with or only contains a text,
and which stream it goes to. A behaviour shown only by an example is not
stated: give the rule. -->

## 4. Exit status

<!-- Every exit status and when it is returned, success included. -->

## 5. Errors

<!-- Each error condition, the stream it is reported on and its message
(the exact text, or the part a test may rely on). -->

## 6. Edge cases

<!-- Empty input, boundaries, very long or unusual values, conflicting
options. -->

## 7. General rules

<!-- Rules that apply everywhere (line endings, the final newline, empty
input, encoding, behaviour shared by every mode or command) are
requirements too: each its own id. -->
`;
function taskToml(name, lane, _lang) {
  let edit = (what) => JSON.stringify(`${PLACEHOLDER_MARKER} ${what}`), laneFields = lane === "prometheus" ? `module = ${edit("The module whose tests were removed, e.g. src/billing")}` : `program = ${edit("The program under test")}
program_version = ${edit("The version the specification describes")}
program_type = ${edit(PROGRAM_TASK_TYPES.join(" | "))}`, scenarios = lane === "prometheus" ? `
# One table per scenario the ticket names (3 to 5). Every mutant id starts
# with the id of the scenario it breaks: tests/mutants/<scenario id>-<n>.patch.
[[scenarios]]
id = "replace-me"
description = ${edit("The behaviour, and when it happens")}
` : "";
  return `# ${name}: the task fields the upload carries into the task's task.toml.
[metadata]
display_title = ${edit("One-line title for this task")}
display_description = ${edit("One or two sentences describing what the tests must cover")}
difficulty = ${edit("easy | medium | hard")}
test_level = ${edit("unit | integration | acceptance")}
functionalities = [${edit("A behaviour the tests cover")}]
# The number of mutants this task carries.
mutant_count = 0
${laneFields}
${scenarios}`;
}
var SOLVE_SH = `#!/bin/bash
# The reference tests: every file under solution/files/ lands at the same path
# under the working directory.
set -euo pipefail
cp -R /solution/files/. /app/
`;
function mutantExample(lane) {
  return lane === "prometheus" ? {
    path: "tests/mutants/replace-me-1.patch",
    text: `--- a/src/replace_me.py
+++ b/src/replace_me.py
@@ -1,2 +1,2 @@
 def f(x):
-    return x + 1
+    return x - 1
`
  } : {
    path: "tests/program/mutants/REQ-1.1-1.patch",
    text: `--- a/src/main.rs
+++ b/src/main.rs
@@ -1,1 +1,1 @@
-fn main() { std::process::exit(0) }
+fn main() { std::process::exit(1) }
`
  };
}
function programNotes(program) {
  return `The hidden program (never in the agent's image).

${PROGRAM_SPECS[program].note}

- The source goes here, with its lock file. Leave out build output and .git.
- Each mutant is mutants/<id>.patch (unified, -p1 from this folder), named
  after the requirement it breaks. The verifier image builds the reference
  and every mutant once, with Dockerfile here; nothing is compiled while
  the verifier's clock runs.
- mutkit check builds it the same way, then runs your reference tests
  and an empty submission against every mutant with the network off.
`;
}

// app/projects/gold/lanes/mutation/kit/scaffold.ts
var TASK_NAME_RE = /^[a-z0-9][a-z0-9-]{2,62}$/;
function scaffoldFiles(input, platform) {
  let name = basename2(input.dir), spec = LANGUAGE_SPECS[input.lang], kind = input.lane === "prometheus" ? "repo" : "binary", example = mutantExample(input.lane), files = {
    "instruction.md": instructionMd(input.lane),
    "task.toml": taskToml(name, input.lane, input.lang),
    "environment/Dockerfile": environmentDockerfile(input.lane, input.lang, input.program),
    "solution/solve.sh": SOLVE_SH,
    [`solution/files/${spec.goldPath}`]: spec.goldTest(kind),
    "tests/test.sh": platform.testSh,
    "tests/mutation/score_mutants.py": platform.scorer,
    "tests/mutation/scoring.toml": scoringToml(input.lane, input.lang, input.programName),
    [example.path]: example.text
  };
  if (input.lane === "prometheus")
    files["tests/mutation/removal.patch"] = `# The diff that takes the tests out of the repository at the base
# (git diff of the removal; -p1 paths). mutkit check applies it.
`, files["tests/mutation/reference/.keep"] = "";
  else {
    let program = input.program ?? "rust";
    files["tests/program/Dockerfile"] = programDockerfile(program, input.lang), files["tests/program/NOTES.txt"] = programNotes(program);
  }
  return files;
}
function scaffold(input, platform) {
  if (!TASK_NAME_RE.test(basename2(input.dir)))
    throw Error("the folder name is the task name: lowercase letters, digits and hyphens, 3 to 63 characters");
  if (input.lane === "titan" && LANGUAGE_SPECS[input.lang].titanSetup === null)
    throw Error(`${input.lang} is not offered for Titan tests`);
  if (existsSync3(input.dir) && readdirSync2(input.dir).length > 0 && !input.force)
    throw Error(`${input.dir} is not empty (--force writes over the scaffold's files)`);
  let files = scaffoldFiles(input, platform);
  for (let [rel, text] of Object.entries(files)) {
    let abs = join4(input.dir, rel);
    if (mkdirSync3(dirname2(abs), { recursive: !0 }), writeFileSync3(abs, text), rel.endsWith(".sh"))
      chmodSync(abs, 493);
  }
  return Object.keys(files).sort();
}

// app/projects/gold/lanes/mutation/kit/cli.ts
var VALUED = /* @__PURE__ */ new Set([
  "--lane",
  "--lang",
  "--program",
  "--program-name",
  "--repo",
  "--ref",
  "--out"
]);
function flag(argv, name) {
  let i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] ?? null : null;
}
function has(argv, name) {
  return argv.includes(`--${name}`);
}
function positional(argv) {
  for (let i = 0;i < argv.length; i += 1) {
    let a = argv[i];
    if (VALUED.has(a)) {
      i += 1;
      continue;
    }
    if (!a.startsWith("--"))
      return a;
  }
  return null;
}
function loadRules(home) {
  let path = join5(home.lib, "rules.json");
  return existsSync4(path) ? { ...DEFAULT_RULES, ...JSON.parse(readFileSync6(path, "utf8")) } : DEFAULT_RULES;
}
function platformFiles(home) {
  return {
    scorer: readFileSync6(join5(home.lib, "score_mutants.py"), "utf8"),
    testSh: readFileSync6(join5(home.lib, "test.sh"), "utf8")
  };
}
function usage() {
  return [
    "mutkit: write a Prometheus or Titan task on your machine, check it end to end and pack it.",
    "",
    ...MUTKIT_COMMANDS.map((c) => `  ${c.usage}
      ${c.summary}`)
  ].join(`
`);
}
function printFindings(findings) {
  for (let f of findings)
    console.log(`  ${f.level === "error" ? "ERROR  " : "warning"} [${f.code}] ${f.message}`);
}
function checkOptions(argv, home, extra = {}) {
  let repo = flag(argv, "repo");
  return {
    rules: loadRules(home),
    platform: platformFiles(home),
    repo: repo ? { path: resolve2(repo), ref: flag(argv, "ref") } : null,
    staticOnly: has(argv, "static"),
    leakage: !has(argv, "no-leakage"),
    native: has(argv, "native"),
    log: (line) => console.log(line),
    ...extra
  };
}
function cmdScaffold(argv, home) {
  let dir = positional(argv), lane = flag(argv, "lane"), lang = flag(argv, "lang") ?? "python", program = flag(argv, "program");
  if (!dir || !lane || !LANES.includes(lane) || !LANGUAGES.includes(lang))
    return console.error(MUTKIT_COMMANDS[0].usage), 2;
  if (program && !PROGRAM_LANGUAGES.includes(program))
    return console.error(`--program is one of ${PROGRAM_LANGUAGES.join(", ")}`), 2;
  let written = scaffold({
    dir: resolve2(dir),
    lane,
    lang,
    program: lane === "titan" ? program ?? "rust" : null,
    programName: flag(argv, "program-name") ?? "program",
    force: has(argv, "force")
  }, platformFiles(home));
  console.log(`scaffolded ${basename3(resolve2(dir))} (${lane}, ${lang}):`);
  for (let f of written)
    console.log(`  ${f}`);
  return 0;
}
async function cmdCheck(argv, home) {
  let dir = positional(argv);
  if (!dir)
    return console.error(MUTKIT_COMMANDS[1].usage), 2;
  let opts = checkOptions(argv, home), report = await checkTask(resolve2(dir), opts);
  if (console.log(""), report.rows.length)
    console.log("kill matrix (reference run):"), console.log(formatMatrix(report.rows, report.lane)), console.log("");
  if (Object.keys(report.timings).length) {
    if (console.log(`timings (s): ${Object.entries(report.timings).map(([k, v]) => `${k === "gold_sec" ? "reference_sec" : k}=${v}`).join("  ")}`), report.timings.gold_sec !== void 0)
      console.log(`  reference run ${report.timings.gold_sec}s of the verifier's ${laneRules(opts.rules, report.lane === "titan" ? "titan" : "prometheus").verifierTimeoutSec}s limit`);
  }
  printFindings(report.findings);
  let errors = report.findings.filter((f) => f.level === "error").length;
  return console.log(errors ? `
${errors} error(s).` : `
no errors.`), errors ? 1 : 0;
}
async function cmdBaseline(argv, home) {
  let dir = positional(argv);
  if (!dir)
    return console.error(MUTKIT_COMMANDS[2].usage), 2;
  let dest = await writeBaseline(resolve2(dir), checkOptions(argv, home));
  return console.log(`wrote ${dest}`), 0;
}
async function cmdLeakage(argv, home) {
  let dir = positional(argv);
  if (!dir)
    return console.error(MUTKIT_COMMANDS[3].usage), 2;
  let findings = await leakageOnly(resolve2(dir), checkOptions(argv, home));
  printFindings(findings);
  let errors = findings.filter((f) => f.level === "error").length;
  return console.log(errors ? `${errors} leak(s).` : "no leaks found."), errors ? 1 : 0;
}
function cmdPack(argv, home) {
  let dir = positional(argv);
  if (!dir)
    return console.error(MUTKIT_COMMANDS[4].usage), 2;
  let abs = resolve2(dir), rules = loadRules(home), findings = staticChecks(readTask(abs), rules, platformFiles(home));
  if (printFindings(findings), findings.some((f) => f.level === "error"))
    return console.error("fix the errors before packing."), 1;
  let lastPath = join5(abs, KIT_LOCAL_DIR, "check-report.json"), last = existsSync4(lastPath) ? JSON.parse(readFileSync6(lastPath, "utf8")) : null;
  if (!last)
    console.log("  warning: no mutkit check report yet; run mutkit check first");
  let { zip, files } = packTask(abs, rules, findings, last), out = flag(argv, "out") ?? join5(abs, KIT_LOCAL_DIR, `${basename3(abs)}.zip`);
  return mkdirSync4(dirname3(out), { recursive: !0 }), writeFileSync4(out, zip), console.log(`packed ${files.length} file(s), ${(zip.length / 1024).toFixed(0)} KB -> ${out}`), 0;
}
async function runCli(argv, home) {
  let [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case "scaffold":
        return cmdScaffold(rest, home);
      case "check":
        return await cmdCheck(rest, home);
      case "baseline":
        return await cmdBaseline(rest, home);
      case "leakage":
        return await cmdLeakage(rest, home);
      case "pack":
        return cmdPack(rest, home);
      case "rules":
        return console.log(JSON.stringify(loadRules(home), null, 2)), 0;
      default:
        return console.log(usage()), cmd && cmd !== "--help" && cmd !== "help" ? 2 : 0;
    }
  } catch (e) {
    return console.error(`mutkit: ${e.message}`), 1;
  }
}

// app/projects/gold/lanes/mutation/kit/entry.ts
var here = dirname4(fileURLToPath(import.meta.url)), lib = existsSync5(join6(here, "score_mutants.py")) ? here : join6(here, "..", "verifier");
runCli(process.argv.slice(2), { lib }).then((code) => {
  process.exitCode = code;
});
