import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Probes skill discovery, invocation, completion, and history against a real Host.
 * Private user roots and sixteen project skills make both pages deterministic.
 */
// The workspace lives outside the repository and carries its own package.json:
// project-root detection walks upward until it finds one, so a probe directory
// nested in the checkout would resolve to the checkout's own skill roots.
const workspace = mkdtempSync(join(tmpdir(), "dsh-skills-ws-"));
writeFileSync(join(workspace, "package.json"), JSON.stringify({ name: "skills-probe", private: true }) + "\n");
const home = mkdtempSync(join(tmpdir(), "dsh-native-tui-skills-"));
mkdirSync(home + "/profiles/tui", { recursive: true });
const agentsHome = join(home, "agents");
const bundledSkills = join(home, "bundled-skills");
mkdirSync(agentsHome);
mkdirSync(bundledSkills);

/** Write one project skill with the given frontmatter and body marker. */
function writeSkill(name, description, extra) {
  const dir = join(workspace, ".dsh/skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), [
    "---",
    "name: " + name,
    "description: " + description,
    ...extra,
    "---",
    "",
    "# " + name,
    "",
    "SKILLBODY-" + name.toUpperCase(),
    "",
  ].join("\n"));
}

writeSkill("alpha-skill", "First probe skill.", []);
writeSkill("beta-skill", "Second probe skill.", []);
writeSkill("exit", "Invocable despite the local exit command.", []);
for (let index = 1; index <= 12; index += 1) {
  writeSkill("filler-" + String(index).padStart(2, "0"), "Paging fixture.", []);
}
// The provider's frontmatter keys are hyphenated top-level booleans; the nested
// "invocation" object and camelCase spellings are rejected as legacy.
// Sorting last places the model-only row on the second page.
writeSkill("zzz-model-only-skill", "Hidden from the slash menu.", ["user-invocable: false"]);

/** Bodies of the model-facing turns, in arrival order. */
const requestBodies = [];
const server = createServer((req, res) => {
  if (req.url === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "mock-model", name: "mock-model", context_length: 128000, max_tokens: 4096 }] }));
    return;
  }
  if (req.url === "/v1/chat/completions" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => { body += String(chunk); });
    req.on("end", () => {
      const isTitle = body.includes("Create a concise title");
      // Keep every real turn so the probe can prove the skill body actually
      // reached the model, rather than inferring it from local screen text.
      if (!isTitle) requestBodies.push(body);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const send = obj => res.write("data: " + JSON.stringify(obj) + "\n\n");
      const base = () => ({ id: "chatcmpl-skills", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "mock-model" });
      send({ ...base(), choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
      send({ ...base(), choices: [{ index: 0, delta: { content: isTitle ? "skills probe" : "SKILLS PROBE DONE" }, finish_reason: null }] });
      send({ ...base(), choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      res.write("data: [DONE]\n\n");
      res.end();
    });
    return;
  }
  res.writeHead(404); res.end("not found");
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const port = typeof address === "object" && address !== null ? address.port : 0;

writeFileSync(home + "/profiles/tui/cordis.yml", "# dsh profile root\n[]\n");
writeFileSync(home + "/profiles/tui/package.json", JSON.stringify({
  name: "dsh-profile-tui",
  private: true,
  dependencies: { "dsh-native-tui": "link:" + process.cwd() },
  dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "dsh-native-tui"] } },
}, null, 2) + "\n");
writeFileSync(home + "/profiles/tui/cordis.patch.yml", `- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      mock:
        api: openai-completions
        baseURL: http://127.0.0.1:${port}/v1
        apiKeyEnv: MOCK_API_KEY
        models:
          - id: mock-model
            name: mock-model
            contextWindow: 128000
            maxTokens: 4096
- id: native-tui
  name: dsh-native-tui
  config:
    agentPreset: ptc
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: mock
    model: mock-model
`);
mkdirSync(home + "/profiles/tui/node_modules", { recursive: true });
try { symlinkSync(process.cwd(), home + "/profiles/tui/node_modules/dsh-native-tui", "dir"); }
catch (error) { if (error?.code !== "EEXIST") throw error; }

