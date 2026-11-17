import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  fetchCloudCodeModels,
  invalidateModelMetadataCache,
  isReasoningModel,
  resolveModelMetadata,
} from "./model-metadata.mjs"

const require = createRequire(import.meta.url)
let DatabaseSync = null
try { ({ DatabaseSync } = require("node:sqlite")) } catch {}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-bridge-fixes-"))
const prevStoredSignIn = process.env.AGY_BRIDGE_STORED_SIGNIN
process.env.AGY_BRIDGE_STORED_SIGNIN = "skip"
after(() => {
  if (prevStoredSignIn === undefined) delete process.env.AGY_BRIDGE_STORED_SIGNIN
  else process.env.AGY_BRIDGE_STORED_SIGNIN = prevStoredSignIn
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  setTimeout(() => process.exit(process.exitCode || 0), 30)
})

const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`

function writeFakeAgy(dir, scriptBody) {
  fs.mkdirSync(dir, { recursive: true })
  const fakeScript = path.join(dir, "agy.mjs")
  fs.writeFileSync(fakeScript, scriptBody)
  if (process.platform === "win32") {
    const fakeBin = path.join(dir, "agy.cmd")
    fs.writeFileSync(fakeBin, `@echo off\r\n"${process.execPath}" "${fakeScript}" %*\r\n`)
    return fakeBin
  }
  const fakeBin = path.join(dir, "agy")
  fs.writeFileSync(fakeBin, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fakeScript)} "$@"\n`, { mode: 0o755 })
  return fakeBin
}

function createCompatBridge() {
  const dir = path.join(root, "compat")
  fs.mkdirSync(dir, { recursive: true })
  const entry = new URL("./index.mjs", import.meta.url)
  let source = fs.readFileSync(entry, "utf8")
  source = source.replace(/from "(\.\/[^"\n]+)"/g, (_, target) => `from ${JSON.stringify(new URL(target, entry).href)}`)
  source = source.replace('new URL("./package.json", import.meta.url)', JSON.stringify(fileURLToPath(new URL("./package.json", entry))))
  source += "\nexport { Turn, Proc, responseUsage, allProcs };\n"
  const out = path.join(dir, "bridge.mjs")
  fs.writeFileSync(out, source)
  return out
}

test("CloudCode model metadata sets real context, output, image capabilities, and reasoning", async () => {
  const accountsDir = path.join(root, "accounts-cloud")
  const namedDir = path.join(accountsDir, "alpha")
  fs.mkdirSync(path.join(namedDir, "antigravity-cli"), { recursive: true })
  fs.writeFileSync(
    path.join(namedDir, "antigravity-cli", "antigravity-oauth-token"),
    JSON.stringify({ token: { access_token: "test-cloudcode-token" } }),
  )

  let metadataRequests = 0
  const server = http.createServer((req, res) => {
    metadataRequests++
    if (req.url === "/v1internal:loadCodeAssist") {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ cloudaicompanionProject: "proj-test" }))
      return
    }
    if (req.url === "/v1internal:fetchAvailableModels") {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({
        models: {
          "gemini-3.8-flash-tiered": { maxTokens: 1_048_576, maxOutputTokens: 65_536, supportsImages: true },
          "claude-opus-5-5-low": { maxTokens: 1_000_000, maxOutputTokens: 128_000, supportsImages: true },
          "claude-opus-5-5-high": { maxTokens: 1_000_000, maxOutputTokens: 128_000, supportsImages: true },
          "claude-opus-4-6-thinking": { maxTokens: 250_000, maxOutputTokens: 64_000, supportsImages: true },
          "gemini-3.1-flash-image": { maxTokens: 65_536, maxOutputTokens: 65_536, supportsImages: true },
          "gpt-oss-120b-medium": { maxTokens: 131_072, maxOutputTokens: 32_768, supportsImages: false },
        },
      }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const port = server.address().port

  const fakeDir = path.join(root, "fake-cloud-agy")
  const fakeBin = writeFakeAgy(fakeDir, `
const args = process.argv.slice(2);
if (args.includes("--help")) process.exit(0);
if (args.includes("models")) {
  console.log([
    "gemini-3.8-flash-low Gemini 3.8 Flash (low)",
    "gemini-3.8-flash-high Gemini 3.8 Flash (high)",
    "gemini-pro-orchestrator Orchestrator (Carbon)",
    "claude-opus-5-5-low Claude Opus 5.5 (low)",
    "claude-opus-5-5-high Claude Opus 5.5 (high)",
    "claude-opus-4-6-thinking Claude Opus 4.6 (Thinking)",
    "gemini-3.1-flash-image Gemini 3.1 Flash Image",
    "gpt-oss-120b-medium GPT-OSS 120B (Medium)",
  ].join("\\n"));
  process.exit(0);
}
if (args.includes("acp")) {
  process.stdin.setEncoding("utf8");
  let buf = "";
  process.stdin.on("data", chunk => {
    buf += chunk;
    const lines = buf.split("\\n");
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.method === "initialize") {
        console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } } } }));
      } else if (msg.method === "session/new") {
        console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-1" } }));
      } else if (msg.method === "session/set_model" || msg.method === "session/set_config_option") {
        console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
      } else if (msg.method === "session/prompt") {
        console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } }));
      }
    }
  });
}
`)

  const prev = {
    AGY_PATH: process.env.AGY_PATH,
    AGY_BRIDGE_ACCOUNTS_DIR: process.env.AGY_BRIDGE_ACCOUNTS_DIR,
    AGY_BRIDGE_CLOUDCODE_URL: process.env.AGY_BRIDGE_CLOUDCODE_URL,
    AGY_BRIDGE_USAGE: process.env.AGY_BRIDGE_USAGE,
  }
  process.env.AGY_PATH = fakeBin
  process.env.AGY_BRIDGE_ACCOUNTS_DIR = accountsDir
  process.env.AGY_BRIDGE_CLOUDCODE_URL = `http://127.0.0.1:${port}`
  process.env.AGY_BRIDGE_USAGE = "0"
  invalidateModelMetadataCache()

  try {
    const cloud = await fetchCloudCodeModels({ key: "dir:" + namedDir, dir: namedDir }, fakeBin, true)
    assert.equal(cloud.hasCredentials, true)
    assert.deepEqual(resolveModelMetadata("gemini-3.8-flash", cloud), {
      context: 1_048_576,
      output: 65_536,
      supportsImages: true,
    })
    assert.equal(isReasoningModel("gemini-pro-orchestrator", undefined), true)
    assert.equal(isReasoningModel("gpt-oss-120b-medium", undefined), false)

    const { AntigravityBridgePlugin } = await import(`./index.mjs?fixes-cloud=${Date.now()}`)
    const plugin = await AntigravityBridgePlugin()
    const models = await plugin.provider.models(plugin.provider, {})

    assert.equal(models["alpha/gemini-3.8-flash"]?.limit.context, 512_000)
    assert.equal(models["alpha/gemini-3.8-flash"]?.limit.output, 65_536)
    assert.equal(models["alpha/claude-opus-5-5"]?.limit.context, 512_000)
    assert.equal(models["alpha/claude-opus-5-5"]?.limit.output, 128_000)
    assert.equal(models["alpha/claude-opus-4-6-thinking"]?.limit.context, 250_000)
    assert.equal(models["alpha/claude-opus-4-6-thinking"]?.limit.output, 64_000)
    assert.equal(models["alpha/claude-opus-4-6-thinking"]?.reasoning, true)
    assert.equal(models["alpha/gemini-pro-orchestrator"]?.reasoning, true)
    assert.equal(models["alpha/gemini-pro-orchestrator"]?.limit.context, 512_000)
    assert.equal(models["alpha/gemini-pro-orchestrator"]?.limit.output, 262_144)
    assert.equal(models["alpha/gemini-3.1-flash-image"]?.limit.context, 65_536)
    assert.equal(models["alpha/gpt-oss-120b-medium"]?.limit.context, 131_072)
    assert.equal(models["alpha/gpt-oss-120b-medium"]?.limit.output, 32_768)
    assert.equal(models["alpha/gpt-oss-120b-medium"]?.capabilities?.attachment, undefined)
    const requestsAfterDiscovery = metadataRequests
    await plugin.provider.models(plugin.provider, {})
    assert.equal(metadataRequests, requestsAfterDiscovery, "catalog refresh reuses unexpired account metadata")
  } finally {
    invalidateModelMetadataCache()
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await new Promise(resolve => server.close(resolve))
  }
})

test("silent failures and 0-model-step SQLite errors never return fake HTTP 200", { skip: !DatabaseSync }, async () => {
  const convDir = path.join(root, "conv-silent")
  const accountsDir = path.join(root, "accounts-silent")
  const stateFile = path.join(root, "state-silent.json")
  fs.mkdirSync(convDir, { recursive: true })
  fs.mkdirSync(accountsDir, { recursive: true })

  const dbPath = path.join(convDir, "sess-zero-step.db")
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE steps (
      step_index INTEGER PRIMARY KEY,
      step_type INTEGER NOT NULL,
      status INTEGER NOT NULL,
      payload BLOB NOT NULL
    );
    CREATE TABLE gen_metadata (
      idx INTEGER PRIMARY KEY,
      payload BLOB NOT NULL
    );
  `)
  db.prepare("INSERT INTO steps VALUES (0, 14, 3, ?)").run(Buffer.from("user"))
  db.prepare("INSERT INTO steps VALUES (1, 17, 7, ?)").run(Buffer.from("err"))
  db.prepare("INSERT INTO gen_metadata VALUES (0, ?)").run(Buffer.from([0x28, 0xd8, 0x9c, 0x05]))
  db.close()

  const fakeDir = path.join(root, "fake-silent-agy")
  const fakeBin = writeFakeAgy(fakeDir, `
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
if (args.includes("--help")) process.exit(0);
if (args.includes("models")) {
  console.log("gemini-test-medium Gemini Test (medium)");
  process.exit(0);
}
const logIndex = args.indexOf("--log-file");
const logFile = logIndex >= 0 ? args[logIndex + 1] : null;
let count = 0;
process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", chunk => {
  buf += chunk;
  const lines = buf.split("\\n");
  buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } } } }));
    } else if (msg.method === "session/new") {
      count++;
      const sessionId = count === 3 ? "sess-zero-step" : "sess-silent-" + count;
      console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId } }));
    } else if (msg.method === "session/set_model" || msg.method === "session/set_config_option") {
      console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
    } else if (msg.method === "session/prompt") {
      const text = JSON.stringify(msg.params?.prompt || []);
      const sessionId = msg.params?.sessionId;
      if (text.includes("SILENT_LOG_EMPTY")) {
        if (logFile) fs.appendFileSync(logFile, "E] agent executor error: RESOURCE_EXHAUSTED (code 429): upstream rejected request\\n");
      } else if (text.includes("ZERO_MODEL_STEP_PROSE")) {
        if (sessionId && process.env.AGY_BRIDGE_CONVERSATIONS_DIR) {
          fs.copyFileSync(path.join(process.env.AGY_BRIDGE_CONVERSATIONS_DIR, "sess-zero-step.db"), path.join(process.env.AGY_BRIDGE_CONVERSATIONS_DIR, sessionId + ".db"));
        }
        if (logFile) fs.appendFileSync(logFile, "E] agent executor error: QUOTA_EXHAUSTED (code 429): quota exhausted\\n");
        console.log(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Retrying request without producing an upstream model step yet." } } } }));
      }
      console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } }));
    }
  }
});
`)

  const prev = {
    AGY_PATH: process.env.AGY_PATH,
    AGY_BRIDGE_CONVERSATIONS_DIR: process.env.AGY_BRIDGE_CONVERSATIONS_DIR,
    AGY_BRIDGE_ACCOUNTS_DIR: process.env.AGY_BRIDGE_ACCOUNTS_DIR,
    AGY_BRIDGE_STATE_FILE: process.env.AGY_BRIDGE_STATE_FILE,
    AGY_BRIDGE_USAGE: process.env.AGY_BRIDGE_USAGE,
  }
  process.env.AGY_PATH = fakeBin
  process.env.AGY_BRIDGE_CONVERSATIONS_DIR = convDir
  process.env.AGY_BRIDGE_ACCOUNTS_DIR = accountsDir
  process.env.AGY_BRIDGE_STATE_FILE = stateFile
  process.env.AGY_BRIDGE_USAGE = "0"

  try {
    const { AntigravityBridgePlugin } = await import(`./index.mjs?fixes-silent=${Date.now()}`)
    const plugin = await AntigravityBridgePlugin()
    const loader = await plugin.auth.loader()
    const send = (userId, content) => loader.fetch("agy://local/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "gemini-test",
        stream: false,
        metadata: { user_id: userId },
        messages: [{ role: "user", content }],
      }),
    })

    const res1 = await send("u-silent-log", "SILENT_LOG_EMPTY")
    const body1 = await res1.json()
    assert.equal(res1.status, 429, JSON.stringify(body1))
    assert.ok(body1.error, JSON.stringify(body1))

    const res2 = await send("u-silent-empty", "SILENT_NO_LOG_EMPTY")
    const body2 = await res2.json()
    assert.equal(res2.status, 502, JSON.stringify(body2))
    assert.match(body2.error?.message || "", /without producing a model response/)

    const res3 = await send("u-zero-step", "ZERO_MODEL_STEP_PROSE")
    const body3 = await res3.json()
    assert.equal(res3.status, 429, JSON.stringify(body3))
    assert.equal(body3.error?.code, "AGY_ERROR_QUOTA_EXHAUSTED")
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
})

test("responseUsage does not fabricate 1 token on empty output or zero estimate", async () => {
  const compatPath = createCompatBridge()
  const { Turn, Proc, responseUsage, allProcs } = await import(pathToFileURL(compatPath).href)
  const proc = new Proc("unused-agy", "usage-floor-test", { tools: [], messages: [{ role: "user", content: "" }] })
  proc.stopping = true
  proc.expectedMessages = [{ role: "user", content: "" }]
  const turn = new Turn(proc, proc.expectedMessages)
  proc.turn = turn
  try {
    const step = turn.registerResponse({ messages: proc.expectedMessages })
    turn.stepInputEstimates[step.estimateIndex] = 0
    step.inputEstimate = 0
    const emptyUsage = responseUsage(proc, turn, step, [])
    assert.equal(emptyUsage.input_tokens, 0)
    assert.equal(emptyUsage.output_tokens, 0)

    const toolUsage = responseUsage(proc, turn, step, [{
      type: "tool_use",
      id: "call_1",
      name: "read_file",
      input: { path: "/Users/example/project/very/long/file/name/for/estimation.ts", start_line: 1, end_line: 200 },
    }])
    assert.ok(toolUsage.output_tokens > 10, `expected tool_use output estimate > 10, got ${toolUsage.output_tokens}`)
  } finally {
    proc.finalizeTurn(turn)
    allProcs.delete(proc)
  }
})

test("streamErrorOf marks invalid_request_error with status 400, permission_error with status 403, and preserves metadata", async () => {
  const { streamErrorOf } = await import(`./index.mjs?fixes-err=${Date.now()}`)
  const invalid = streamErrorOf({ kind: "invalid_request_error", message: "code 429 turned away", code: "bad_prompt", retryable: false })
  assert.deepEqual(invalid, { type: "invalid_request_error", message: "code 429 turned away", status: 400, code: "bad_prompt", retryable: false })
  const forbidden = streamErrorOf({ kind: "permission_error", message: "disabled in this account", code: "AGY_ERROR_FORBIDDEN", retryable: false })
  assert.deepEqual(forbidden, { type: "permission_error", message: "disabled in this account", status: 403, code: "AGY_ERROR_FORBIDDEN", retryable: false })
  const quota = streamErrorOf({ kind: "rate_limit_error", message: "quota", code: "rate_limit", retryable: true, retryAfterMs: 3000 })
  assert.equal(quota.status, undefined)
  assert.equal(quota.retry_after_ms, 3000)
})

test("run_command avoids agy toolSummary collision, restores default argument, and preserves fellBack signal", async () => {
  const workRoot = path.join(root, "tool-summary-work")
  const accountsDir = path.join(root, "tool-summary-accounts")
  const stateFile = path.join(root, "tool-summary-state.json")
  const fakeDir = path.join(root, "fake-tool-summary-agy")
  const logFile = path.join(root, "tool-summary.jsonl")
  const fakeBin = writeFakeAgy(fakeDir, `
