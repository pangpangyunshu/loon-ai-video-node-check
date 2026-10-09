"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const checker = require("../NodeServiceCheck.js");

const EPOCH = Date.UTC(2026, 9, 9, 8);
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const service = (id) => checker.services.find((entry) => entry.id === id);
const response = (body, status = 200, extra = {}) => ({
  body, status, error: "", url: "https://chatgpt.com/", headers: {}, ...extra,
});
const playerHTML = (player) =>
  "<html><title>YouTube</title><script>var ytInitialPlayerResponse = " +
  JSON.stringify(player) + "; window.afterPlayer = {\"ignored\":true};</script></html>";
const normalPlayer = () => ({
  playabilityStatus: { status: "OK" },
  streamingData: { formats: [{ bitrate: 100, url: "https://r1.googlevideo.com/videoplayback?test=1" }] },
});
const pageFor = (url) => {
  if (/youtube\.com/.test(url)) return playerHTML(normalPlayer());
  if (/tiktok\.com/.test(url)) {
    return '<title>TikTok</title><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">' +
      JSON.stringify({ __DEFAULT_SCOPE__: { "webapp.app-context": { region: "SG" } } }) +
      "</script>";
  }
  if (/claude\.ai/.test(url)) return "<title>Claude</title>";
  if (/gemini\.google\.com/.test(url)) return "<title>Google Gemini</title>";
  return "<title>ChatGPT</title>";
};

// Fake timers have no Node handles and intentionally provide no clearTimeout,
// matching the Loon runtime. Advancing time also drains Promise microtasks.
function harness(input = {}) {
  let now = EPOCH;
  let timerID = 0;
  let activeHTTP = 0;
  let peakHTTP = 0;
  const timers = [];
  const requests = [];
  const outputs = [];
  const snapshots = [];
  const groupCalls = [];
  const members = input.members || {};
  const selected = input.selected || {};
  const later = (callback, delay) => {
    timers.push({ id: ++timerID, due: now + Math.max(0, Number(delay) || 0), callback });
    return timerID;
  };
  const invokeHTTP = (method, options, callback) => {
    requests.push({ method, ...options });
    activeHTTP++;
    peakHTTP = Math.max(peakHTTP, activeHTTP);
    let completed = false;
    const answer = (error, result, body) => {
      if (!completed) { completed = true; activeHTTP--; }
      callback(error, result, body);
    };
    if (input.http) return input.http({ method, options, answer, later });
    const complete = () => {
      if (method === "head") answer(null, { status: 206, headers: { "Content-Type": "video/mp4" } }, "");
      else answer(null, { status: 200, headers: { "Content-Type": "text/html" } }, pageFor(options.url));
    };
    if (input.httpDelay) later(complete, input.httpDelay);
    else complete();
  };
  const runtime = {
    argument: input.argument || {},
    params: input.params || {},
    config: input.config || {
      getConfig: () => input.summary === undefined ? { all_policy_groups: [] } : input.summary,
      getSubPolicies(name, callback) {
        groupCalls.push(name);
        if (!Object.hasOwn(members, name)) throw new Error("No group: " + name);
        if (members[name] instanceof Error) throw members[name];
        callback(members[name]);
      },
      getSelectedPolicy: (name) => selected[name] || "",
    },
    now: () => now,
    later,
    http: {
      get: (options, callback) => invokeHTTP("get", options, callback),
      head: (options, callback) => invokeHTTP("head", options, callback),
    },
    done: (output) => outputs.push(output),
    store: {
      write(value, key) { snapshots.push({ key, report: JSON.parse(value) }); return true; },
    },
  };
  async function advance(milliseconds) {
    const end = now + milliseconds;
    await flush();
    while (true) {
      timers.sort((a, b) => a.due - b.due || a.id - b.id);
      if (!timers.length || timers[0].due > end) break;
      const timer = timers.shift();
      now = timer.due;
      timer.callback();
      await flush();
    }
    now = end;
    await flush();
  }
  async function untilDone(limit = 40000) {
    const end = now + limit;
    await flush();
    while (!outputs.length) {
      timers.sort((a, b) => a.due - b.due || a.id - b.id);
      assert.ok(timers.length && timers[0].due <= end, "run must finish within the fake-clock budget");
      await advance(timers[0].due - now);
    }
  }
  return {
    runtime, requests, outputs, snapshots, groupCalls, advance, untilDone,
    get activeHTTP() { return activeHTTP; },
    get peakHTTP() { return peakHTTP; },
  };
}

