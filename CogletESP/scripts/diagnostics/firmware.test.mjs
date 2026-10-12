import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { prepareFiles, RawReplConnection, createUploadPlan, uploadFiles, MAX_FILE_BYTES, MAX_TOTAL_BYTES } from "./firmware.js";

const encode = text => new TextEncoder().encode(text);
const file = (name, text) => {
  const bytes = encode(text);
  return { name, size: bytes.length, arrayBuffer: async () => bytes.buffer };
};

function serialPort({ platform = "rp2", error = "", fragment = true } = {}) {
  let controller;
  let source = "";
  let raw = false;
  const commands = [];
  const emit = text => {
    if (fragment) {
      for (const character of text) controller.enqueue(encode(character));
    } else controller.enqueue(encode(text));
  };
  return {
    commands,
    closed: false,
    async open() {
      this.readable = new ReadableStream({ start(value) { controller = value; } });
      this.writable = new WritableStream({
        write(bytes) {
          for (const character of new TextDecoder().decode(bytes)) {
            if (character === "\x01") {
              raw = true;
              source = "";
              emit("raw REPL; CTRL-B to exit\r\n>");
            } else if (character === "\x03") source = "";
            else if (raw && character === "\x04") {
              commands.push(source);
              const output = source.includes("sys.platform") ? `micropython\r\n${platform}\r\n` : source.includes("print('test')") ? "test\r\n" : "";
              source = "";
              emit(`OK${output}\x04${error && commands.length > 2 ? error : ""}\x04>`);
            } else if (raw) source += character;
          }
        },
      });
    },
    end() { controller.close(); },
    async close() { this.closed = true; },
  };
}

test("file selection preserves bytes, hashes them, and installs main.py last", async () => {
  const files = await prepareFiles([file("main.py", "# main\n"), file("animation.py", "# animation\n"), file("diagnostics_control.py", "# control\n")]);
  assert.deepEqual(files.map(value => value.name), ["animation.py", "diagnostics_control.py", "main.py"]);
  assert.equal(new TextDecoder().decode(files[2].bytes), "# main\n");
  assert.match(files[0].hash, /^[a-f0-9]{64}$/);
});

test("rejects unsafe names, duplicates, empty, malformed and oversized selections", async () => {
  for (const name of ["../main.py", "sub\\main.py", "evil');exec.py", "main.txt", "main.py.py", "a".repeat(65) + ".py"]) {
    await assert.rejects(prepareFiles([file(name, "# x")]), /filename/);
  }
  await assert.rejects(prepareFiles([file("main.py", "")]), /nonempty/);
  await assert.rejects(prepareFiles([file("main.py", "a"), file("main.py", "b")]), /Duplicate/);
  await assert.rejects(prepareFiles([]), /between/);
  await assert.rejects(prepareFiles(Array.from({ length: 17 }, (_, i) => file(`f${i}.py`, "# x"))), /between/);
  await assert.rejects(prepareFiles([file("main.py", "x".repeat(MAX_FILE_BYTES + 1))]), /96 KiB/);
  await assert.rejects(prepareFiles(Array.from({ length: 3 }, (_, i) => file(`f${i}.py`, "x".repeat(MAX_FILE_BYTES)))), /256 KiB/);
  await assert.rejects(prepareFiles([{ name: "main.py", size: 1, arrayBuffer: async () => new Uint8Array([255]).buffer }]), /encoded data/);
  await assert.rejects(prepareFiles([file("main.py", "\0")]), /null bytes/);
});

test("accepts exact size thresholds", async () => {
  const files = await prepareFiles([file("a.py", "a".repeat(MAX_FILE_BYTES)), file("b.py", "b".repeat(MAX_FILE_BYTES)), file("c.py", "c".repeat(MAX_TOTAL_BYTES - 2 * MAX_FILE_BYTES))]);
  assert.equal(files.reduce((sum, value) => sum + value.bytes.length, 0), MAX_TOTAL_BYTES);
});

test("raw REPL tolerates fragmented frames, interrupts once, verifies identity and disables PWM", async () => {
  const port = serialPort();
  const repl = new RawReplConnection();
  await repl.open(port);
  assert.equal(await repl.exec("print('test')"), "test");
  assert.match(port.commands[1], /Pin\(8, Pin.OUT, value=1\)/);
  assert.equal(port.commands.some(command => !command.trim()), false, "never soft-reboot using an empty raw command");
  await repl.close();
  await repl.close();
  assert.equal(port.closed, true);
});

test("wrong MCU is rejected before GPIO or filesystem writes", async () => {
  const port = serialPort({ platform: "esp32" });
  const repl = new RawReplConnection();
  await assert.rejects(repl.open(port), /Not RP2040/);
  assert.equal(port.commands.length, 1);
  await repl.close();
});

test("failed port opening never closes a port owned by another session", async () => {
  let closed = false;
  const repl = new RawReplConnection();
  await assert.rejects(repl.open({ open: async () => { throw new Error("already open"); }, close: async () => { closed = true; } }), /already open/);
  await repl.close();
  assert.equal(closed, false);
});