import fs from "node:fs";
import readline from "node:readline";
const args = process.argv.slice(2);
const logFile = process.env.FAKE_TS_LOG;
if (args.includes("--help")) process.exit(0);
if (args.includes("--version")) { console.log("1.5.9"); process.exit(0); }
if (args.includes("models")) {
  if (process.env.FAKE_MODELS_FAIL === "1") process.exit(1);
  console.log("gemini-test  Gemini Test");
  process.exit(0);
}
const sessionId = "s-ts";
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
function connectControl(payload, onReply) {
  return import("node:net").then((net) => new Promise((resolve, reject) => {
    const port = Number(process.env.AGY_BRIDGE_CONTROL_PORT);
    const token = process.env.AGY_BRIDGE_TOKEN;
    const sock = net.createConnection({ host: "127.0.0.1", port }, () => {
      sock.write(JSON.stringify({ token, ...payload }) + "\\n");
    });
    let buf = "";
    sock.on("data", chunk => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\\n");
      if (nl < 0) return;
      const msg = JSON.parse(buf.slice(0, nl));
      onReply?.(msg);
      resolve(msg);
      sock.destroy();
    });
    sock.on("error", reject);
  }));
}
readline.createInterface({ input: process.stdin }).on("line", async line => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } }, agentInfo: { name: "fake-agy", version: "1.5.9" } } });
  } else if (msg.method === "session/new") {
    await connectControl({ kind: "list" }, (reply) => fs.appendFileSync(logFile, JSON.stringify({ step: "list", msg: reply }) + "\\n"));
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId, models: { currentModelId: "gemini-test", availableModels: [{ modelId: "gemini-test", name: "Gemini Test" }] } } });
  } else if (msg.method === "session/prompt") {
    const callArgs = JSON.parse(process.env.FAKE_CALL_ARGS || "{}");
    void connectControl({ kind: "call", name: "run_command", arguments: callArgs }).catch(() => {});
  }
});
`)
  const prev = {
    AGY_PATH: process.env.AGY_PATH,
    AGY_BRIDGE_CONVERSATIONS_DIR: process.env.AGY_BRIDGE_CONVERSATIONS_DIR,
    AGY_BRIDGE_ACCOUNTS_DIR: process.env.AGY_BRIDGE_ACCOUNTS_DIR,
    AGY_BRIDGE_STATE_FILE: process.env.AGY_BRIDGE_STATE_FILE,
    AGY_BRIDGE_USAGE: process.env.AGY_BRIDGE_USAGE,
    FAKE_TS_LOG: process.env.FAKE_TS_LOG,
    FAKE_CALL_ARGS: process.env.FAKE_CALL_ARGS,
    FAKE_MODELS_FAIL: process.env.FAKE_MODELS_FAIL,
  }
  process.env.AGY_PATH = fakeBin
  process.env.AGY_BRIDGE_CONVERSATIONS_DIR = workRoot
  process.env.AGY_BRIDGE_ACCOUNTS_DIR = accountsDir
  process.env.AGY_BRIDGE_STATE_FILE = stateFile
  process.env.AGY_BRIDGE_USAGE = "0"
  process.env.FAKE_TS_LOG = logFile
  const schema = {
    type: "object",
    properties: { CommandLine: { type: "string" }, toolSummary: { type: "string" } },
    required: ["CommandLine", "toolSummary"],
  }
  try {
    const { AntigravityBridgePlugin } = await import(`./index.mjs?fixes-ts=${Date.now()}`)
    const plugin = await AntigravityBridgePlugin()
    assert.equal(await plugin.auth.cli.installed(), true)

    process.env.FAKE_MODELS_FAIL = "1"
    const fallbackModels = await plugin.provider.models()
    assert.equal(fallbackModels[Symbol.for("magpie.fellBack")], true)

    delete process.env.FAKE_MODELS_FAIL
    const liveModels = await plugin.provider.models()
    assert.equal(liveModels[Symbol.for("magpie.fellBack")], undefined)

    const loader = await plugin.auth.loader()
    process.env.FAKE_CALL_ARGS = JSON.stringify({ CommandLine: "pwd" })
    const res1 = await loader.fetch("agy://local/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "gemini-test",
        stream: false,
        metadata: { user_id: "u-ts-1" },
        tools: [{ name: "run_command", input_schema: schema }],
        messages: [{ role: "user", content: "run pwd" }],
      }),
    })
    const body1 = await res1.json()
    assert.equal(res1.status, 200, JSON.stringify(body1))
    assert.equal(body1.content.find(b => b.type === "tool_use")?.input?.toolSummary, "Run command")
    assert.deepEqual(schema.required, ["CommandLine", "toolSummary"])
    const listed = fs.readFileSync(logFile, "utf8").trim().split("\n").map(JSON.parse).find(e => e.step === "list")
    assert.deepEqual(listed.msg.result.tools[0].inputSchema.required, ["CommandLine"])

    process.env.FAKE_CALL_ARGS = JSON.stringify({ CommandLine: "pwd", toolSummary: "Show location" })
    const res2 = await loader.fetch("agy://local/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "gemini-test",
        stream: false,
        metadata: { user_id: "u-ts-2" },
        tools: [{ name: "run_command", input_schema: schema }],
        messages: [{ role: "user", content: "run pwd with summary" }],
      }),
    })
    const body2 = await res2.json()
    assert.equal(res2.status, 200, JSON.stringify(body2))
    assert.equal(body2.content.find(b => b.type === "tool_use")?.input?.toolSummary, "Show location")
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
})

for (const mode of ["rejected", "first-reject", "retry"]) test(`steering with an agy waiting prompt (${mode}) falls back cleanly without 409 lockup`, async () => {
  const workRoot = path.join(root, `steer-wait-work-${mode}`)
  const accountsDir = path.join(root, `steer-wait-accounts-${mode}`)
  const stateFile = path.join(root, `steer-wait-state-${mode}.json`)
  const fakeDir = path.join(root, `fake-steer-wait-agy-${mode}`)
  const logFile = path.join(root, `steer-wait-${mode}.jsonl`)
  await fs.promises.mkdir(workRoot, { recursive: true })
  const fakeBin = writeFakeAgy(fakeDir, `