test("arguments accept plugin JSON, clamp budgets, and select core services", () => {
  const options = checker.options(JSON.stringify({
    group_name: "  Group  ", node_name: "  Leaf  ", scope: "core",
    parallel: 999, max_nodes: -1, request_timeout: 10, total_seconds: 999,
    start_index: 0, include_direct: "true",
  }));
  assert.equal(options.group, "Group");
  assert.equal(options.node, "Leaf");
  assert.deepEqual(options.services.map((entry) => entry.id), ["chatgpt", "youtube", "tiktok"]);
  assert.equal(options.parallel, 3);
  assert.equal(options.maxNodes, 1);
  assert.equal(options.requestTimeout, 1000);
  assert.equal(options.totalMs, 270000);
  assert.equal(options.startIndex, 1);
  assert.equal(options.includeDirect, true);
  assert.equal(checker.options("{invalid").mode, "auto");
});

test("getSubPolicies accepts newer JSON strings and legacy arrays", async () => {
  for (const value of ['["Leaf A","Leaf B"]', ["Leaf A", "Leaf B"]]) {
    const env = harness({ members: { Root: value } });
    assert.deepEqual(await checker.readMembers(env.runtime, "Root", EPOCH + 12000), ["Leaf A", "Leaf B"]);
  }
});

test("getSubPolicies rejects invalid structures and ignores duplicate callbacks", async () => {
  for (const value of ['{"policies":["Leaf"]}', "[null]", '[""]', "not json"]) {
    const env = harness({ members: { Root: value } });
    await assert.rejects(checker.readMembers(env.runtime, "Root", EPOCH + 12000));
  }
  const env = harness({ config: { getSubPolicies(name, callback) { callback('["First"]'); callback('["Late"]'); } } });
  assert.deepEqual(await checker.readMembers(env.runtime, "Root", EPOCH + 12000), ["First"]);
});

test("getSubPolicies has a bounded timeout without clearTimeout", async () => {
  const env = harness({ config: { getSubPolicies() {} } });
  const pending = assert.rejects(checker.readMembers(env.runtime, "Root", EPOCH + 12000), /超时/);
  await env.advance(2000);
  await pending;
});

test("nested group traversal breaks cycles, preserves order, and filters reserved policies", async () => {
  const env = harness({
    summary: { all_policy_groups: ["Root", "Nested"] },
    members: {
      Root: '["Leaf A","Nested","Leaf B","DIRECT","REJECT","REJECT-DROP","PROXY","Leaf A"]',
      Nested: ["Root", "Leaf B", "Leaf C", "Nested"],
    },
  });
  const warnings = [];
  const nodes = await checker.enumerate(env.runtime, "Root", { all_policy_groups: ["Root", "Nested"] }, checker.options({}), warnings);
  assert.deepEqual(nodes, ["Leaf A", "Leaf B", "Leaf C"]);
  assert.deepEqual(env.groupCalls, ["Root", "Nested"]);
  assert.deepEqual(warnings, []);
});

test("DIRECT is enumerated once only when explicitly enabled", async () => {
  const env = harness({ members: { Root: ["DIRECT", "DIRECT", "REJECT", "Leaf"] } });
  assert.deepEqual(
    await checker.enumerate(env.runtime, "Root", { all_policy_groups: ["Root"] }, checker.options({ include_direct: true }), []),
    ["DIRECT", "Leaf"],
  );
});