const entry = join(process.cwd(), "scripts/fake-tty-entry.mjs");
const child = spawn(process.execPath, [entry, "--profile", "tui"], {
  cwd: workspace,
  env: { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: agentsHome, DSH_BUNDLED_SKILL_DIR: bundledSkills, MOCK_API_KEY: "dummy", COLUMNS: "140", LINES: "50", TERM: "xterm-256color", COLORTERM: "truecolor" },
  stdio: ["pipe", "pipe", "pipe"],
});
let out = "";
let err = "";
child.stdout.on("data", d => { out += String(d); });
child.stderr.on("data", d => { err += String(d); });
const strip = text => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
let phase = 0;
let pageTwoSeen = false;
let filtered = false;
let stagedNotice = false;
let stagedName = "";
let invoked = false;
let aliasMenuSeen = false;
let aliasInvoked = false;
let historyRecalled = false;
let historyInvoked = false;
let historyOutputStart = 0;
const started = Date.now();
const write = value => { try { child.stdin.write(value); } catch {} };
const tick = setInterval(() => {
  const text = strip(out);
  if (phase === 0 && text.includes("enter send")) {
    phase = 1;
    write("/skill list\r");
  }
  else if (phase === 1 && /\d+ skills · \d+ user-invocable/.test(text)) {
    phase = 2;
    write("/skill list 2\r");
  }
  else if (phase === 2 && /page 2\/\d+/.test(text)) {
    pageTwoSeen = true;
    phase = 3;
    write("/skill\r");
  }
  else if (phase === 3 && text.includes("Invoke a skill")) {
    phase = 4;
    // Type to filter: the picker is the query surface, and narrowing to one
    // name is also what makes the selection below deterministic.
    write("alpha-skill");
  }
  else if (phase === 4 && text.includes("search: alpha-skill")) {
    filtered = true;
    phase = 5;
    // Enter on the single remaining row stages the invocation.
    write("\r");
  }
  else if (phase === 5 && text.includes("added to the prompt")) {
    stagedNotice = true;
    stagedName = /Skill \/skill:([a-z0-9-]+) added to the prompt/.exec(text)?.[1] ?? "";
    phase = 6;
    // The editor holds the gesture now; one Enter sends it as a prompt.
    write("\r");
  }
  else if (phase === 6 && requestBodies.some(body => body.includes("SKILLBODY-ALPHA-SKILL"))) {
    invoked = true;
    phase = 7;
  }
  else if (phase === 7 && text.includes("SKILLS PROBE DONE")) {
    phase = 8;
    write("/skill:be");
  }
  else if (phase === 8 && text.includes("/skill:beta-skill") && text.includes("Second probe skill.")) {
    aliasMenuSeen = true;
    phase = 9;
    write("\t Use beta instructions\r");
  }
  else if (phase === 9 && requestBodies.some(body => body.includes("SKILLBODY-BETA-SKILL") && body.includes("Use beta instructions"))) {
    aliasInvoked = true;
    phase = 10;
    write("/skill:exit\r");
  }
  else if (phase === 10 && requestBodies.some(body => body.includes("SKILLBODY-EXIT"))) {
    phase = 11;
    historyOutputStart = text.length;
    write("\x1b[A");
  }
  else if (phase === 11 && text.slice(historyOutputStart).includes("› /skill:exit")) {
    historyRecalled = true;
    phase = 12;
    write("\r");
  }
  else if (phase === 12 && requestBodies.filter(body => body.includes("SKILLBODY-EXIT")).length >= 2) {
    historyInvoked = true;
    phase = 13;
    write("\x04");
  }
}, 150);
let timedOut = false;
const hard = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, 45000);
child.on("close", async (code, signal) => {
  clearInterval(tick); clearTimeout(hard);
  await new Promise(resolve => { server.close(resolve); });
  const text = strip(out);
  const checks = {
    "isolates the catalog": text.includes("16 skills · 15 user-invocable · 1 model-only · page 1/2"),
    "names project skills": text.includes("alpha-skill") && text.includes("beta-skill"),
    "badges the root": text.includes("[u,m:project-dsh]"),
    "badges model-only": text.includes("[m:project-dsh]"),
    "shows descriptions": text.includes("First probe skill."),
    "pages forward": pageTwoSeen,
    "filters the picker": filtered,
    "stages instead of sending": stagedNotice,
    "stages the named skill": stagedName === "alpha-skill",
    // The decisive check: the skill body reached the model after one Enter,
    // which is the whole invocation contract.
    "invokes the staged skill": invoked,
    "completes namespaced skills": aliasMenuSeen,
    "invokes alias with instructions": aliasInvoked,
    "recalls namespaced history": historyRecalled,
    "replays skill instead of exiting": historyInvoked,
    "prints no error notice": !/Could not list skills|skill service is unavailable/.test(text),
  };
  const pass = !timedOut && code === 0 && signal === null && phase === 13 && Object.values(checks).every(Boolean);
  console.log("EXIT", code, signal, "phase", phase, "timedOut", timedOut, "elapsed", Date.now() - started);
  console.log("checks", JSON.stringify(checks));
  console.log("RESULT", pass ? "PASS" : "FAIL");
  for (const line of text.split("\n")) {
    if (/skill|Skill/.test(line) && line.trim() !== "") console.log("| " + line.trim());
  }
  if (!pass) {
    console.log("--- stderr ---");
    console.log(err.slice(-4000));
  }
  rmSync(workspace, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  process.exitCode = pass ? 0 : 1;
});