import fs from "node:fs";
import net from "node:net";
import readline from "node:readline";
const args = process.argv.slice(2);
const logFile = process.env.FAKE_WAIT_LOG;
const record = (entry) => fs.appendFileSync(logFile, JSON.stringify(entry) + "\\n");
if (args.includes("--help")) process.exit(0);
if (args.includes("--version")) { console.log("1.5.9"); process.exit(0); }
if (args.includes("models")) { console.log("gemini-test  Gemini Test"); process.exit(0); }
const sessionId = "s-wait";
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
function connectControl(payload) {
  return new Promise((resolve, reject) => {
    const port = Number(process.env.AGY_BRIDGE_CONTROL_PORT);
    const token = process.env.AGY_BRIDGE_TOKEN;
    const sock = net.createConnection({ host: "127.0.0.1", port }, () => {
      sock.write(JSON.stringify({ token, ...payload }) + "\\n");
    });
    let buf = "";
    sock.on("data", chunk => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\\n");
      if (nl < 0) return;
      const msg = JSON.parse(buf.slice(0, nl));
      resolve(msg);
      sock.destroy();
    });
    sock.on("error", reject);
  });
}
let active = null;
let unseenDone = null;
let rejections = 0;
readline.createInterface({ input: process.stdin }).on("line", async line => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } }, agentInfo: { name: "fake-agy", version: "1.5.9" } } });
  } else if (msg.method === "session/new") {
    record({ type: "session/new" });
    await connectControl({ kind: "list" });
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId, models: { currentModelId: "gemini-test", availableModels: [{ modelId: "gemini-test", name: "Gemini Test" }] } } });
  } else if (msg.method === "session/cancel") {
    record({ type: "session/cancel" });
    if (active) {
      if (unseenDone) await unseenDone;
      const id = active.id;
      active = null;
      send({ jsonrpc: "2.0", id, result: { stopReason: "cancelled" } });
    }
  } else if (msg.method === "session/prompt") {
    const text = (msg.params?.prompt || []).map(p => p.text || "").join("\\n");
    record({ type: "session/prompt", id: msg.id, text });
    if (process.env.FAKE_WAIT_MODE === "first-reject" && !fs.existsSync(logFile + ".rejected")) {
      fs.writeFileSync(logFile + ".rejected", "1");
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "Can't add this prompt to session s-wait: the running prompt is waiting for a permission or question answer; answer it or send session/cancel, then send this prompt again" } });
      return;
    }
    if (active && process.env.FAKE_WAIT_MODE === "retry" && fs.existsSync(logFile + ".steer-rejected")) {
      record({ type: "nativeSteer" });
      const id = active.id;
      active = null;
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "RECOVERED_AFTER_WAIT" } } } });
      send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
      return;
    }
    if (active) {
      fs.writeFileSync(logFile + ".steer-rejected", "1");
      send({
        jsonrpc: "2.0",
        id: msg.id,
        error: {
          code: -32603,
          message: "Can't add this prompt to session s-wait: the running prompt is waiting for a permission or question answer; answer it or send session/cancel, then send this prompt again",
        },
      });
      rejections++;
      if (!unseenDone && process.env.FAKE_WAIT_MODE !== "retry" && rejections === 4) {
        unseenDone = new Promise(r => setTimeout(r, 15)).then(() =>
          connectControl({ kind: "call", name: "bash", arguments: { cmd: "pwd" } }).then(r => {
            record({ type: "unseen_bash_reply", r });
            return r;
          })
        );
      }
      return;
    }
    if (!text.includes("STOP_NOW")) {
      active = { id: msg.id };
      void connectControl({ kind: "call", name: "update_plan", arguments: { step: "1" } }).catch(() => {});
      return;
    }
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "RECOVERED_AFTER_WAIT" } } } });
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  }
});
`)
  const prev = {
    AGY_PATH: process.env.AGY_PATH,
    AGY_BRIDGE_CONVERSATIONS_DIR: process.env.AGY_BRIDGE_CONVERSATIONS_DIR,
    AGY_BRIDGE_ACCOUNTS_DIR: process.env.AGY_BRIDGE_ACCOUNTS_DIR,
    AGY_BRIDGE_STATE_FILE: process.env.AGY_BRIDGE_STATE_FILE,
    AGY_BRIDGE_USAGE: process.env.AGY_BRIDGE_USAGE,
    FAKE_WAIT_LOG: process.env.FAKE_WAIT_LOG,
    FAKE_WAIT_MODE: process.env.FAKE_WAIT_MODE,
  }
  process.env.AGY_PATH = fakeBin
  process.env.AGY_BRIDGE_CONVERSATIONS_DIR = workRoot
  process.env.AGY_BRIDGE_ACCOUNTS_DIR = accountsDir
  process.env.AGY_BRIDGE_STATE_FILE = stateFile
  process.env.AGY_BRIDGE_USAGE = "0"
  process.env.FAKE_WAIT_LOG = logFile
  process.env.FAKE_WAIT_MODE = mode
  const tools = [
    { name: "update_plan", input_schema: { type: "object", properties: { step: { type: "string" } }, required: ["step"] } },
    { name: "bash", input_schema: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] } },
  ]
  try {
    const { AntigravityBridgePlugin } = await import(`./index.mjs?fixes-wait-${mode}=${Date.now()}`)
    const plugin = await AntigravityBridgePlugin()
    const loader = await plugin.auth.loader()
    if (mode === "first-reject") {
      const body = JSON.stringify({ model: "gemini-test", stream: false, metadata: { user_id: `u-wait-${mode}` }, tools, messages: [{ role: "user", content: "STOP_NOW plain" }] })
      const first = await loader.fetch("agy://local/messages", { method: "POST", body })
      const firstBody = await first.text()
      assert.notEqual(first.status, 200, firstBody)
      assert.notEqual(first.status, 409, firstBody)
      const retry = await loader.fetch("agy://local/messages", { method: "POST", body })
      const retryBody = await retry.json()
      assert.equal(retry.status, 200, JSON.stringify(retryBody))
      assert.ok(retryBody.content.some(b => b.type === "text" && b.text.includes("RECOVERED_AFTER_WAIT")), JSON.stringify(retryBody))
      return
    }
    const messages1 = [{ role: "user", content: "start plan" }]
    const res1 = await loader.fetch("agy://local/messages", {
      method: "POST",
      body: JSON.stringify({ model: "gemini-test", stream: false, metadata: { user_id: `u-wait-${mode}` }, tools, messages: messages1 }),
    })
    const body1 = await res1.json()
    assert.equal(res1.status, 200, JSON.stringify(body1))
    const toolUse = body1.content.find(b => b.type === "tool_use")
    assert.equal(toolUse?.name, "update_plan")

    const messages2 = [
      ...messages1,
      { role: "assistant", content: body1.content },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: toolUse.id, content: [{ type: "text", text: "Plan shown." }] },
          { type: "text", text: "STOP_NOW: answer instead" },
        ],
      },
    ]
    const res2 = await loader.fetch("agy://local/messages", {
      method: "POST",
      body: JSON.stringify({ model: "gemini-test", stream: false, metadata: { user_id: `u-wait-${mode}` }, tools, messages: messages2 }),
    })
    const body2 = await res2.json()
    assert.equal(res2.status, 200, JSON.stringify(body2))
    assert.equal(body2.stop_reason, "end_turn")
    assert.ok(body2.content.some(b => b.type === "text" && b.text.includes("RECOVERED_AFTER_WAIT")), JSON.stringify(body2))

    const events = fs.readFileSync(logFile, "utf8").trim().split("\n").map(JSON.parse)
    assert.equal(events.filter(e => e.type === "session/new").length, 1)
    if (mode === "retry") {
      assert.equal(events.filter(e => e.type === "session/cancel").length, 0)
      assert.equal(events.filter(e => e.type === "nativeSteer").length, 1)
      assert.equal(events.filter(e => e.type === "session/prompt").length, 3)
      return
    }
    assert.equal(events.filter(e => e.type === "session/cancel").length, 1)
    assert.equal(events.filter(e => e.type === "session/prompt").length, 6)
    assert.ok(events.some(e => e.type === "unseen_bash_reply" && (e.r?.result?.isError === true || !!e.r?.error)), JSON.stringify(events))
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
})

test("disabled account ToS notice never leaks as assistant text and emits 403 permission_error in stream and JSON", async () => {
  const convDir = path.join(root, "conv-disabled")
  const accountsDir = path.join(root, "accounts-disabled")
  const stateFile = path.join(root, "state-disabled.json")
  const fakeDir = path.join(root, "fake-disabled-agy")
  fs.mkdirSync(convDir, { recursive: true })
  fs.mkdirSync(accountsDir, { recursive: true })
  let count = 0
  const fakeBin = writeFakeAgy(fakeDir, `
import readline from "node:readline";
const args = process.argv.slice(2);
if (args.includes("--help")) process.exit(0);
if (args.includes("--version")) { console.log("1.5.9"); process.exit(0); }
if (args.includes("models")) { console.log("gemini-test  Gemini Test"); process.exit(0); }
let count = 0;
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", line => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } }, agentInfo: { name: "fake-agy", version: "1.5.9" } } });
  } else if (msg.method === "session/new") {
    count++;
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-dis-" + count } });
  } else if (msg.method === "session/set_model" || msg.method === "session/set_config_option") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  } else if (msg.method === "session/prompt") {
    const sid = msg.params?.sessionId;
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: sid,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "\\n⚠ This service has been disabled in this account for violation of Terms of Service. Please submit an appeal to continue using this product.\\n" },
        },
      },
    });
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  }
});
`)
  const prev = {
    AGY_PATH: process.env.AGY_PATH,
    AGY_BRIDGE_CONVERSATIONS_DIR: process.env.AGY_BRIDGE_CONVERSATIONS_DIR,
    AGY_BRIDGE_ACCOUNTS_DIR: process.env.AGY_BRIDGE_ACCOUNTS_DIR,
    AGY_BRIDGE_STATE_FILE: process.env.AGY_BRIDGE_STATE_FILE,
    AGY_BRIDGE_USAGE: process.env.AGY_BRIDGE_USAGE,
  }
  process.env.AGY_PATH = fakeBin
  process.env.AGY_BRIDGE_CONVERSATIONS_DIR = convDir
  process.env.AGY_BRIDGE_ACCOUNTS_DIR = accountsDir
  process.env.AGY_BRIDGE_STATE_FILE = stateFile
  process.env.AGY_BRIDGE_USAGE = "0"
  try {
    const { AntigravityBridgePlugin } = await import(`./index.mjs?fixes-disabled=${Date.now()}`)
    const plugin = await AntigravityBridgePlugin()
    const loader = await plugin.auth.loader()

    const sseRes = await loader.fetch("agy://local/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "gemini-test",
        stream: true,
        metadata: { user_id: `u-disabled-${++count}` },
        messages: [{ role: "user", content: "hi" }],
      }),
    })
    assert.equal(sseRes.status, 200)
    const sseText = await sseRes.text()
    assert.ok(!sseText.includes("content_block_delta"), sseText)
    assert.ok(sseText.includes("event: error"), sseText)
    const errorData = sseText.split("\n\n").find(f => f.startsWith("event: error"))?.split("\n").find(l => l.startsWith("data:"))?.slice(5).trim()
    const parsedErr = JSON.parse(errorData || "{}")
    assert.equal(parsedErr.error?.type, "permission_error")
    assert.equal(parsedErr.error?.status, 403)
    assert.equal(parsedErr.error?.code, "AGY_ERROR_FORBIDDEN")

    const jsonRes = await loader.fetch("agy://local/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "gemini-test",
        stream: false,
        metadata: { user_id: `u-disabled-${++count}` },
        messages: [{ role: "user", content: "hi" }],
      }),
    })
    const jsonBody = await jsonRes.json()
    assert.equal(jsonRes.status, 403, JSON.stringify(jsonBody))
    assert.equal(jsonBody.error?.type, "permission_error")
    assert.equal(jsonBody.error?.status, 403)
    assert.equal(jsonBody.error?.code, "AGY_ERROR_FORBIDDEN")
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
})

test("[SUGGESTION MODE] side-calls and Magpie PII placeholders preserve the warm ACP session", async () => {
  const convDir = path.join(root, "conv-warm")
  const accountsDir = path.join(root, "accounts-warm")
  const stateFile = path.join(root, "state-warm.json")
  const fakeDir = path.join(root, "fake-warm-agy")
  const logFile = path.join(root, "warm.jsonl")
  fs.mkdirSync(convDir, { recursive: true })
  fs.mkdirSync(accountsDir, { recursive: true })
  const fakeBin = writeFakeAgy(fakeDir, `