test("failed nested groups are warned about and never tested as nodes", async () => {
  const env = harness({
    members: { Root: ["Broken", "Leaf"], Broken: new Error("Broken group") },
  });
  const warnings = [];
  assert.deepEqual(
    await checker.enumerate(env.runtime, "Root", { all_policy_groups: ["Root", "Broken"] }, checker.options({}), warnings),
    ["Leaf"],
  );
  assert.match(warnings.join(" "), /未展开策略组 Broken/);
});

test("auto group context stays batch even with a configured fallback node", async () => {
  const env = harness({
    params: { policyGroup: "Root" },
    summary: JSON.stringify({ all_policy_groups: ["Root"] }),
    members: { Root: '["Leaf A","Leaf B"]' },
  });
  const target = await checker.targets(env.runtime, checker.options({ node_name: "Fallback" }), []);
  assert.deepEqual(target, { mode: "batch", source: "Root", nodes: ["Leaf A", "Leaf B"] });
});

test("explicit node context defaults to one node, while explicit group overrides it", async () => {
  const env = harness({
    params: { policyGroup: "Root", nodeInfo: JSON.stringify({ name: "Context Leaf" }) },
    summary: { all_policy_groups: ["Root"] }, members: { Root: ["Group Leaf"] },
  });
  assert.deepEqual(await checker.targets(env.runtime, checker.options({}), []),
    { mode: "single", source: "Context Leaf", nodes: ["Context Leaf"] });
  assert.deepEqual(await checker.targets(env.runtime, checker.options({ group_name: "Root" }), []),
    { mode: "batch", source: "Root", nodes: ["Group Leaf"] });
});

test("legacy params.node group context is enumerated", async () => {
  const env = harness({
    params: { node: "Root" },
    summary: { all_policy_groups: ["Root"] }, members: { Root: ["Leaf"] },
  });
  assert.equal((await checker.targets(env.runtime, checker.options({}), [])).mode, "batch");
});

test("failed root enumeration follows selected nested groups to an actual leaf", async () => {
  const env = harness({
    params: { policyGroup: "Root" },
    summary: { all_policy_groups: ["Root", "Nested"] },
    members: { Root: new Error("API unavailable") },
    selected: { Root: "Nested", Nested: "Leaf" },
  });
  const warnings = [];
  assert.deepEqual(await checker.targets(env.runtime, checker.options({}), warnings),
    { mode: "single", source: "Leaf", nodes: ["Leaf"] });
  assert.match(warnings.join(" "), /批量读取失败/);
});

test("missing group list cannot treat an unknown group as a leaf fallback", async () => {
  const env = harness({
    params: { policyGroup: "Unknown Group", node: "Unknown Group" },
    summary: {}, members: { "Unknown Group": ["Leaf"] },
    selected: { "Unknown Group": "Leaf" },
  });
  await assert.rejects(checker.targets(env.runtime, checker.options({}), []), /未取得明确/);
  assert.deepEqual(env.groupCalls, [], "without a group list nested membership must not be guessed");
});

test("enumeration failure can fall back to a configured concrete node", async () => {
  const env = harness({
    params: { policyGroup: "Root" }, summary: {}, members: {},
  });
  const warnings = [];
  assert.deepEqual(await checker.targets(env.runtime, checker.options({ node_name: "Fallback Leaf" }), warnings),
    { mode: "single", source: "Fallback Leaf", nodes: ["Fallback Leaf"] });
  assert.match(warnings.join(" "), /无法取得策略组清单/);
});

test("selected-policy loops and reject policies never become probe targets", async () => {
  const env = harness({
    params: { policyGroup: "Root" },
    summary: { all_policy_groups: ["Root", "Nested"] },
    members: { Root: new Error("API unavailable") },
    selected: { Root: "Nested", Nested: "Root" },
  });
  await assert.rejects(checker.targets(env.runtime, checker.options({}), []), /未取得明确/);
  for (const node_name of ["REJECT", "REJECT-DROP", "PROXY"]) {
    await assert.rejects(checker.targets(harness().runtime, checker.options({ node_name }), []));
  }
});