test("device exceptions are surfaced and the next REPL prompt is fully consumed", async () => {
  const port = serialPort({ error: "OSError: no space\r\n", fragment: false });
  const repl = new RawReplConnection();
  await repl.open(port);
  await assert.rejects(repl.exec("raise OSError('no space')"), /no space/);
  assert.equal(repl.buffer, "");
  await repl.close();
});

test("disconnect rejects pending reads and reports a recovery warning", async () => {
  let failure;
  const port = serialPort();
  const repl = new RawReplConnection(error => { failure = error; });
  await repl.open(port);
  const waiting = repl.until("missing");
  const rejected = assert.rejects(waiting, /disconnected/);
  port.end();
  await rejected;
  assert.match(failure.message, /Keep servo power off/);
  await repl.close();
});

test("a bounded REPL timeout poisons the connection instead of retrying writes", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const repl = new RawReplConnection();
  const rejected = assert.rejects(repl.until("missing"), /timed out/);
  context.mock.timers.tick(10000);
  await rejected;
  await assert.rejects(repl.write("print('unsafe retry')"), /timed out/);
});

function executeScripts(scripts, initial = {}, options = {}) {
  const result = spawnSync("python", ["-B", fileURLToPath(new URL("./firmware_fixture.py", import.meta.url))], {
    input: JSON.stringify({ scripts, initial, ...options }), encoding: "utf-8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

async function planFixture(selected) {
  const files = await prepareFiles(selected);
  const plan = createUploadPlan(files, "0123456789abcdef");
  const scripts = [plan.begin];
  for (const item of files) {
    scripts.push(plan.start(item.name));
    for (let offset = 0; offset < item.bytes.length; offset += 768) {
      scripts.push(plan.chunk(item.name, item.bytes.slice(offset, offset + 768)));
    }
    scripts.push(plan.verify(item.name));
  }
  return { plan, scripts, files };
}

test("generated scripts preserve backups, verify real bytes and replace main.py last", async () => {
  const { plan, scripts, files } = await planFixture([file("main.py", "# new main\n"), file("helper.py", "print('not executed')\n")]);
  const result = executeScripts([...scripts, plan.commit], { "main.py": "# old main\n", "servoclass.py": "# calibrated\n" });
  assert.equal(result.error, null);
  assert.equal(result.files["main.py"], "# new main\n");
  assert.equal(result.files["servoclass.py"], "# calibrated\n");
  assert.equal(result.files[`${plan.folder.slice(1)}/main.py.bak`], "# old main\n");
  assert.equal(result.outputs[3], files[0].hash);
  assert.deepEqual(JSON.parse(result.outputs.at(-1)).installed, ["helper.py", "main.py"]);
  assert.equal(result.renames.at(-1)[1], "/main.py");
  assert.equal(result.outputs.includes("not executed"), false);
});

test("the actual diagnostics firmware passes chunked transfer, SHA and syntax checks without running it", async () => {
  const selected = ["main.py", "animation.py", "diagnostics_control.py"].map(name =>
    file(name, readFileSync(new URL(`../../RP2040/${name}`, import.meta.url), "utf8")));
  const { plan, scripts, files } = await planFixture(selected);
  const result = executeScripts([...scripts, plan.commit]);
  assert.equal(result.error, null);
  for (const source of files) {
    assert.equal(result.files[source.name], new TextDecoder().decode(source.bytes).replaceAll("\r\n", "\n"));
    assert.ok(result.outputs.includes(source.hash), `${source.name} hash must survive chunked writes`);
  }
  assert.deepEqual(JSON.parse(result.outputs.at(-1)).installed, ["animation.py", "diagnostics_control.py", "main.py"]);
});

test("staging syntax or storage failures do not replace any root files", async () => {
  const invalid = await planFixture([file("main.py", "def broken(:\n")]);
  const syntax = executeScripts([...invalid.scripts, invalid.plan.commit], { "main.py": "# old\n" });
  assert.match(syntax.error, /SyntaxError/);
  assert.equal(syntax.files["main.py"], "# old\n");
  assert.equal(syntax.renames.length, 0);
  const valid = await planFixture([file("main.py", "# new\n")]);
  const storage = executeScripts([...valid.scripts, valid.plan.commit], { "main.py": "# old\n" }, { freeBytes: 0 });
  assert.match(storage.error, /Not enough free flash/);
  assert.deepEqual(storage.files, { "main.py": "# old\n" });
});

test("replacement error rolls back both existing and newly introduced files", async () => {
  const { scripts, plan } = await planFixture([file("main.py", "# new main\n"), file("helper.py", "# new helper\n")]);
  const result = executeScripts([...scripts, plan.commit], { "main.py": "# old main\n" }, { failRenameTo: "/main.py" });
  assert.match(result.error, /previous files restored/);
  assert.equal(result.files["main.py"], "# old main\n");
  assert.equal(result.files["helper.py"], undefined);
  assert.equal(result.files[`${plan.folder.slice(1)}/helper.py.new`], "# new helper\n");
});

test("failed backup rename leaves the original root file untouched", async () => {
  const { scripts, plan } = await planFixture([file("main.py", "# new main\n")]);
  const result = executeScripts([...scripts, plan.commit], { "main.py": "# original\n" }, { failRenameTo: `${plan.folder}/main.py.bak` });
  assert.match(result.error, /previous files restored/);
  assert.equal(result.files["main.py"], "# original\n");
  assert.equal(result.files[`${plan.folder.slice(1)}/main.py.new`], "# new main\n");
});

test("rollback failure is explicit and leaves the original in its recovery folder", async () => {
  const { scripts, plan } = await planFixture([file("main.py", "# new main\n")]);
  const result = executeScripts([...scripts, plan.commit], { "main.py": "# original\n" }, { failRenameTo: "/main.py", failAllMatchingRenames: true });
  assert.match(result.error, /rollback incomplete/);
  assert.equal(result.files[`${plan.folder.slice(1)}/main.py.bak`], "# original\n");
});

test("unique backup folders are never overwritten and directory destinations are rejected", async () => {
  const { scripts, plan } = await planFixture([file("main.py", "# new\n")]);
  const collision = executeScripts([...scripts, plan.commit], { [`${plan.folder.slice(1)}/main.py.bak`]: "# earlier backup\n", "main.py": "# old\n" });
  assert.match(collision.error, /FileExistsError/);
  assert.equal(collision.files[`${plan.folder.slice(1)}/main.py.bak`], "# earlier backup\n");
  assert.equal(collision.files["main.py"], "# old\n");
  const directory = executeScripts(scripts, {}, { directories: ["main.py"] });
  assert.match(directory.error, /not a regular file/);
});

test("SHA mismatch stops the upload before any replacement script", async () => {
  const files = await prepareFiles([file("main.py", "# new\n")]);
  const commands = [];
  const repl = { exec: async source => {
    commands.push(source);
    if (source.includes("a2b_base64")) return String(files[0].bytes.length);
    if (source.includes("hexlify")) return "0".repeat(64);
    return "";
  } };
  await assert.rejects(uploadFiles(repl, files), /SHA-256.*No root files were replaced.*Upload folder/s);
  assert.equal(commands.some(source => source.includes("os.rename")), false);
});

test("short writes are rejected before verification or replacement", async () => {
  const files = await prepareFiles([file("main.py", "# new\n")]);
  const commands = [];
  await assert.rejects(uploadFiles({ exec: async source => {
    commands.push(source);
    return source.includes("a2b_base64") ? "1" : "";
  } }, files), /complete chunk.*No root files were replaced/s);
  assert.equal(commands.some(source => source.includes("hexlify") || source.includes("os.rename")), false);
});

test("multiple chunks and all file checks finish before replacement", async () => {
  const files = await prepareFiles([file("main.py", "# " + "m".repeat(1600)), file("helper.py", "# " + "h".repeat(1600))]);
  const commands = [];
  const staged = new Map();
  const repl = { exec: async source => {
    commands.push(source);
    if (source.includes("a2b_base64")) {
      const name = source.match(/\/([A-Za-z0-9_]+\.py)\.new/)[1];
      const bytes = Buffer.from(source.match(/a2b_base64\("([^"]+)"\)/)[1], "base64");
      assert.ok(bytes.length <= 768);
      staged.set(name, Buffer.concat([staged.get(name) || Buffer.alloc(0), bytes]));
      return String(bytes.length);
    }
    if (source.includes("hexlify")) {
      const name = source.match(/\/([A-Za-z0-9_]+\.py)\.new/)[1];
      const expected = files.find(item => item.name === name);
      assert.deepEqual(new Uint8Array(staged.get(name)), expected.bytes);
      return expected.hash;
    }
    if (source.includes("os.rename")) {
      assert.equal(commands.filter(value => value.includes("hexlify")).length, files.length);
      return JSON.stringify({ installed: files.map(item => item.name), backups: [] });
    }
    return "";
  } };
  await uploadFiles(repl, files);
  assert.equal(commands.filter(source => source.includes("a2b_base64")).length, 6);
});

test("successful upload requires an exact receipt and reports backup locations", async () => {
  const files = await prepareFiles([file("main.py", "# new\n")]);
  let folder;
  const progress = [];
  const repl = { exec: async source => {
    if (source.includes("os.mkdir")) folder = source.match(/\/_coglet_upload_[a-f0-9]+/)[0];
    if (source.includes("a2b_base64")) return String(files[0].bytes.length);
    if (source.includes("hexlify")) return files[0].hash;
    if (source.includes("os.rename")) return JSON.stringify({ installed: ["main.py"], backups: [`${folder}/main.py.bak`] });
    return "";
  } };
  const receipt = await uploadFiles(repl, files, value => progress.push(value));
  assert.deepEqual(receipt.backups, [`${folder}/main.py.bak`]);
  assert.equal(progress.at(-1).transferred, files[0].bytes.length);
  repl.exec = async source => source.includes("a2b_base64") ? String(files[0].bytes.length) : source.includes("hexlify") ? files[0].hash : source.includes("os.rename") ? '{"installed":[],"backups":[]}' : "";
  await assert.rejects(uploadFiles(repl, files), /invalid installation receipt.*Replacement was attempted/s);
});