import fs from "node:fs";
import net from "node:net";
import readline from "node:readline";
const args = process.argv.slice(2);
const logFile = process.env.FAKE_WARM_LOG;
if (args.includes("--help")) process.exit(0);
if (args.includes("--version")) { console.log("1.5.9"); process.exit(0); }
if (args.includes("models")) { console.log("gemini-test  Gemini Test"); process.exit(0); }
const pidTag = process.pid;
let turnCount = 0;
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
function listTools() {
  return new Promise((resolve, reject) => {
    const port = Number(process.env.AGY_BRIDGE_CONTROL_PORT);
    const token = process.env.AGY_BRIDGE_TOKEN;
    const sock = net.createConnection({ host: "127.0.0.1", port }, () => {
      sock.write(JSON.stringify({ token, kind: "list" }) + "\\n");
    });
    let buf = "";
    sock.on("data", chunk => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\\n");
      if (nl < 0) return;
      resolve(JSON.parse(buf.slice(0, nl)));
      sock.destroy();
    });
    sock.on("error", reject);
  });
}
readline.createInterface({ input: process.stdin }).on("line", async line => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } }, agentInfo: { name: "fake-agy", version: "1.5.9" } } });
  } else if (msg.method === "session/new") {
    const listed = await listTools();
    const sid = "s-warm-" + pidTag;
    fs.appendFileSync(logFile, JSON.stringify({ event: "session/new", pid: pidTag, sid, tools: (listed.result?.tools || []).map(t => t.name) }) + "\\n");
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: sid } });
  } else if (msg.method === "session/set_model" || msg.method === "session/set_config_option") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  } else if (msg.method === "session/prompt") {
    turnCount++;
    const sid = msg.params?.sessionId;
    const text = (msg.params?.prompt || []).map(p => p.text || "").join("\\n");
    fs.appendFileSync(logFile, JSON.stringify({ event: "session/prompt", pid: pidTag, sid, turnCount, text }) + "\\n");
    const reply = text.includes("[SUGGESTION MODE:")
      ? "继续测试"
      : text.includes("部署免检定位验证")
        ? "已部署"
        : "当前基站位于四川省成都市金牛区顺庆巷66号院（大升桥附近），偏离2.4公里。";
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply } } } });
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  }
});
`)
  const prev = {
    AGY_PATH: process.env.AGY_PATH,
    AGY_BRIDGE_CONVERSATIONS_DIR: process.env.AGY_BRIDGE_CONVERSATIONS_DIR,
    AGY_BRIDGE_ACCOUNTS_DIR: process.env.AGY_BRIDGE_ACCOUNTS_DIR,
    AGY_BRIDGE_STATE_FILE: process.env.AGY_BRIDGE_STATE_FILE,
    AGY_BRIDGE_USAGE: process.env.AGY_BRIDGE_USAGE,
    FAKE_WARM_LOG: process.env.FAKE_WARM_LOG,
  }
  process.env.AGY_PATH = fakeBin
  process.env.AGY_BRIDGE_CONVERSATIONS_DIR = convDir
  process.env.AGY_BRIDGE_ACCOUNTS_DIR = accountsDir
  process.env.AGY_BRIDGE_STATE_FILE = stateFile
  process.env.AGY_BRIDGE_USAGE = "0"
  process.env.FAKE_WARM_LOG = logFile
  const tools = [{ name: "bash", input_schema: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] } }]
  try {
    const { AntigravityBridgePlugin } = await import(`./index.mjs?fixes-warm=${Date.now()}`)
    const plugin = await AntigravityBridgePlugin()
    const loader = await plugin.auth.loader()

    const r1 = await loader.fetch("agy://local/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "gemini-test",
        stream: false,
        system: "Main system prompt.",
        metadata: { user_id: "u-warm-1" },
        tools,
        messages: [{ role: "user", content: "定位为什么偏了" }],
      }),
    })
    const b1 = await r1.json()
    assert.equal(r1.status, 200, JSON.stringify(b1))

    const maskedAssistant = "当前基站位于{{ADDRESS_4fy4fj7x}}），偏离2.4公里。"
    const rSuggest = await loader.fetch("agy://local/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "gemini-test",
        stream: false,
        system: "Main system prompt.",
        metadata: { user_id: "u-warm-1" },
        tools,
        messages: [
          { role: "user", content: "定位为什么偏了" },
          { role: "assistant", content: [{ type: "text", text: maskedAssistant }] },
          { role: "user", content: "[SUGGESTION MODE: Suggest what the user might naturally type next into Claude Code.]\n\nReply with ONLY the suggestion." },
        ],
      }),
    })
    const bSuggest = await rSuggest.json()
    assert.equal(rSuggest.status, 200, JSON.stringify(bSuggest))
    assert.equal(bSuggest.content.find(b => b.type === "text")?.text, "继续测试")

    const r2 = await loader.fetch("agy://local/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "gemini-test",
        stream: false,
        system: "Main system prompt.",
        metadata: { user_id: "u-warm-1" },
        tools,
        messages: [
          { role: "user", content: "定位为什么偏了" },
          { role: "assistant", content: [{ type: "text", text: maskedAssistant }] },
          { role: "user", content: "部署免检定位验证" },
        ],
      }),
    })
    const b2 = await r2.json()
    assert.equal(r2.status, 200, JSON.stringify(b2))
    assert.equal(b2.content.find(b => b.type === "text")?.text, "已部署")

    const rEdited = await loader.fetch("agy://local/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "gemini-test",
        stream: false,
        system: "Main system prompt.",
        metadata: { user_id: "u-warm-1" },
        tools,
        messages: [
          { role: "user", content: "定位为什么偏了" },
          { role: "assistant", content: [{ type: "text", text: "偏离5公里。" }] },
          { role: "user", content: "再测一次" },
        ],
      }),
    })
    assert.equal(rEdited.status, 200)

    const logEvents = fs.readFileSync(logFile, "utf8").trim().split("\n").map(JSON.parse)
    const news = logEvents.filter(e => e.event === "session/new")
    assert.equal(news.length, 3, JSON.stringify(news))
    assert.deepEqual(news[0].tools, ["bash"])
    assert.deepEqual(news[1].tools, [])
    const mainPrompts = logEvents.filter(e => e.event === "session/prompt" && e.pid === news[0].pid)
    assert.equal(mainPrompts.length, 2, JSON.stringify(mainPrompts))
    assert.equal(mainPrompts[1].text.trim(), "部署免检定位验证")
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
})


test("documents.mjs handles http(s) URLs, base64 UTF-8 text/JSON/XML, tool_result binary PDFs, and clear user refusals", async () => {
  const { documentText, documentRefusal } = await import("./documents.mjs")
  assert.equal(
    documentText({ type: "document", title: "Spec", source: { type: "url", url: "https://example.invalid/spec" } }),
    "[document: Spec at https://example.invalid/spec; its content is not attached here. Fetch the URL with a tool to read it.]",
  )
  assert.equal(
    documentText({ type: "document", title: "cfg.json", source: { type: "base64", media_type: "application/json; charset=utf-8", data: Buffer.from('{"ok":true}').toString("base64") } }),
    '[document: cfg.json]\n{"ok":true}\n[end of document]',
  )
  assert.equal(
    documentText({ type: "document", title: "bad.txt", source: { type: "base64", media_type: "text/plain", data: Buffer.from([0xff, 0xfe]).toString("base64") } }),
    null,
  )
  assert.equal(
    documentText({ type: "document", title: "report.pdf", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" } }, { inToolResult: false }),
    null,
  )
  assert.equal(
    documentText({ type: "document", title: "report.pdf", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" } }, { inToolResult: true }),
    "[document: report.pdf: a PDF that could not be attached here. Extract its text with a tool (pdftotext, say) to read it.]",
  )
  assert.match(documentRefusal({ type: "document", source: { type: "file", file_id: "f_1" } }).what, /Files API file_id/)
  assert.match(documentRefusal({ type: "document", source: { type: "url", url: "ftp://x/y" } }).what, /other than http\(s\)/)
})


test("Individual quota reached maps to 429 with reset time and Verification Required extracts log link into 403 permission_error", async () => {
  const convDir = path.join(root, "conv-qv")
  const accountsDir = path.join(root, "accounts-qv")
  const stateFile = path.join(root, "state-qv.json")
  const fakeDir = path.join(root, "fake-qv-agy")
  fs.mkdirSync(convDir, { recursive: true })
  fs.mkdirSync(accountsDir, { recursive: true })
  let count = 0
  const fakeBin = writeFakeAgy(fakeDir, `