test("single DIRECT respects the include_direct opt-in", async () => {
  await assert.rejects(checker.targets(harness().runtime, checker.options({ node_name: "DIRECT" }), []), /DIRECT|直连/);
  assert.deepEqual(await checker.targets(harness().runtime, checker.options({ node_name: "DIRECT", include_direct: true }), []),
    { mode: "single", source: "DIRECT", nodes: ["DIRECT"] });
});

test("missing node context finishes with guidance and sends no HTTP requests", async () => {
  const env = harness();
  const report = await checker.run(env.runtime);
  assert.equal(env.requests.length, 0);
  assert.equal(env.outputs.length, 1);
  assert.equal(env.snapshots.length, 1);
  assert.match(report.warnings.join(" "), /未取得明确/);
});

test("200 empty bodies, Cloudflare challenges, 403, 429, and 5xx never report success", () => {
  for (const entry of checker.services) {
    for (const res of [
      response(""),
      response("<title>Just a moment...</title>", 403),
      response(pageFor(entry.url), 200, { headers: { "CF-Mitigated": "challenge" } }),
      response(pageFor(entry.url), 403),
      response(pageFor(entry.url), 429),
      response(pageFor(entry.url), 503),
    ]) {
      assert.equal(checker.classifyPage(entry, res).state, "unknown", entry.id + " / " + res.status);
    }
  }
});

test("only explicit regional evidence yields restricted", () => {
  assert.equal(checker.classifyPage(service("chatgpt"), response('{"error":{"code":"unsupported_country_region"}}', 403)).state, "restricted");
  assert.equal(checker.classifyPage(service("claude"), response("", 302, { url: "https://www.anthropic.com/app-unavailable-in-region" })).state, "restricted");
  assert.equal(checker.classifyPage(service("chatgpt"), response("<title>ChatGPT</title><p>Not available in your country</p>")).state, "restricted");
  assert.equal(checker.classifyPage(service("chatgpt"), response("", 0, { error: "timed out", timeout: true })).state, "unknown");
  assert.equal(checker.classifyPage(service("chatgpt"), response("", 0, { error: "TLS error" })).state, "unreachable");
});

test("region phrases inside script/style do not restrict an otherwise normal page", () => {
  const body = "<title>ChatGPT</title>" +
    '<script>window.messages = {"error":"Not available in your country"};</script>' +
    "<style>.note::after { content: 'your country is not supported' }</style>" +
    "<p>Welcome</p>";
  assert.equal(checker.classifyPage(service("chatgpt"), response(body)).state, "reachable");
});

test("Google login/consent and TikTok information pages do not establish service reachability", () => {
  assert.equal(checker.classifyPage(service("gemini"), response("<title>Google Gemini</title>", 200, { url: "https://accounts.google.com/login" })).state, "unknown");
  assert.equal(checker.classifyPage(service("tiktok"), response("<title>TikTok</title>", 200, { url: "https://www.tiktok.com/about" })).state, "unknown");
});

test("TikTok explicit Hong Kong notfound redirect is region-restricted", () => {
  assert.equal(checker.classifyPage(service("tiktok"),
    response("<title>TikTok</title>", 200, { url: "https://www.tiktok.com/hk/notfound" })).state, "restricted");
});

test("YouTube JSON extraction handles nested braces, quoted braces, and escapes", () => {
  const player = {
    playabilityStatus: { status: "OK", reason: 'quoted "}" and "{", slash \\ and nested braces {}' },
    streamingData: {
      formats: [
        { bitrate: 1, url: "https://googlevideo.com.attacker.invalid/video" },
        { bitrate: 200, url: "https://r2.googlevideo.com/video?x=2" },
      ],
      adaptiveFormats: [{ bitrate: 50, url: "https://r1.googlevideo.com/video?x=1" }],
    },
  };
  const html = playerHTML(player);
  assert.deepEqual(checker.extractObject(html, "ytInitialPlayerResponse"), player);
  assert.deepEqual(checker.youtubeInfo(html), { status: "OK", reason: player.playabilityStatus.reason, media: "https://r1.googlevideo.com/video?x=1" });
  assert.equal(checker.extractObject('ytInitialPlayerResponse = {"broken":', "ytInitialPlayerResponse"), null);
  assert.equal(checker.youtubeInfo("<title>YouTube</title>"), null);
});

test("TikTok current region metadata is a hint and untrusted media hosts are rejected", () => {
  const html = '<title>TikTok</title><script type="application/json" id="__UNIVERSAL_DATA_FOR_REHYDRATION__">' +
    JSON.stringify({ __DEFAULT_SCOPE__: { "webapp.app-context": { region: "sg" } } }) +
    '</script><script id="SIGI_STATE">' +
    JSON.stringify({ ItemModule: { item: { video: { playAddr: "https://tiktokcdn.com.attacker.invalid/video" } } } }) +
    "</script>";
  assert.deepEqual(checker.tiktokInfo(html), { region: "SG", media: "" });
  assert.equal(checker.classifyPage(service("tiktok"), response(html, 200, { url: service("tiktok").url })).state, "reachable");
});

test("TikTok legacy SIGI_STATE supports nested AppContext.appContext.region", () => {
  const html = '<script id="SIGI_STATE">' +
    JSON.stringify({
      AppContext: { appContext: { region: "JP" } },
      ItemModule: { item: { video: { playAddr: "https://v16.tiktokcdn.com/public-video" } } },
    }) + "</script>";
  assert.deepEqual(checker.tiktokInfo(html), { region: "JP", media: "https://v16.tiktokcdn.com/public-video" });
});

test("allowed redirect targets use HTTPS and proper domain boundaries", () => {
  assert.equal(checker.allowed("https://r1.googlevideo.com/video", ["googlevideo.com"]), true);
  for (const url of ["http://googlevideo.com/video", "https://googlevideo.com.attacker.invalid/video", "https://notgooglevideo.com/video", "https://googlevideo.com@attacker.invalid/video"]) {
    assert.equal(checker.allowed(url, ["googlevideo.com"]), false, url);
  }
  assert.equal(checker.redirectURL("https://chatgpt.com/login", "/auth"), "https://chatgpt.com/auth");
  assert.equal(checker.redirectURL("https://chatgpt.com/login", "http://insecure.example/"), "");
});

test("each page/CDN request pins the leaf node, validates TLS, and disables automatic cookies/redirects", async () => {
  const env = harness({ argument: { node_name: "Pinned Leaf" } });
  const report = await checker.run(env.runtime);
  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].results.youtube.state, "pass");
  assert.equal(report.rows[0].results.chatgpt.state, "reachable");
  assert.ok(env.requests.some((request) => request.method === "head"));
  for (const request of env.requests) {
    assert.equal(request.node, "Pinned Leaf");
    assert.equal(request.insecure, false);
    assert.equal(request["auto-cookie"], false);
    assert.equal(request["auto-redirect"], false);
    assert.ok(request.timeout > 0 && request.timeout <= 10000);
    assert.equal(request.headers["Cache-Control"], "no-cache");
    assert.ok(request.headers["User-Agent"]);
  }
  assert.equal(env.outputs.length, 1);
  assert.equal(env.snapshots[0].key, "loon.node-service-check.last");
});