import fs from "node:fs";
import readline from "node:readline";
const args = process.argv.slice(2);
if (args.includes("--help")) process.exit(0);
if (args.includes("--version")) { console.log("1.5.9"); process.exit(0); }
if (args.includes("models")) { console.log("gemini-test  Gemini Test"); process.exit(0); }
const logIdx = args.indexOf("--log-file");
const agyLog = logIdx >= 0 ? args[logIdx + 1] : null;
let count = 0;
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", line => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } }, agentInfo: { name: "fake-agy", version: "1.5.9" } } });
  } else if (msg.method === "session/new") {
    count++;
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-qv-" + count } });
  } else if (msg.method === "session/set_model" || msg.method === "session/set_config_option") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  } else if (msg.method === "session/prompt") {
    const sid = msg.params?.sessionId;
    const text = (msg.params?.prompt || []).map(p => p.text || "").join("\\n");
    let reply = "ok";
    if (text.includes("TRIGGER_QUOTA")) {
      reply = "\\n⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 1h18m40s.\\n";
    } else if (text.includes("TRIGGER_VERIFY")) {
      if (agyLog) fs.appendFileSync(agyLog, '2026/11/17 12:00:00 ERROR validation_url="https://accounts.google.com/signin/continue?s=abc\\u0026t=1"\\n');
      reply = "\\n⚠ Verification Required\\n";
    } else if (text.includes("QUOTE_BOTH")) {
      reply = "Saw ⚠ Verification Required and ⚠ Individual quota reached in log.";
    }
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply } } } });
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  }
});
`)
  const prev = {
    AGY_PATH: process.env.AGY_PATH,
    AGY_BRIDGE_CONVERSATIONS_DIR: process.env.AGY_BRIDGE_CONVERSATIONS_DIR,
    AGY_BRIDGE_ACCOUNTS_DIR: process.env.AGY_BRIDGE_ACCOUNTS_DIR,
    AGY_BRIDGE_STATE_FILE: process.env.AGY_BRIDGE_STATE_FILE,
    AGY_BRIDGE_USAGE: process.env.AGY_BRIDGE_USAGE,
  }
  process.env.AGY_PATH = fakeBin
  process.env.AGY_BRIDGE_CONVERSATIONS_DIR = convDir
  process.env.AGY_BRIDGE_ACCOUNTS_DIR = accountsDir
  process.env.AGY_BRIDGE_STATE_FILE = stateFile
  process.env.AGY_BRIDGE_USAGE = "0"
  try {
    const { AntigravityBridgePlugin } = await import(`./index.mjs?fixes-qv=${Date.now()}`)
    const plugin = await AntigravityBridgePlugin()
    const loader = await plugin.auth.loader()

    const quotaRes = await loader.fetch("agy://local/messages", {
      method: "POST",
      body: JSON.stringify({ model: "gemini-test", stream: false, metadata: { user_id: `u-qv-${++count}` }, messages: [{ role: "user", content: "TRIGGER_QUOTA" }] }),
    })
    const quotaBody = await quotaRes.json()
    assert.equal(quotaRes.status, 429, JSON.stringify(quotaBody))
    assert.equal(quotaBody.error?.type, "rate_limit_error")
    assert.equal(quotaBody.error?.code, "AGY_ERROR_QUOTA_EXHAUSTED")
    assert.match(quotaBody.error?.message || "", /Resets in 1h18m40s/)

    const verifyRes = await loader.fetch("agy://local/messages", {
      method: "POST",
      body: JSON.stringify({ model: "gemini-test", stream: false, metadata: { user_id: `u-qv-${++count}` }, messages: [{ role: "user", content: "TRIGGER_VERIFY" }] }),
    })
    const verifyBody = await verifyRes.json()
    assert.equal(verifyRes.status, 403, JSON.stringify(verifyBody))
    assert.equal(verifyRes.headers.get("x-should-retry"), "false")
    assert.equal(verifyBody.error?.type, "permission_error")
    assert.equal(verifyBody.error?.code, "AGY_ERROR_FORBIDDEN")
    assert.match(verifyBody.error?.message || "", /this Google account needs to be verified/)
    assert.match(verifyBody.error?.message || "", /https:\/\/accounts\.google\.com\/signin\/continue\?s=abc&t=1/)

    const quotedRes = await loader.fetch("agy://local/messages", {
      method: "POST",
      body: JSON.stringify({ model: "gemini-test", stream: false, metadata: { user_id: `u-qv-${++count}` }, messages: [{ role: "user", content: "QUOTE_BOTH" }] }),
    })
    const quotedBody = await quotedRes.json()
    assert.equal(quotedRes.status, 200, JSON.stringify(quotedBody))
    assert.match(quotedBody.content?.[0]?.text || "", /⚠ Verification Required/)
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
})


test("unlisted initial tools fail with 502 tools_not_loaded and a no-watcher session is replaced when tools arrive", async () => {
  const convDir = path.join(root, "conv-unlisted")
  const accountsDir = path.join(root, "accounts-unlisted")
  const stateFile = path.join(root, "state-unlisted.json")
  const fakeDir = path.join(root, "fake-unlisted-agy")
  fs.mkdirSync(convDir, { recursive: true })
  fs.mkdirSync(accountsDir, { recursive: true })
  const markerFile = path.join(root, "unlisted-connect-mcp")
  const fakeBin = writeFakeAgy(fakeDir, `
import fs from "node:fs";
import net from "node:net";
import readline from "node:readline";
const args = process.argv.slice(2);
if (args.includes("--help")) process.exit(0);
if (args.includes("--version")) { console.log("1.5.9"); process.exit(0); }
if (args.includes("models")) { console.log("gemini-test  Gemini Test"); process.exit(0); }
let count = 0;
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
function watchTools() {
  return new Promise((resolve, reject) => {
    const port = Number(process.env.AGY_BRIDGE_CONTROL_PORT);
    const token = process.env.AGY_BRIDGE_TOKEN;
    const watch = net.createConnection({ host: "127.0.0.1", port }, () => {
      watch.write(JSON.stringify({ token, kind: "watch" }) + "\\n");
    });
    watch.unref();
    const sock = net.createConnection({ host: "127.0.0.1", port }, () => {
      sock.write(JSON.stringify({ token, kind: "list" }) + "\\n");
    });
    let buf = "";
    sock.on("data", chunk => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\\n");
      if (nl < 0) return;
      resolve(JSON.parse(buf.slice(0, nl)));
      sock.destroy();
    });
    sock.on("error", reject);
  });
}
readline.createInterface({ input: process.stdin }).on("line", async line => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } }, agentInfo: { name: "fake-agy", version: "1.5.9" } } });
  } else if (msg.method === "session/new") {
    count++;
    if (fs.existsSync(${JSON.stringify(markerFile)})) await watchTools();
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-unl-" + count + "-" + process.pid } });
  } else if (msg.method === "session/set_model" || msg.method === "session/set_config_option") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  } else if (msg.method === "session/prompt") {
    const sid = msg.params?.sessionId;
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok:" + sid } } } });
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  }
});
`)
  const prev = {
    AGY_PATH: process.env.AGY_PATH,
    AGY_BRIDGE_CONVERSATIONS_DIR: process.env.AGY_BRIDGE_CONVERSATIONS_DIR,
    AGY_BRIDGE_ACCOUNTS_DIR: process.env.AGY_BRIDGE_ACCOUNTS_DIR,
    AGY_BRIDGE_STATE_FILE: process.env.AGY_BRIDGE_STATE_FILE,
    AGY_BRIDGE_USAGE: process.env.AGY_BRIDGE_USAGE,
    AGY_BRIDGE_TOOL_LIST_WAIT_MS: process.env.AGY_BRIDGE_TOOL_LIST_WAIT_MS,
  }
  process.env.AGY_PATH = fakeBin
  process.env.AGY_BRIDGE_CONVERSATIONS_DIR = convDir
  process.env.AGY_BRIDGE_ACCOUNTS_DIR = accountsDir
  process.env.AGY_BRIDGE_STATE_FILE = stateFile
  process.env.AGY_BRIDGE_USAGE = "0"
  process.env.AGY_BRIDGE_TOOL_LIST_WAIT_MS = "150"
  const tools = [{ name: "echo", input_schema: { type: "object", properties: { text: { type: "string" } } } }]
  try {
    const { AntigravityBridgePlugin } = await import(`./index.mjs?fixes-unl=${Date.now()}`)
    const plugin = await AntigravityBridgePlugin()
    const loader = await plugin.auth.loader()

    const failRes = await loader.fetch("agy://local/messages", {
      method: "POST",
      body: JSON.stringify({ model: "gemini-test", stream: false, tools, metadata: { user_id: "u-unl-1" }, messages: [{ role: "user", content: "need tools" }] }),
    })
    const failBody = await failRes.json()
    assert.equal(failRes.status, 502, JSON.stringify(failBody))
    assert.equal(failBody.error?.code, "tools_not_loaded")

    // First turn starts without tools (and fake agy didn't connect MCP), second turn brings tools -> replaces session cleanly.
    const r1 = await loader.fetch("agy://local/messages", {
      method: "POST",
      body: JSON.stringify({ model: "gemini-test", stream: false, metadata: { user_id: "u-unl-2" }, messages: [{ role: "user", content: "no tools yet" }] }),
    })
    const b1 = await r1.json()
    assert.equal(r1.status, 200, JSON.stringify(b1))
    fs.writeFileSync(markerFile, "1")
    const r2 = await loader.fetch("agy://local/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "gemini-test",
        stream: false,
        tools,
        metadata: { user_id: "u-unl-2" },
        messages: [
          { role: "user", content: "no tools yet" },
          { role: "assistant", content: b1.content },
          { role: "user", content: "now with tools" },
        ],
      }),
    })
    const b2 = await r2.json()
    assert.equal(r2.status, 200, JSON.stringify(b2))
    assert.notEqual(b1.content?.[0]?.text, b2.content?.[0]?.text)
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
})


test("agy launch flags probe --help once per binary for --settings, --include-default-customizations=false, and --disable-telemetry", async () => {
  const convDir = path.join(root, "conv-flags")
  const accountsDir = path.join(root, "accounts-flags")
  const stateFile = path.join(root, "state-flags.json")
  const fakeDir = path.join(root, "fake-flags-agy")
  const logFile = path.join(root, "flags.jsonl")
  fs.mkdirSync(convDir, { recursive: true })
  fs.mkdirSync(accountsDir, { recursive: true })
  const fakeBin = writeFakeAgy(fakeDir, `
import fs from "node:fs";
import readline from "node:readline";
const args = process.argv.slice(2);
const log = (entry) => fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(entry) + "\\n");
if (args.length === 1 && args[0] === "--help") {
  log({ type: "top-help" });
  console.log("Usage:\\n  --settings string   override settings");
  process.exit(0);
}
if (args[0] === "acp" && args.includes("--help")) {
  log({ type: "acp-help" });
  console.log("Usage of acp:\\n  --include-default-customizations\\n  --disable-telemetry");
  process.exit(0);
}
if (args.includes("--version")) { console.log("1.5.9"); process.exit(0); }
if (args.includes("models")) {
  log({ type: "models", args });
  console.log("gemini-test  Gemini Test");
  process.exit(0);
}
log({ type: "acp", args });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", line => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } }, agentInfo: { name: "fake-agy", version: "1.5.9" } } });
  else if (msg.method === "session/new") send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-flags" } });
  else if (msg.method === "session/set_model" || msg.method === "session/set_config_option") send({ jsonrpc: "2.0", id: msg.id, result: {} });
  else if (msg.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params?.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } } });
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  }
});
`)
  const prev = {
    AGY_PATH: process.env.AGY_PATH,
    AGY_BRIDGE_CONVERSATIONS_DIR: process.env.AGY_BRIDGE_CONVERSATIONS_DIR,
    AGY_BRIDGE_ACCOUNTS_DIR: process.env.AGY_BRIDGE_ACCOUNTS_DIR,
    AGY_BRIDGE_STATE_FILE: process.env.AGY_BRIDGE_STATE_FILE,
    AGY_BRIDGE_USAGE: process.env.AGY_BRIDGE_USAGE,
    AGY_BRIDGE_TELEMETRY: process.env.AGY_BRIDGE_TELEMETRY,
  }
  process.env.AGY_PATH = fakeBin
  process.env.AGY_BRIDGE_CONVERSATIONS_DIR = convDir
  process.env.AGY_BRIDGE_ACCOUNTS_DIR = accountsDir
  process.env.AGY_BRIDGE_STATE_FILE = stateFile
  process.env.AGY_BRIDGE_USAGE = "0"
  delete process.env.AGY_BRIDGE_TELEMETRY
  try {
    const { AntigravityBridgePlugin } = await import(`./index.mjs?fixes-flags=${Date.now()}`)
    const plugin = await AntigravityBridgePlugin()
    const loader = await plugin.auth.loader()
    const r1 = await loader.fetch("agy://local/messages", {
      method: "POST",
      body: JSON.stringify({ model: "gemini-test", stream: false, metadata: { user_id: "u-flags-1" }, messages: [{ role: "user", content: "hi" }] }),
    })
    assert.equal(r1.status, 200)
    process.env.AGY_BRIDGE_TELEMETRY = "1"
    const r2 = await loader.fetch("agy://local/messages", {
      method: "POST",
      body: JSON.stringify({ model: "gemini-test", stream: false, metadata: { user_id: "u-flags-2" }, messages: [{ role: "user", content: "hi2" }] }),
    })
    assert.equal(r2.status, 200)
    const events = fs.readFileSync(logFile, "utf8").trim().split("\n").map(JSON.parse)
    assert.equal(events.filter(e => e.type === "top-help").length, 1)
    assert.equal(events.filter(e => e.type === "acp-help").length, 1)
    const modelsCall = events.find(e => e.type === "models")
    assert.deepEqual(modelsCall.args, ["--settings", JSON.stringify({ modelProvider: "" }), "models"])
    const acpCalls = events.filter(e => e.type === "acp")
    assert.equal(acpCalls.length, 2)
    assert.ok(acpCalls[0].args.includes("--include-default-customizations=false"))
    assert.ok(acpCalls[0].args.includes("--disable-telemetry"))
    assert.ok(acpCalls[1].args.includes("--include-default-customizations=false"))
    assert.ok(!acpCalls[1].args.includes("--disable-telemetry"))
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
})


test("x-magpie-session/subagent headers isolate sessions and Request.text() body fallback works when init.body is omitted", async () => {
  const convDir = path.join(root, "conv-scope")
  const accountsDir = path.join(root, "accounts-scope")
  const stateFile = path.join(root, "state-scope.json")
  const fakeDir = path.join(root, "fake-scope-agy")
  fs.mkdirSync(convDir, { recursive: true })
  fs.mkdirSync(accountsDir, { recursive: true })
  const fakeBin = writeFakeAgy(fakeDir, `
import readline from "node:readline";
const args = process.argv.slice(2);
if (args.includes("--help")) process.exit(0);
if (args.includes("--version")) { console.log("1.5.9"); process.exit(0); }
if (args.includes("models")) { console.log("gemini-test  Gemini Test"); process.exit(0); }
let count = 0;
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", line => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } }, agentInfo: { name: "fake-agy", version: "1.5.9" } } });
  else if (msg.method === "session/new") send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-scope-" + (++count) + "-" + process.pid } });
  else if (msg.method === "session/set_model" || msg.method === "session/set_config_option") send({ jsonrpc: "2.0", id: msg.id, result: {} });
  else if (msg.method === "session/prompt") {
    const sid = msg.params?.sessionId;
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "sid:" + sid } } } });
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  }
});
`)
  const prev = {
    AGY_PATH: process.env.AGY_PATH,
    AGY_BRIDGE_CONVERSATIONS_DIR: process.env.AGY_BRIDGE_CONVERSATIONS_DIR,
    AGY_BRIDGE_ACCOUNTS_DIR: process.env.AGY_BRIDGE_ACCOUNTS_DIR,
    AGY_BRIDGE_STATE_FILE: process.env.AGY_BRIDGE_STATE_FILE,
    AGY_BRIDGE_USAGE: process.env.AGY_BRIDGE_USAGE,
  }
  process.env.AGY_PATH = fakeBin
  process.env.AGY_BRIDGE_CONVERSATIONS_DIR = convDir
  process.env.AGY_BRIDGE_ACCOUNTS_DIR = accountsDir
  process.env.AGY_BRIDGE_STATE_FILE = stateFile
  process.env.AGY_BRIDGE_USAGE = "0"
  try {
    const { AntigravityBridgePlugin } = await import(`./index.mjs?fixes-scope=${Date.now()}`)
    const plugin = await AntigravityBridgePlugin()
    const loader = await plugin.auth.loader()
    const payload = { model: "gemini-test", stream: false, messages: [{ role: "user", content: "same opening" }] }
    const rA = await loader.fetch(new Request("http://local/messages", {
      method: "POST",
      headers: { "x-magpie-session": "sess-alpha" },
      body: JSON.stringify(payload),
    }))
    const bA = await rA.json()
    assert.equal(rA.status, 200, JSON.stringify(bA))
    const rB = await loader.fetch(new Request("http://local/messages", {
      method: "POST",
      headers: { "x-magpie-session": "sess-beta", "x-magpie-subagent": "reviewer" },
      body: JSON.stringify(payload),
    }))
    const bB = await rB.json()
    assert.equal(rB.status, 200, JSON.stringify(bB))
    assert.notEqual(bA.content?.[0]?.text, bB.content?.[0]?.text)
    const rA2 = await loader.fetch(new Request("http://local/messages", {
      method: "POST",
      headers: { "x-magpie-session": "sess-alpha" },
      body: JSON.stringify({
        model: "gemini-test",
        stream: false,
        messages: [
          { role: "user", content: "same opening" },
          { role: "assistant", content: bA.content },
          { role: "user", content: "alpha follow up" },
        ],
      }),
    }))
    const bA2 = await rA2.json()
    assert.equal(rA2.status, 200, JSON.stringify(bA2))
    assert.equal(bA2.content?.[0]?.text, bA.content?.[0]?.text)

    // Ephemeral magpie-<24hex> session IDs are ignored so they still reuse the same un-scoped session.
    const rM1 = await loader.fetch(new Request("http://local/messages", {
      method: "POST",
      headers: { "x-magpie-session": "magpie-0123456789abcdef01234567" },
      body: JSON.stringify({ model: "gemini-test", stream: false, messages: [{ role: "user", content: "ephemeral id test" }] }),
    }))
    const bM1 = await rM1.json()
    const rM2 = await loader.fetch(new Request("http://local/messages", {
      method: "POST",
      headers: { "x-magpie-session": "magpie-fedcba9876543210fedcba98" },
      body: JSON.stringify({
        model: "gemini-test",
        stream: false,
        messages: [
          { role: "user", content: "ephemeral id test" },
          { role: "assistant", content: bM1.content },
          { role: "user", content: "follow up" },
        ],
      }),
    }))
    const bM2 = await rM2.json()
    assert.equal(rM2.status, 200, JSON.stringify(bM2))
    assert.equal(bM1.content?.[0]?.text, bM2.content?.[0]?.text)
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
})


test("tool state machine handles foldSplitCalls, movedOnVerdict, droppedPendingCalls, carriedAnswered, and thinking prefill", async () => {
  const convDir = path.join(root, "conv-tsm")
  const accountsDir = path.join(root, "accounts-tsm")
  const stateFile = path.join(root, "state-tsm.json")
  const fakeDir = path.join(root, "fake-tsm-agy")
  fs.mkdirSync(convDir, { recursive: true })
  fs.mkdirSync(accountsDir, { recursive: true })
  const fakeBin = writeFakeAgy(fakeDir, `