test("YouTube player and CDN outcomes retain their precise detection level", async () => {
  const cases = [
    { player: null, state: "reachable" },
    { player: { playabilityStatus: { status: "LOGIN_REQUIRED", reason: "Sign in to confirm you're not a bot" } }, state: "unknown" },
    { player: { playabilityStatus: { status: "UNPLAYABLE", reason: "This video is not available in your country" } }, state: "restricted" },
    { player: { playabilityStatus: { status: "OK" }, streamingData: { formats: [{ signatureCipher: "requires deciphering" }] } }, state: "limited" },
    { player: normalPlayer(), cdnStatus: 403, state: "limited" },
  ];
  for (const entry of cases) {
    const env = harness({
      argument: { node_name: "Leaf", scope: "core" },
      http({ method, options, answer }) {
        if (method === "head") answer(null, { status: entry.cdnStatus || 206, headers: { "content-type": "video/mp4" } }, "");
        else if (/youtube\.com/.test(options.url)) answer(null, { status: 200, headers: {} }, entry.player ? playerHTML(entry.player) : "<title>YouTube</title>");
        else answer(null, { status: 200, headers: {} }, pageFor(options.url));
      },
    });
    const report = await checker.run(env.runtime);
    assert.equal(report.rows[0].results.youtube.state, entry.state);
  }
});

test("TikTok public media is checked with HEAD and signed URLs are not persisted", async () => {
  const signedURL = "https://v16.tiktokcdn.com/public-video?signature=not-for-report";
  const body = '<title>TikTok</title><script id="SIGI_STATE">' +
    JSON.stringify({
      AppContext: { region: "SG" },
      ItemModule: { item: { video: { playAddr: signedURL } } },
    }) + "</script>";
  const env = harness({
    argument: { node_name: "Leaf", scope: "core" },
    http({ method, options, answer }) {
      if (method === "head") answer(null, { status: 200, headers: { "content-type": "video/mp4" } }, "");
      else if (/tiktok\.com/.test(options.url)) answer(null, { status: 200, headers: {} }, body);
      else answer(null, { status: 200, headers: {} }, pageFor(options.url));
    },
  });
  const report = await checker.run(env.runtime);
  assert.equal(report.rows[0].results.tiktok.state, "pass");
  assert.match(report.rows[0].results.tiktok.detail, /SIM|设备|账号/);
  const mediaRequests = env.requests.filter((request) => request.url === signedURL);
  assert.equal(mediaRequests.length, 1);
  assert.equal(mediaRequests[0].method, "head");
  assert.equal(JSON.stringify(env.snapshots[0].report).includes("signature=not-for-report"), false);
});

test("safe redirects keep the pinned node and foreign redirects are not followed", async () => {
  let redirected = false;
  const env = harness({
    argument: { node_name: "Pinned Leaf", scope: "core" },
    http({ method, options, answer }) {
      if (options.url === "https://chatgpt.com/") {
        answer(null, { status: 302, headers: { Location: "https://auth.openai.com/login" } }, "");
      } else if (options.url === "https://auth.openai.com/login") {
        redirected = true;
        answer(null, { status: 200, headers: {} }, "<title>ChatGPT</title>");
      } else if (/tiktok\.com/.test(options.url)) {
        answer(null, { status: 302, headers: { Location: "https://attacker.invalid/login" } }, "");
      } else if (method === "head") {
        answer(null, { status: 206, headers: { "content-type": "video/mp4" } }, "");
      } else answer(null, { status: 200, headers: {} }, pageFor(options.url));
    },
  });
  const report = await checker.run(env.runtime);
  assert.equal(redirected, true);
  assert.ok(env.requests.every((request) => request.node === "Pinned Leaf"));
  assert.equal(env.requests.some((request) => /attacker/.test(request.url)), false);
  assert.equal(report.rows[0].results.tiktok.state, "unknown");
  assert.match(report.rows[0].results.tiktok.detail, /未识别的域名/);
});

test("all nodes and services share a maximum of four concurrent HTTP requests", async () => {
  const env = harness({
    argument: { group_name: "Root", parallel: 3, max_nodes: 3 },
    summary: { all_policy_groups: ["Root"] }, members: { Root: ["A", "B", "C"] },
    httpDelay: 50,
  });
  const pending = checker.run(env.runtime);
  await env.untilDone();
  const report = await pending;
  assert.equal(env.peakHTTP, 4);
  assert.equal(env.activeHTTP, 0);
  assert.ok(report.rows.every((row) => row.complete));
  assert.ok(env.requests.length >= 15);
  assert.equal(env.outputs.length, 1);
});