import net from "node:net";
import readline from "node:readline";
const args = process.argv.slice(2);
if (args.includes("--help")) process.exit(0);
if (args.includes("--version")) { console.log("1.5.9"); process.exit(0); }
if (args.includes("models")) { console.log("gemini-test  Gemini Test"); process.exit(0); }
let count = 0;
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
function mcpCall(name, input) {
  return new Promise((resolve, reject) => {
    const port = Number(process.env.AGY_BRIDGE_CONTROL_PORT);
    const token = process.env.AGY_BRIDGE_TOKEN;
    const sock = net.createConnection({ host: "127.0.0.1", port }, () => {
      sock.write(JSON.stringify({ token, kind: "call", name, input }) + "\\n");
    });
    let buf = "";
    sock.on("data", chunk => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\\n");
      if (nl < 0) return;
      resolve(JSON.parse(buf.slice(0, nl)));
      sock.destroy();
    });
    sock.on("error", reject);
  });
}
function watchTools() {
  return new Promise((resolve, reject) => {
    const port = Number(process.env.AGY_BRIDGE_CONTROL_PORT);
    const token = process.env.AGY_BRIDGE_TOKEN;
    const watch = net.createConnection({ host: "127.0.0.1", port }, () => {
      watch.write(JSON.stringify({ token, kind: "watch" }) + "\\n");
    });
    watch.unref();
    const sock = net.createConnection({ host: "127.0.0.1", port }, () => {
      sock.write(JSON.stringify({ token, kind: "list" }) + "\\n");
    });
    let buf = "";
    sock.on("data", chunk => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\\n");
      if (nl < 0) return;
      resolve(JSON.parse(buf.slice(0, nl)));
      sock.destroy();
    });
    sock.on("error", reject);
  });
}
let activeSid = null;
let cancelPrompt = null;
readline.createInterface({ input: process.stdin }).on("line", async line => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } }, agentInfo: { name: "fake-agy", version: "1.5.9" } } });
  } else if (msg.method === "session/new") {
    await watchTools();
    activeSid = "s-tsm-" + (++count) + "-" + process.pid;
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: activeSid } });
  } else if (msg.method === "session/set_model" || msg.method === "session/set_config_option") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  } else if (msg.method === "session/cancel") {
    cancelPrompt?.();
  } else if (msg.method === "session/prompt") {
    const sid = msg.params?.sessionId;
    const text = (msg.params?.prompt || []).map(p => p.text || "").join("\\n");
    if (text.includes("START_SPLIT") && !text.includes("<conversation_history>")) {
      const r = await mcpCall("batch_read", { paths: ["a.txt", "b.txt"] });
      const resText = (r.result?.content || []).map(p => p.text || "").join("|");
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "split:" + sid + ":" + resText } } } });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    } else if (text.includes("START_DROP") && !text.includes("<conversation_history>")) {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial:" + sid } } } });
      const mcpPromise = mcpCall("batch_read", { paths: ["x.txt"] });
      const cancelled = await new Promise(resolve => {
        cancelPrompt = () => resolve(true);
        mcpPromise.then(() => {});
      });
      cancelPrompt = null;
      await mcpPromise;
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: cancelled ? "cancelled" : "end_turn" } });
    } else if (text.includes("START_DUAL") && !text.includes("<conversation_history>")) {
      const open = (paths) => new Promise((resolve, reject) => {
        const port = Number(process.env.AGY_BRIDGE_CONTROL_PORT);
        const sock = net.createConnection({ host: "127.0.0.1", port }, () => resolve({ sock, paths }));
        sock.on("error", reject);
      });
      const conns = await Promise.all([open(["1"]), open(["2"])]);
      const token = process.env.AGY_BRIDGE_TOKEN;
      await Promise.all(conns.map(({ sock, paths }) => new Promise((resolve, reject) => {
        let buf = "";
        sock.on("data", chunk => { buf += chunk; const nl = buf.indexOf("\\n"); if (nl >= 0) { resolve(JSON.parse(buf.slice(0, nl))); sock.destroy(); } });
        sock.on("error", reject);
        sock.write(JSON.stringify({ token, kind: "call", name: "batch_read", input: { paths } }) + "\\n");
      })));
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    } else {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok:" + sid } } } });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    }
  }
});
`)
  const prev = {
    AGY_PATH: process.env.AGY_PATH,
    AGY_BRIDGE_CONVERSATIONS_DIR: process.env.AGY_BRIDGE_CONVERSATIONS_DIR,
    AGY_BRIDGE_ACCOUNTS_DIR: process.env.AGY_BRIDGE_ACCOUNTS_DIR,
    AGY_BRIDGE_STATE_FILE: process.env.AGY_BRIDGE_STATE_FILE,
    AGY_BRIDGE_USAGE: process.env.AGY_BRIDGE_USAGE,
  }
  process.env.AGY_PATH = fakeBin
  process.env.AGY_BRIDGE_CONVERSATIONS_DIR = convDir
  process.env.AGY_BRIDGE_ACCOUNTS_DIR = accountsDir
  process.env.AGY_BRIDGE_STATE_FILE = stateFile
  process.env.AGY_BRIDGE_USAGE = "0"
  const tools = [{ name: "batch_read", input_schema: { type: "object", properties: { paths: { type: "array", items: { type: "string" } } } } }]
  try {
    const { AntigravityBridgePlugin } = await import(`./index.mjs?fixes-tsm=${Date.now()}`)
    const plugin = await AntigravityBridgePlugin()
    const loader = await plugin.auth.loader()

    // 1. foldSplitCalls: split Hermes tool_use + tool_results fold back into the live MCP call.
    const rSplit1 = await loader.fetch("agy://local/messages", {
      method: "POST",
      body: JSON.stringify({ model: "gemini-test", stream: false, tools, metadata: { user_id: "u-split" }, messages: [{ role: "user", content: "START_SPLIT" }] }),
    })
    const bSplit1 = await rSplit1.json()
    const splitUse = bSplit1.content.find(b => b.type === "tool_use")
    assert.ok(splitUse)
    const rSplit2 = await loader.fetch("agy://local/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "gemini-test",
        stream: false,
        tools,
        metadata: { user_id: "u-split" },
        messages: [
          { role: "user", content: "START_SPLIT" },
          { role: "assistant", content: [
            { type: "tool_use", id: splitUse.id, name: "batch_read", input: { paths: ["a.txt"] } },
            { type: "tool_use", id: "call_hermes_2", name: "batch_read", input: { paths: ["b.txt"] } },
          ] },
          { role: "user", content: [
            { type: "tool_result", tool_use_id: splitUse.id, content: "A" },
            { type: "tool_result", tool_use_id: "call_hermes_2", content: "B" },
          ] },
        ],
      }),
    })
    const bSplit2 = await rSplit2.json()
    assert.equal(rSplit2.status, 200, JSON.stringify(bSplit2))
    assert.match(bSplit2.content?.[0]?.text || "", /^split:s-tsm-.*:A\|B$/)

    // 2. droppedPendingCalls + keepDroppedTurn keeps the same live session when pending tool_use is dropped.
    const rDrop1 = await loader.fetch("agy://local/messages", {
      method: "POST",
      body: JSON.stringify({ model: "gemini-test", stream: false, tools, metadata: { user_id: "u-drop" }, messages: [{ role: "user", content: "START_DROP" }] }),
    })
    const bDrop1 = await rDrop1.json()
    assert.equal(bDrop1.stop_reason, "tool_use")
    const dropPartial = bDrop1.content.find(b => b.type === "text")?.text || ""
    const dropSid = dropPartial.replace(/^partial:/, "")
    const rDrop2 = await loader.fetch("agy://local/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "gemini-test",
        stream: false,
        tools,
        metadata: { user_id: "u-drop" },
        messages: [
          { role: "user", content: "START_DROP" },
          { role: "assistant", content: [{ type: "text", text: dropPartial }] },
          { role: "user", content: "continue without tool" },
        ],
      }),
    })
    const bDrop2 = await rDrop2.json()
    assert.equal(rDrop2.status, 200, JSON.stringify(bDrop2))
    assert.equal(bDrop2.content?.[0]?.text, "ok:" + dropSid)

    // 3. movedOnVerdict replays immediately on first unmatched result after another provider's tool call.
    const rMove1 = await loader.fetch("agy://local/messages", {
      method: "POST",
      body: JSON.stringify({ model: "gemini-test", stream: false, tools, metadata: { user_id: "u-move" }, messages: [{ role: "user", content: "START_DROP" }] }),
    })
    const bMove1 = await rMove1.json()
    const moveUse = bMove1.content.find(b => b.type === "tool_use")
    const rMove2 = await loader.fetch("agy://local/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "gemini-test",
        stream: false,
        tools,
        metadata: { user_id: "u-move" },
        messages: [
          { role: "user", content: "START_DROP" },
          { role: "assistant", content: bMove1.content },
          { role: "user", content: "try another" },
          { role: "assistant", content: [{ type: "tool_use", id: "call_other_provider_1", name: "batch_read", input: { paths: ["y.txt"] } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "call_other_provider_1", content: "Y" }] },
        ],
      }),
    })
    const bMove2 = await rMove2.json()
    assert.equal(rMove2.status, 200, JSON.stringify(bMove2))
    assert.match(bMove2.content?.[0]?.text || "", /^ok:s-tsm-/)

    // 4. carriedAnswered supersedes cleanly when a carried subset is answered in history, and assistantTextOf skips thinking blocks.
    const rCar1 = await loader.fetch("agy://local/messages", {
      method: "POST",
      body: JSON.stringify({ model: "gemini-test", stream: false, tools, metadata: { user_id: "u-car" }, messages: [{ role: "user", content: "START_DUAL" }] }),
    })
    const bCar1 = await rCar1.json()
    const dualUses = bCar1.content.filter(b => b.type === "tool_use")
    assert.ok(dualUses.length >= 1)
    const rCar2 = await loader.fetch("agy://local/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "gemini-test",
        stream: false,
        tools,
        metadata: { user_id: "u-car" },
        messages: [
          { role: "user", content: "START_DUAL" },
          { role: "assistant", content: [dualUses[0]] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: dualUses[0].id, content: "only first" }] },
          { role: "user", content: "move on without second call" },
        ],
      }),
    })
    const bCar2 = await rCar2.json()
    assert.equal(rCar2.status, 200, JSON.stringify(bCar2))

    // 5. assistantTextOf skips thinking/redacted_thinking blocks in prefill tail.
    const rPrefill = await loader.fetch("agy://local/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "gemini-test",
        stream: false,
        metadata: { user_id: "u-prefill-think" },
        messages: [
          { role: "user", content: "start" },
          { role: "assistant", content: [{ type: "thinking", thinking: "internal" }, { type: "redacted_thinking", data: "x" }, { type: "text", text: "Answer: " }] },
        ],
      }),
    })
    const bPrefill = await rPrefill.json()
    assert.equal(rPrefill.status, 200, JSON.stringify(bPrefill))
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
})


test("sign-in guard checks named accounts, #setModel classifies 401/503/400, and agy models timeout is 45s+", async () => {
  const caseRoot = path.join(root, "stabilize-13a")
  const accountsDir = path.join(caseRoot, "accounts")
  const convDir = path.join(caseRoot, "convs")
  const stateFile = path.join(caseRoot, "state.json")
  const badAccDir = path.join(accountsDir, "badacc")
  const emptyAccDir = path.join(accountsDir, "emptyacc")
  fs.mkdirSync(path.join(badAccDir, "antigravity-cli"), { recursive: true })
  fs.writeFileSync(
    path.join(badAccDir, "antigravity-cli", "antigravity-oauth-token"),
    JSON.stringify({ token: { access_token: "stale-token", expiry: "2020-01-01T00:00:00Z" } }),
  )
  fs.mkdirSync(path.join(emptyAccDir, "antigravity-cli"), { recursive: true })
  fs.writeFileSync(
    path.join(emptyAccDir, "antigravity-cli", "antigravity-oauth-token"),
    JSON.stringify({ token: { access_token: "ok-token", expiry: new Date(Date.now() + 3600_000).toISOString() } }),
  )

  const modeFile = path.join(caseRoot, "mode.txt")
  const acpLog = path.join(caseRoot, "acp-spawns.txt")
  fs.writeFileSync(modeFile, "empty-catalog")
  fs.writeFileSync(acpLog, "")

  const fakeDir = path.join(caseRoot, "bin")
  const fakeBin = writeFakeAgy(fakeDir, `
import fs from "node:fs";
import readline from "node:readline";
const args = process.argv.slice(2);
if (args.includes("--help")) process.exit(0);
if (args.includes("--version")) { console.log("1.5.9"); process.exit(0); }
const mode = fs.readFileSync(${JSON.stringify(modeFile)}, "utf8").trim();
if (args.includes("models")) {
  if (mode === "slow-models") {
    setTimeout(() => { console.log("gemini-test  Gemini Test"); process.exit(0); }, 220);
  } else {
    console.log("gemini-test  Gemini Test");
    process.exit(0);
  }
} else {
  fs.appendFileSync(${JSON.stringify(acpLog)}, mode + "\\n");
  const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
  readline.createInterface({ input: process.stdin }).on("line", line => {
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } }, agentInfo: { name: "fake-agy", version: "1.5.9" } } });
    } else if (msg.method === "session/new") {
      if (mode === "empty-catalog") {
        send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-empty" } });
      } else {
        send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-nonempty", models: { availableModels: [{ modelId: "gemini-test", name: "Gemini Test" }] } } });
      }
    } else if (msg.method === "session/set_model" || msg.method === "session/set_config_option") {
      if (mode === "empty-catalog") {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "Model not found" } });
      } else if (mode === "setmodel-unauth") {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "not logged in" } });
      } else if (mode === "setmodel-bad") {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "Unknown model ID" } });
      } else {
        send({ jsonrpc: "2.0", id: msg.id, result: {} });
      }
    }
  });
}
`)

  const prev = {
    AGY_PATH: process.env.AGY_PATH,
    AGY_BRIDGE_CONVERSATIONS_DIR: process.env.AGY_BRIDGE_CONVERSATIONS_DIR,
    AGY_BRIDGE_ACCOUNTS_DIR: process.env.AGY_BRIDGE_ACCOUNTS_DIR,
    AGY_BRIDGE_STATE_FILE: process.env.AGY_BRIDGE_STATE_FILE,
    AGY_BRIDGE_USAGE: process.env.AGY_BRIDGE_USAGE,
    AGY_BRIDGE_STORED_SIGNIN: process.env.AGY_BRIDGE_STORED_SIGNIN,
    AGY_BRIDGE_DISABLE_KEYCHAIN: process.env.AGY_BRIDGE_DISABLE_KEYCHAIN,
    AGY_BRIDGE_MODELS_TIMEOUT_MS: process.env.AGY_BRIDGE_MODELS_TIMEOUT_MS,
  }
  process.env.AGY_PATH = fakeBin
  process.env.AGY_BRIDGE_CONVERSATIONS_DIR = convDir
  process.env.AGY_BRIDGE_ACCOUNTS_DIR = accountsDir
  process.env.AGY_BRIDGE_STATE_FILE = stateFile
  process.env.AGY_BRIDGE_USAGE = "0"
  process.env.AGY_BRIDGE_DISABLE_KEYCHAIN = "1"

  try {
    // 1. Named account without token fails fast with 401 + X-Magpie-Sign-In: expired before spawning agy.
    delete process.env.AGY_BRIDGE_STORED_SIGNIN
    const { AntigravityBridgePlugin } = await import(`./index.mjs?fixes-13a=${Date.now()}`)
    const pluginBad = await AntigravityBridgePlugin({ magpie: true }, { contextPort: 0 })
    const loaderBad = await pluginBad.auth.loader(async () => ({ type: "api", key: "agy:badacc" }))
    const resUnauth = await loaderBad.fetch("agy://local/messages", {
      method: "POST",
      body: JSON.stringify({ model: "gemini-test", stream: false, messages: [{ role: "user", content: "hi" }] }),
    })
    const bodyUnauth = await resUnauth.json()
    assert.equal(resUnauth.status, 401, JSON.stringify(bodyUnauth))
    assert.equal(bodyUnauth.error?.code, "unauthenticated")
    assert.equal(resUnauth.headers.get("x-magpie-sign-in"), "expired")
    assert.equal(fs.readFileSync(acpLog, "utf8"), "", "must reject before spawning ACP")

    // 2. Empty offered models on session/new + session/set_model rejection -> 503 empty_model_catalog (not 400).
    process.env.AGY_BRIDGE_STORED_SIGNIN = "skip"
    fs.writeFileSync(modeFile, "empty-catalog")
    const plugin = await AntigravityBridgePlugin({ magpie: true }, { contextPort: 0 })
    const loader = await plugin.auth.loader(async () => ({ type: "api", key: "agy:emptyacc" }))
    const resEmpty = await loader.fetch("agy://local/messages", {
      method: "POST",
      body: JSON.stringify({ model: "gemini-test", stream: false, metadata: { user_id: "u-empty" }, messages: [{ role: "user", content: "hi" }] }),
    })
    const bodyEmpty = await resEmpty.json()
    assert.equal(resEmpty.status, 503, JSON.stringify(bodyEmpty))
    assert.equal(bodyEmpty.error?.code, "empty_model_catalog")

    // 3. Non-empty offered models + auth error on session/set_model -> 401 unauthenticated + X-Magpie-Sign-In: expired.
    fs.writeFileSync(modeFile, "setmodel-unauth")
    const resSetUnauth = await loader.fetch("agy://local/messages", {
      method: "POST",
      body: JSON.stringify({ model: "gemini-test", stream: false, metadata: { user_id: "u-setunauth" }, messages: [{ role: "user", content: "hi" }] }),
    })
    const bodySetUnauth = await resSetUnauth.json()
    assert.equal(resSetUnauth.status, 401, JSON.stringify(bodySetUnauth))
    assert.equal(bodySetUnauth.error?.code, "unauthenticated")
    assert.equal(resSetUnauth.headers.get("x-magpie-sign-in"), "expired")
    assert.equal(resSetUnauth.headers.get("x-should-retry"), "false")

    // 4. Non-empty offered models + non-auth error on session/set_model -> 400 unavailable.
    fs.writeFileSync(modeFile, "setmodel-bad")
    const resBadModel = await loader.fetch("agy://local/messages", {
      method: "POST",
      body: JSON.stringify({ model: "gemini-test", stream: false, metadata: { user_id: "u-badmodel" }, messages: [{ role: "user", content: "hi" }] }),
    })
    const bodyBadModel = await resBadModel.json()
    assert.equal(resBadModel.status, 400, JSON.stringify(bodyBadModel))

    // 5. AGY_BRIDGE_MODELS_TIMEOUT_MS configures models probe deadline; default (45s) succeeds when 220ms slow.
    fs.writeFileSync(modeFile, "slow-models")
    const savedMethod = plugin.auth.methods.findLast(m => m.prompts?.some(p => p.key === "name"))
    assert.ok(savedMethod)
    process.env.AGY_BRIDGE_MODELS_TIMEOUT_MS = "50"
    const timedOutAuth = await savedMethod.authorize({ name: "emptyacc" })
    assert.equal(timedOutAuth.type, "failed")
    delete process.env.AGY_BRIDGE_MODELS_TIMEOUT_MS
    const okAuth = await savedMethod.authorize({ name: "emptyacc" })
    assert.equal(okAuth.type, "success", JSON.stringify(okAuth))
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
})


test("oversized system prompts auto-offload to _meta.antigravity.systemPrompt.append while small prompts stay inline", async () => {
  const caseRoot = path.join(root, "auto-system-append-13b")
  const accountsDir = path.join(caseRoot, "accounts")
  const convDir = path.join(caseRoot, "convs")
  const stateFile = path.join(caseRoot, "state.json")
  const logFile = path.join(caseRoot, "events.jsonl")
  fs.mkdirSync(convDir, { recursive: true })
  fs.writeFileSync(logFile, "")

  const fakeDir = path.join(caseRoot, "bin")
  const fakeBin = writeFakeAgy(fakeDir, `
import fs from "node:fs";
import readline from "node:readline";
const args = process.argv.slice(2);
if (args.includes("--help")) process.exit(0);
if (args.includes("--version")) { console.log("1.5.9"); process.exit(0); }
if (args.includes("models")) { console.log("gemini-test  Gemini Test"); process.exit(0); }
const logPath = ${JSON.stringify(logFile)};
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
let count = 0;
readline.createInterface({ input: process.stdin }).on("line", line => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          promptCapabilities: { image: true },
          _meta: { antigravity: { systemPrompt: { append: true } } },
        },
        agentInfo: { name: "fake-agy", version: "1.5.9" },
      },
    });
  } else if (msg.method === "session/new") {
    const sid = "s-app-" + (++count);
    fs.appendFileSync(logPath, JSON.stringify({
      type: "new",
      sid,
      append: msg.params?._meta?.antigravity?.systemPrompt?.append ?? null,
    }) + "\\n");
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: sid } });
  } else if (msg.method === "session/set_model" || msg.method === "session/set_config_option") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  } else if (msg.method === "session/prompt") {
    const sid = msg.params?.sessionId;
    const text = (msg.params?.prompt || []).map(p => p.text || "").join("\\n");
    fs.appendFileSync(logPath, JSON.stringify({
      type: "prompt",
      sid,
      bytes: Buffer.byteLength(text, "utf8"),
      hasInlineSystem: text.includes("<external_system_instructions>"),
    }) + "\\n");
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok:" + sid } } } });
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  }
});
`)

  const prev = {
    AGY_PATH: process.env.AGY_PATH,
    AGY_BRIDGE_CONVERSATIONS_DIR: process.env.AGY_BRIDGE_CONVERSATIONS_DIR,
    AGY_BRIDGE_ACCOUNTS_DIR: process.env.AGY_BRIDGE_ACCOUNTS_DIR,
    AGY_BRIDGE_STATE_FILE: process.env.AGY_BRIDGE_STATE_FILE,
    AGY_BRIDGE_USAGE: process.env.AGY_BRIDGE_USAGE,
    AGY_BRIDGE_SYSTEM_APPEND: process.env.AGY_BRIDGE_SYSTEM_APPEND,
    AGY_BRIDGE_UNLOCKED: process.env.AGY_BRIDGE_UNLOCKED,
  }
  process.env.AGY_PATH = fakeBin
  process.env.AGY_BRIDGE_CONVERSATIONS_DIR = convDir
  process.env.AGY_BRIDGE_ACCOUNTS_DIR = accountsDir
  process.env.AGY_BRIDGE_STATE_FILE = stateFile
  process.env.AGY_BRIDGE_USAGE = "0"
  delete process.env.AGY_BRIDGE_SYSTEM_APPEND
  delete process.env.AGY_BRIDGE_UNLOCKED

  try {
    const { AntigravityBridgePlugin } = await import(`./index.mjs?fixes-13b=${Date.now()}`)
    const plugin = await AntigravityBridgePlugin()
    const loader = await plugin.auth.loader()

    // 1. Small system prompt stays inline when AGY_BRIDGE_SYSTEM_APPEND is unset.
    const rSmall = await loader.fetch("agy://local/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "gemini-test",
        stream: false,
        system: "You are concise.",
        metadata: { user_id: "u-small-sys" },
        messages: [{ role: "user", content: "hello small" }],
      }),
    })
    const bSmall = await rSmall.json()
    assert.equal(rSmall.status, 200, JSON.stringify(bSmall))

    // 2. Oversized 190 KB system prompt auto-offloads into _meta.antigravity.systemPrompt.append, bypassing the 180 KB user limit.
    const largeSystem = "LARGE_SYS_MARKER_" + "S".repeat(190_000)
    const rLarge = await loader.fetch("agy://local/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "gemini-test",
        stream: false,
        system: largeSystem,
        metadata: { user_id: "u-large-sys" },
        messages: [{ role: "user", content: "hello large" }],
      }),
    })
    const bLarge = await rLarge.json()
    assert.equal(rLarge.status, 200, JSON.stringify(bLarge))

    const events = fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l))
    const newEvents = events.filter(e => e.type === "new")
    const promptEvents = events.filter(e => e.type === "prompt")
    assert.equal(newEvents[0]?.append, null)
    assert.equal(promptEvents[0]?.hasInlineSystem, true)
    assert.ok(typeof newEvents[1]?.append === "string" && newEvents[1].append.includes("LARGE_SYS_MARKER_"))
    assert.equal(Buffer.byteLength(newEvents[1].append, "utf8") > 190_000, true)
    assert.equal(promptEvents[1]?.hasInlineSystem, false)
    assert.ok(promptEvents[1]?.bytes < 1000)

    // 3. Explicit AGY_BRIDGE_SYSTEM_APPEND=0 disables auto-offload and rejects the 190 KB inline prompt cleanly with 400.
    process.env.AGY_BRIDGE_SYSTEM_APPEND = "0"
    const rDisabled = await loader.fetch("agy://local/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "gemini-test",
        stream: false,
        system: largeSystem,
        metadata: { user_id: "u-large-disabled" },
        messages: [{ role: "user", content: "hello disabled" }],
      }),
    })
    const bDisabled = await rDisabled.json()
    assert.equal(rDisabled.status, 400, JSON.stringify(bDisabled))
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
})