test("batch start_index/max_nodes reports the next untested position", async () => {
  const env = harness({
    argument: { group_name: "Root", start_index: 3, max_nodes: 2, scope: "core" },
    summary: { all_policy_groups: ["Root"] }, members: { Root: ["A", "B", "C", "D", "E", "F"] },
  });
  const report = await checker.run(env.runtime);
  assert.deepEqual(report.rows.map((row) => row.name), ["C", "D"]);
  assert.equal(report.total, 6);
  assert.equal(report.nextIndex, 5);
  assert.ok(env.requests.every((request) => ["C", "D"].includes(request.node)));
  assert.match(env.outputs[0].htmlMessage, /下一批/);
  const finalBatch = harness({
    argument: { group_name: "Root", start_index: 5, max_nodes: 2, scope: "core" },
    summary: { all_policy_groups: ["Root"] }, members: { Root: ["A", "B", "C", "D", "E", "F"] },
  });
  assert.equal((await checker.run(finalBatch.runtime)).nextIndex, 0);
});

test("late HTTP callbacks and leftover total timer cannot invoke done or update a saved report again", async () => {
  const env = harness({
    argument: { node_name: "Slow", scope: "core", request_timeout: 1000, total_seconds: 30 },
    http({ options, answer, later }) {
      later(() => answer(null, { status: 200, headers: {} }, pageFor(options.url)), 1500);
    },
  });
  const pending = checker.run(env.runtime);
  await env.advance(1100);
  const report = await pending;
  const frozen = JSON.stringify(report);
  assert.ok(Object.values(report.rows[0].results).every((result) => result.state === "unknown"));
  assert.equal(env.outputs.length, 1);
  await env.advance(40000);
  assert.equal(env.outputs.length, 1);
  assert.equal(env.snapshots.length, 1);
  assert.equal(JSON.stringify(report), frozen);
});

test("total deadline preserves pending entries, resumes from first incomplete row, and sends no later requests", async () => {
  const env = harness({
    argument: { group_name: "Root", max_nodes: 6, parallel: 2, request_timeout: 10000, total_seconds: 30 },
    summary: { all_policy_groups: ["Root"] }, members: { Root: ["A", "B", "C", "D", "E", "F"] },
    http() { /* Transport never returns; script-level deadlines must finish. */ },
  });
  const pending = checker.run(env.runtime);
  await env.advance(30000);
  assert.equal(env.outputs.length, 1);
  const saved = env.snapshots[0].report;
  assert.match(saved.warnings.join(" "), /总时限已到/);
  assert.ok(saved.rows.some((row) => !row.complete));
  assert.ok(saved.rows.some((row) => Object.values(row.results).some((result) => result.state === "pending")));
  assert.equal(saved.nextIndex, saved.rows.findIndex((row) => !row.complete) + 1);
  assert.match(env.outputs[0].htmlMessage, /未全部完成/);
  const requestCount = env.requests.length;
  await env.advance(60000);
  await pending;
  assert.equal(env.requests.length, requestCount);
  assert.equal(env.outputs.length, 1);
  assert.equal(env.snapshots.length, 1);
});

test("render escapes node names and details instead of executing page-supplied HTML", () => {
  const report = {
    mode: "single", source: '<img src=x onerror="alert(1)">', total: 1,
    rows: [{ name: "<script>bad()</script>", complete: true, results: { chatgpt: { state: "unknown", label: "Unknown", detail: "<b>bad</b>", ms: 1 } } }],
    warnings: ["<script>warning()</script>"], services: [service("chatgpt")],
    time: "2026-10-09", elapsedMs: 1, nextIndex: 0,
  };
  const html = checker.render(report);
  assert.ok(!html.includes("<script>bad()"));
  assert.ok(!html.includes("<img src=x"));
  assert.ok(html.includes("&lt;script&gt;bad()&lt;/script&gt;"));
  assert.ok(html.includes("&lt;b&gt;bad&lt;/b&gt;"));
});
