/*
 * Loon 节点 AI / 视频检测 v1.0.0
 * Generic 脚本：策略组批量优先，枚举失败时回退到明确的单个节点。
 * 不修改策略选择，不使用 MitM、登录 Cookie、API Key 或付费接口。
 * 官网可达不等于账号/对话/App 可用；报告保留检测层级。
 */
var NodeServiceCheck = (function () {
  "use strict";
  var UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  var SERVICES = [
    { id: "chatgpt", name: "ChatGPT", url: "https://chatgpt.com/", hosts: ["chatgpt.com", "chat.openai.com", "auth.openai.com", "auth0.openai.com"] },
    { id: "claude", name: "Claude", url: "https://claude.ai/", hosts: ["claude.ai", "anthropic.com"] },
    { id: "gemini", name: "Gemini", url: "https://gemini.google.com/app?hl=en", hosts: ["gemini.google.com", "accounts.google.com", "consent.google.com"] },
    { id: "youtube", name: "YouTube", url: "https://www.youtube.com/watch?v=jNQXAC9IVRw&hl=en", hosts: ["youtube.com", "consent.youtube.com", "accounts.google.com", "consent.google.com"] },
    { id: "tiktok", name: "TikTok", url: "https://www.tiktok.com/explore", hosts: ["tiktok.com"] }
  ];
  var LABELS = {
    pass: "✅ 链路通过", reachable: "🌐 网页可达", restricted: "⛔ 明确受限",
    limited: "⚠️ 部分通过", unknown: "❔ 无法确认", unreachable: "❌ 连接失败", pending: "⏳ 未完成"
  };

  function bounded(value, fallback, low, high) {
    var number = Number(value);
    return value === "" || value == null || !isFinite(number) ? fallback : Math.max(low, Math.min(high, Math.floor(number)));
  }
  function options(argument) {
    var arg = argument || {};
    if (typeof arg === "string") {
      try { arg = JSON.parse(arg); } catch (_) { arg = {}; }
    }
    if (!arg || typeof arg !== "object" || Array.isArray(arg)) arg = {};
    return {
      mode: ["auto", "batch", "single"].indexOf(arg.mode) >= 0 ? arg.mode : "auto",
      group: typeof arg.group_name === "string" ? arg.group_name.trim() : "",
      node: typeof arg.node_name === "string" ? arg.node_name.trim() : "",
      maxNodes: bounded(arg.max_nodes, 20, 1, 100),
      startIndex: bounded(arg.start_index, 1, 1, 10000),
      parallel: bounded(arg.parallel, 2, 1, 3),
      requestTimeout: bounded(arg.request_timeout, 5000, 1000, 10000),
      totalMs: bounded(arg.total_seconds, 240, 30, 270) * 1000,
      includeDirect: arg.include_direct === true || arg.include_direct === "true",
      services: arg.scope === "core" ? SERVICES.filter(function (s) { return ["chatgpt", "youtube", "tiktok"].indexOf(s.id) >= 0; }) : SERVICES
    };
  }
  function header(headers, name) {
    var keys = Object.keys(headers || {});
    for (var i = 0; i < keys.length; i++) if (keys[i].toLowerCase() === name.toLowerCase()) return String(headers[keys[i]]);
    return "";
  }
  function host(url) {
    var match = /^https:\/\/([^/?#]+)(?:[/?#]|$)/i.exec(url || "");
    return match ? match[1].toLowerCase() : "";
  }
  function allowed(url, hosts) {
    var domain = host(url);
    return !!domain && hosts.some(function (h) { return domain === h || domain.slice(-(h.length + 1)) === "." + h; });
  }
  function redirectURL(base, location) {
    if (/^https:\/\//i.test(location)) return location;
    if (/^\/\//.test(location)) return "https:" + location;
    var origin = /^https:\/\/[^/?#]+/i.exec(base);
    if (!origin || !location || /^[a-z][a-z0-9+.-]*:/i.test(location)) return "";
    if (location[0] === "/") return origin[0] + location;
    if (location[0] === "?") return base.split(/[?#]/)[0] + location;
    if (location[0] === "#") return base.split("#")[0] + location;
    var path = base.slice(origin[0].length).split(/[?#]/)[0] || "/";
    return origin[0] + path.replace(/[^/]*$/, "") + location;
  }
  function escapeHTML(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; });
  }
  function visibleText(body) {
    return String(body || "").replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ").replace(/&(?:nbsp|quot|#39|amp);/g, " ").replace(/\s+/g, " ").trim();
  }
  function json(body) { try { return JSON.parse(body); } catch (_) { return null; } }
  function outcome(state, detail, elapsed) { return { state: state, label: LABELS[state], detail: detail, ms: elapsed || 0 }; }
  function structuredError(body) {
    var data = json(body);
    if (!data || typeof data !== "object") return "";
    var error = data.error || data;
    return typeof error === "string" ? error : [error.code, error.type, error.message].filter(Boolean).join(" ");
  }
  function restriction(response) {
    var text = visibleText(response.body);
    var error = structuredError(response.body);
    var url = response.url || "";
    if (/^https:\/\/(?:www\.)?tiktok\.com\/hk\/notfound(?:[/?#]|$)/i.test(url)) return "TikTok 跳转到香港地区不可用入口";
    if (/app-unavailable-in-region|\/unsupported-country|\/country-not-supported/i.test(url)) return "站点跳转到地区不可用页面";
    if (/unsupported_country|country_not_supported|region_not_supported|geo_blocked/i.test(error)) return "站点返回地区限制错误";
    if (/(?:not (?:yet )?(?:available|supported)|unavailable) in (?:your|this) (?:country|region)|your country is not supported|access (?:is )?(?:unavailable|restricted) (?:in|from) your (?:country|region)|所在(?:国家|地区).{0,16}(?:不支持|不可用)|不支持您所在的(?:国家|地区)/i.test(text)) return "页面明确提示当前地区不受支持";
    return "";
  }
  function baseProblem(response) {
    if (response.error) return outcome(response.timeout ? "unknown" : "unreachable", response.timeout ? "请求超时；不据此判断地区封锁" : "连接、DNS 或 TLS 请求失败");
    var denied = restriction(response);
    if (denied) return outcome("restricted", denied + "（HTTP " + response.status + "）");
    if (header(response.headers, "cf-mitigated").toLowerCase() === "challenge" || /<title[^>]*>\s*(?:Just a moment|Attention Required|Security Verification)/i.test(response.body) || /id=["']challenge-form["']/i.test(response.body) || /verify (?:that )?you(?:'re| are) (?:a )?human|verify to continue|complete (?:the|this) (?:security check|captcha)|unusual traffic from your computer|please (?:solve|complete) (?:the )?captcha|请完成安全验证|请验证您是人类/i.test(visibleText(response.body))) return outcome("unknown", "遇到反机器人验证；脚本不能代替浏览器完成验证");
    if (response.status === 429) return outcome("unknown", "HTTP 429：限流，稍后再测");
    if (response.status === 403 || response.status === 451) return outcome("unknown", "HTTP " + response.status + "：拒绝请求，未获得明确地区限制证据");
    if (response.status >= 500) return outcome("unknown", "HTTP " + response.status + "：站点或上游暂时异常");
    if (response.redirectIssue) return outcome("unknown", response.redirectIssue);
    if (response.status < 200 || response.status >= 300) return outcome("unknown", "HTTP " + response.status + "：未得到正常页面");
    if (!response.body) return outcome("unknown", "空响应；不能凭 HTTP 状态判断服务可用");
    return null;
  }
  function classifyPage(service, response) {
    var problem = baseProblem(response);
    if (problem) return problem;
    var body = response.body;
    var fingerprint = {
      chatgpt: /<title[^>]*>[^<]*ChatGPT|id=["']__NEXT_DATA__["'][^>]*>[\s\S]*chatgpt|chatgpt\.com\/|chatgpt-app/i,
      claude: /<title[^>]*>[^<]*Claude|claude\.ai\/|id=["']__next["'][\s\S]*Claude/i,
      gemini: /<title[^>]*>[^<]*Gemini|gemini\.google\.com|bard-app/i,
      youtube: /ytInitial(?:Data|PlayerResponse)|<title[^>]*>[^<]*YouTube/i,
      tiktok: /<title[^>]*>[^<]*TikTok|__UNIVERSAL_DATA_FOR_REHYDRATION__|id=["']SIGI_STATE["']/i
    };
    if (/^https:\/\/(?:(?:accounts|consent)\.google\.com|consent\.youtube\.com)\//i.test(response.url)) return outcome("unknown", "到达 Google 登录或同意页面；目标服务未确认");
    if (service.id === "tiktok" && /\/about(?:[/?#]|$)|\/status(?:[/?#]|$)/i.test(response.url)) return outcome("unknown", "跳转到介绍或状态页面，未确认 TikTok 视频服务");
    if (!fingerprint[service.id].test(body)) return outcome("unknown", "收到页面，但未识别到目标站点特征；可能是接口变更或拦截页");
    return outcome("reachable", service.id === "tiktok" ? "TikTok 网页可达；不能据此证明 App 刷视频可用" : "正常网页可达；登录、账号资格和实际使用仍需复核");
  }
  function extractObject(body, marker) {
    // 从赋值表达式提取 JSON；不执行页面中的 JavaScript。
    var pattern = new RegExp("(?:var\\s+)?" + marker + "\\s*=\\s*");
    var match = pattern.exec(body);
    if (!match) return null;
    var start = match.index + match[0].length;
    if (body[start] !== "{") return null;
    var depth = 0, string = false, escaped = false;
    for (var i = start; i < body.length; i++) {
      var c = body[i];
      if (string) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') string = false;
      } else if (c === '"') string = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) return json(body.slice(start, i + 1));
    }
    return null;
  }
  function scriptJSON(body, id) {
    var scripts = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi, match;
    var idPattern = new RegExp("\\bid\\s*=\\s*[\"']" + id + "[\"']", "i");
    while ((match = scripts.exec(body))) if (idPattern.test(match[1])) return json(match[2]);
    return null;
  }
  function youtubeInfo(body) {
    var player = extractObject(body, "ytInitialPlayerResponse");
    if (!player || !player.playabilityStatus) return null;
    var status = player.playabilityStatus;
    var formats = (player.streamingData && (player.streamingData.formats || []).concat(player.streamingData.adaptiveFormats || [])) || [];
    var media = formats.filter(function (f) { return f.url && allowed(f.url, ["googlevideo.com"]); });
    media.sort(function (a, b) { return (a.bitrate || Infinity) - (b.bitrate || Infinity); });
    return { status: status.status, reason: status.reason || "", media: media.length ? media[0].url : "" };
  }
  function tiktokInfo(body) {
    var universal = scriptJSON(body, "__UNIVERSAL_DATA_FOR_REHYDRATION__");
    var scope = universal && universal.__DEFAULT_SCOPE__;
    var context = scope && scope["webapp.app-context"];
    var sigi = scriptJSON(body, "SIGI_STATE");
    var region = context && (context.region || context.countryCode);
    if (!region && sigi && sigi.AppContext) region = sigi.AppContext.region || sigi.AppContext.appContext && sigi.AppContext.appContext.region;
    var items = sigi && sigi.ItemModule;
    var media = "";
    if (items) Object.keys(items).some(function (key) {
      var video = items[key] && items[key].video;
      var candidate = video && video.playAddr;
      if (typeof candidate === "string" && allowed(candidate, ["tiktokcdn.com", "tiktokcdn-us.com", "tiktokv.com", "byteoversea.com", "ibytedtos.com"])) { media = candidate; return true; }
      return false;
    });
    return { region: typeof region === "string" && /^[A-Z]{2}$/i.test(region) ? region.toUpperCase() : "", media: media };
  }

  function semaphore(limit) {
    var active = 0, waiting = [];
    function drain() {
      while (active < limit && waiting.length) {
        active++;
        waiting.shift()(function () { active--; drain(); });
      }
    }
    return function () { return new Promise(function (resolve) { waiting.push(resolve); drain(); }); };
  }
  function makeHTTP(runtime, settings, control) {
    var acquire = semaphore(4);
    return async function request(node, url, hosts, deadline, method) {
      var hops = 0;
      while (true) {
        if (!allowed(url, hosts)) return { error: "不支持的目标地址", url: url, status: 0, headers: {}, body: "" };
        var release = await acquire();
        var remaining = Math.min(deadline, control.deadline) - runtime.now();
        if (control.stopped || remaining <= 50) { release(); return { error: "检测预算已耗尽", timeout: true, url: url, status: 0, headers: {}, body: "" }; }
        var wait = Math.max(1, Math.min(settings.requestTimeout, remaining));
        var response = await new Promise(function (resolve) {
          var settled = false;
          function finish(value) { if (!settled) { settled = true; release(); resolve(value); } }
          runtime.later(function () { finish({ error: "请求超时", timeout: true, url: url, status: 0, headers: {}, body: "" }); }, wait + 100);
          try {
            runtime.http[method || "get"]({
              url: url, node: node, timeout: wait,
              headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", "Cache-Control": "no-cache" },
              "auto-redirect": false, "auto-cookie": false, insecure: false
            }, function (error, result, data) {
              finish({ error: error || "", timeout: /timeout|timed out|超时/i.test(String(error || "")), url: url,
                status: Number(result && result.status) || 0, headers: result && result.headers || {}, body: typeof data === "string" ? data : "" });
            });
          } catch (error) { finish({ error: String(error), url: url, status: 0, headers: {}, body: "" }); }
        });
        if (response.error || [301, 302, 303, 307, 308].indexOf(response.status) < 0) return response;
        var next = redirectURL(url, header(response.headers, "location"));
        // 保留受限跳转地址用于分类，不必继续请求地区不可用页面。
        if (/app-unavailable-in-region|\/unsupported-country|\/country-not-supported/i.test(next) || /^https:\/\/(?:www\.)?tiktok\.com\/hk\/notfound(?:[/?#]|$)/i.test(next)) { response.url = next; return response; }
        if (!allowed(next, hosts)) { response.redirectIssue = "跳转到未识别的域名；未继续跟随"; return response; }
        if (++hops > 3) { response.redirectIssue = "重定向次数过多；需要浏览器或登录确认"; return response; }
        url = next;
      }
    };
  }
  async function probe(service, node, request, deadline, runtime) {
    var started = runtime.now();
    var response = await request(node, service.url, service.hosts, deadline, "get");
    if (!response.error && response.status === 404 && (service.id === "tiktok" || service.id === "youtube")) {
      response = await request(node, service.id === "tiktok" ? "https://www.tiktok.com/" : "https://www.youtube.com/", service.hosts, deadline, "get");
    }
    var result = classifyPage(service, response);
    if (result.state === "reachable" && service.id === "youtube") {
      var player = youtubeInfo(response.body);
      if (!player) result = outcome("reachable", "YouTube 页面可达；未取得播放器数据，视频播放未确认");
      else if (player.status !== "OK") {
        var geo = /country|region|地[区域]|国家/i.test(player.reason);
        result = outcome(geo ? "restricted" : "unknown", "测试视频播放器：" + String(player.status || "未知") + (player.reason ? "（" + player.reason.slice(0, 140) + "）" : "") + "；只代表这个测试视频");
      } else if (!player.media) result = outcome("limited", "测试视频播放器返回 OK；未得到可直接检查的媒体地址，视频链路未确认");
      else {
        var cdn = await request(node, player.media, ["googlevideo.com"], deadline, "head");
        var type = header(cdn.headers, "content-type");
        result = !cdn.error && [200, 206].indexOf(cdn.status) >= 0 && /^(?:video|audio)\//i.test(type)
          ? outcome("pass", "测试视频播放器 OK，媒体 CDN HEAD 返回 " + cdn.status + "；不代表持续播放、速度或 Premium 解锁")
          : outcome("limited", "播放器 OK；媒体 CDN HEAD " + (cdn.error ? "超时或失败" : "返回 HTTP " + cdn.status) + "，实际播放未确认（HEAD 可能被拒绝）");
      }
    }
    if (result.state === "reachable" && service.id === "tiktok") {
      var info = tiktokInfo(response.body);
      if (info.region) result.detail += "；站点报告地区 " + info.region + "（不是可用性结论）";
      if (info.media) {
        var video = await request(node, info.media, ["tiktokcdn.com", "tiktokcdn-us.com", "tiktokv.com", "byteoversea.com", "ibytedtos.com"], deadline, "head");
        if (!video.error && [200, 206].indexOf(video.status) >= 0 && /^video\//i.test(header(video.headers, "content-type"))) result = outcome("pass", "网页及一个公开视频 CDN HEAD 通过；TikTok App 还受 SIM、设备地区和账号影响" + (info.region ? "；站点地区 " + info.region : ""));
        else result = outcome("limited", "网页可达；公开视频 CDN HEAD 未确认，不能证明 App 可用");
      }
    }
    result.ms = runtime.now() - started;
    return result;
  }

  function configSummary(runtime) {
    try {
      var value = runtime.config && runtime.config.getConfig && runtime.config.getConfig();
      return typeof value === "string" ? JSON.parse(value || "{}") : value || {};
    } catch (_) { return {}; }
  }
  function readMembers(runtime, name, deadline) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      function finish(error, values) {
        if (settled) return;
        settled = true;
        if (error) reject(error); else resolve(values);
      }
      if (!runtime.config || typeof runtime.config.getSubPolicies !== "function") { finish(new Error("当前 Loon 未提供策略组成员接口")); return; }
      var remaining = deadline - runtime.now();
      if (remaining <= 0) { finish(new Error("策略组枚举总时限已到")); return; }
      runtime.later(function () { finish(new Error("读取策略组成员超时")); }, Math.min(2000, remaining));
      try {
        runtime.config.getSubPolicies(name, function (value) {
          try {
            var members = typeof value === "string" ? JSON.parse(value || "null") : value;
            if (!Array.isArray(members) || members.some(function (v) { return typeof v !== "string" || !v; })) throw new Error("策略组接口未返回有效节点列表");
            finish(null, members);
          } catch (error) { finish(error); }
        });
      } catch (error) { finish(error); }
    });
  }
  async function enumerate(runtime, root, summary, settings, warnings) {
    var groups = Array.isArray(summary.all_policy_groups) ? summary.all_policy_groups : null;
    if (!groups) throw new Error("无法取得策略组清单，不能安全区分节点和嵌套策略组");
    var known = Object.create(null), visited = Object.create(null), seen = Object.create(null), nodes = [];
    groups.concat([root]).forEach(function (g) { known[g] = true; });
    var deadline = runtime.now() + 12000;
    var count = 0;
    async function walk(group, depth, isRoot) {
      if (visited[group]) return;
      visited[group] = true;
      if (depth > 16 || ++count > 500) { warnings.push("嵌套策略组过深或过多，跳过：" + group); return; }
      var members;
      try { members = await readMembers(runtime, group, deadline); }
      catch (error) { if (isRoot) throw error; warnings.push("未展开策略组 " + group + "：" + error.message); return; }
      for (var i = 0; i < members.length; i++) {
        var member = members[i];
        if (known[member]) await walk(member, depth + 1, false);
        else if (!/^REJECT(?:[-_].*)?$/i.test(member) && member !== "PROXY" && (member !== "DIRECT" || settings.includeDirect) && !seen[member]) {
          if (nodes.length >= 5000) { warnings.push("节点清单超过 5000 项，停止继续展开"); return; }
          seen[member] = true; nodes.push(member);
        }
      }
    }
    await walk(root, 0, true);
    if (!nodes.length) throw new Error("策略组未返回可检测节点（DIRECT 默认跳过）");
    return nodes;
  }
  function selectedLeaf(runtime, target, groups) {
    var visited = Object.create(null), name = target;
    for (var i = 0; name && i < 20; i++) {
      if (visited[name]) return "";
      visited[name] = true;
      var selected = "";
      try { if (runtime.config && runtime.config.getSelectedPolicy) selected = runtime.config.getSelectedPolicy(name); } catch (_) {}
      if (!selected || typeof selected !== "string") return groups.indexOf(name) >= 0 ? "" : name;
      name = selected;
    }
    return "";
  }
  async function targets(runtime, settings, warnings) {
    var params = runtime.params || {}, info = params.nodeInfo;
    if (typeof info === "string") info = json(info);
    var contextNode = info && typeof info.name === "string" ? info.name : "";
    var explicitNode = settings.node || contextNode;
    var legacyNode = typeof params.node === "string" ? params.node : "";
    var summary = configSummary(runtime);
    var hasGroupList = Array.isArray(summary.all_policy_groups);
    var groups = hasGroupList ? summary.all_policy_groups : [];
    // Generic context can contain both policyGroup and nodeInfo. In auto/batch
    // mode the policy group is authoritative; nodeInfo is only a fallback.
    var contextGroup = typeof params.policyGroup === "string" ? params.policyGroup.trim() : "";
    var group = settings.group || (settings.mode !== "single" && contextGroup) || (groups.indexOf(legacyNode) >= 0 ? legacyNode : "");
    if (settings.mode === "batch" && !group && typeof params.policyGroup === "string") group = params.policyGroup;
    if (settings.mode !== "single" && group) {
      try { return { mode: "batch", source: group, nodes: await enumerate(runtime, group, summary, settings, warnings) }; }
      catch (error) { warnings.push("批量读取失败，尝试单节点回退：" + error.message); }
    }
    // 枚举失败也不能把整个动态策略组伪装成“单个节点”。
    if (group && groups.indexOf(group) < 0) groups = groups.concat([group]);
    var node = explicitNode || (legacyNode && groups.indexOf(legacyNode) < 0 && (hasGroupList || !group) ? legacyNode : "") || (hasGroupList ? selectedLeaf(runtime, group || legacyNode, groups) : "");
    if (!node && settings.mode === "single" && settings.group && hasGroupList) node = selectedLeaf(runtime, settings.group, groups);
    if (!node || groups.indexOf(node) >= 0 || node === "PROXY") throw new Error("未取得明确目标。请从目标策略组入口运行以自动读取策略组，或填写备用单节点名称。");
    if (/^REJECT(?:[-_].*)?$/i.test(node)) throw new Error("拒绝策略不能作为检测节点。");
    if (node === "DIRECT" && !settings.includeDirect) throw new Error("默认跳过 DIRECT 直连；如需检测，请在插件中开启“包含 DIRECT”。");
    if (settings.mode === "batch" && !group) warnings.push("入口没有策略组名称，改为检测单个节点。");
    return { mode: "single", source: node, nodes: [node] };
  }

  function render(report) {
    var esc = escapeHTML;
    var warnings = report.warnings.map(function (w) { return "<p class='warning'>" + esc(w) + "</p>"; }).join("");
    var title = report.mode === "batch" ? "策略组批量检测" : "单节点检测";
    var cells = report.rows.map(function (row) {
      return "<tr><th>" + esc(row.name) + "</th>" + report.services.map(function (s) { var r = row.results[s.id]; return "<td class='" + r.state + "'>" + esc(r.label) + "</td>"; }).join("") + "</tr>";
    }).join("");
    var details = report.rows.map(function (row) {
      return "<details><summary>" + esc(row.name) + " · " + (row.complete ? "检测结束" : "未全部完成") + "</summary>" + report.services.map(function (s) {
        var r = row.results[s.id];
        return "<p><b>" + esc(s.name) + "</b> <span class='" + r.state + "'>" + esc(r.label) + "</span><br><small>" + esc(r.detail) + (r.ms ? " · 本项耗时 " + (r.ms / 1000).toFixed(1) + "s（含排队/重定向）" : "") + "</small></p>";
      }).join("") + "</details>";
    }).join("");
    var finished = report.rows.filter(function (r) { return r.complete; }).length;
    var next = report.nextIndex ? "<p class='warning'>下一批：将“起始序号”设为 <b>" + report.nextIndex + "</b>。节点顺序按本次策略组展开结果；订阅更新后可能变化。</p>" : "";
    return "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'><meta name='color-scheme' content='light dark'><style>" +
      "body{font:14px -apple-system,BlinkMacSystemFont,sans-serif;margin:18px;line-height:1.6;color:#172033;background:#f5f7fb}h2{margin:0 0 8px}p{margin:8px 0}.muted,small{color:#687588}.scroll{overflow-x:auto;background:#fff;border-radius:12px}table{border-collapse:collapse;white-space:nowrap;width:100%}th,td{padding:10px 12px;border-bottom:1px solid #e7ecf3;text-align:left}th:first-child{max-width:200px;white-space:normal;overflow-wrap:anywhere}.pass{color:#07804e}.reachable{color:#186bbc}.restricted,.unreachable{color:#d13d45}.limited,.unknown,.pending,.warning{color:#a26208}details{background:#fff;padding:12px;border-radius:12px;margin-top:12px;overflow-wrap:anywhere}summary{font-weight:600;cursor:pointer}.note{padding:12px;border-radius:12px;background:#eaf0f8}@media(prefers-color-scheme:dark){body{background:#141921;color:#e7edf8}.scroll,details{background:#202735}th,td{border-color:#343e4e}.muted,small{color:#a6b3c6}.note{background:#263449}.pass{color:#68dba7}.reachable{color:#81b6ff}.restricted,.unreachable{color:#ff9096}.limited,.unknown,.pending,.warning{color:#efbe72}}" +
      "</style></head><body><h2>" + title + "</h2><p>" + esc(report.source || "未选择目标") + "</p><p class='muted'>" + esc(report.time) + " · 共 " + report.total + " 个节点，本批 " + report.rows.length + " 个，完成 " + finished + " 个 · 耗时 " + (report.elapsedMs / 1000).toFixed(1) + "s</p>" + warnings +
      "<div class='scroll'><table><thead><tr><th>节点</th>" + report.services.map(function (s) { return "<th>" + esc(s.name) + "</th>"; }).join("") + "</tr></thead><tbody>" + cells + "</tbody></table></div>" + next + details +
      "<p class='note'>🌐 网页可达只验证站点页面；✅ 链路通过表示播放器/公开媒体 HEAD 检查通过，未下载视频。AI 对话、账号权限、YouTube Premium、持续播放和 TikTok App 需要实际使用验证。超时、403、429、验证码或页面结构变化不会被直接当作地区封锁。本脚本不修改策略组选择，不使用解密证书。</p></body></html>";
  }
  async function run(runtime) {
    var settings = options(runtime.argument);
    var start = runtime.now(), control = { stopped: false, deadline: start + settings.totalMs };
    var report = { mode: "single", source: "", total: 0, rows: [], warnings: [], services: settings.services, time: new Date(start + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ") + " UTC+08:00", elapsedMs: 0, nextIndex: 0 };
    var finished = false;
    function finish() {
      if (finished) return;
      finished = true; control.stopped = true;
      report.elapsedMs = runtime.now() - start;
      var incomplete = report.rows.findIndex(function (r) { return !r.complete; });
      if (report.mode === "batch") report.nextIndex = incomplete >= 0 ? settings.startIndex + incomplete : settings.startIndex + report.rows.length <= report.total ? settings.startIndex + report.rows.length : 0;
      var content = report.rows.map(function (row) { return row.name + "\n" + report.services.map(function (s) { return s.name + "：" + row.results[s.id].label + " · " + row.results[s.id].detail; }).join("\n"); }).join("\n\n");
      try { if (runtime.store && runtime.store.write) runtime.store.write(JSON.stringify(report), "loon.node-service-check.last"); } catch (_) {}
      runtime.done({ title: "AI / 视频节点检测", content: content || report.warnings.join("\n"), htmlMessage: render(report) });
    }
    runtime.later(function () { if (!finished) { report.warnings.push("本次总时限已到；未完成项保留为未完成，可从下一批起点重测。"); finish(); } }, settings.totalMs);
    try {
      var target = await targets(runtime, settings, report.warnings);
      if (finished) return;
      report.mode = target.mode; report.source = target.source; report.total = target.nodes.length;
      var offset = target.mode === "batch" ? settings.startIndex - 1 : 0;
      var selected = target.nodes.slice(offset, target.mode === "batch" ? offset + settings.maxNodes : 1);
      if (!selected.length) report.warnings.push("起始序号超过节点总数；请将起始序号设为 1。");
      if (target.mode === "batch" && offset + selected.length < target.nodes.length) report.warnings.push("大策略组按批次检测，当前序号 " + (offset + 1) + "–" + (offset + selected.length) + "；其余节点本次未发起请求。");
      report.rows = selected.map(function (name) {
        var results = {};
        settings.services.forEach(function (s) { results[s.id] = outcome("pending", "未开始或尚未完成检测"); });
        return { name: name, complete: false, results: results };
      });
      var request = makeHTTP(runtime, settings, control), cursor = 0;
      async function worker() {
        while (!control.stopped && cursor < report.rows.length && runtime.now() < control.deadline) {
          var row = report.rows[cursor++];
          var deadline = Math.min(runtime.now() + 35000, control.deadline);
          await Promise.all(settings.services.map(async function (service) {
            var result;
            try { result = await probe(service, row.name, request, deadline, runtime); }
            catch (_) { result = outcome("unknown", "检测解析异常，不能确认服务可用性"); }
            if (!finished) row.results[service.id] = result;
          }));
          if (!finished) row.complete = true;
        }
      }
      var workers = [];
      for (var i = 0; i < Math.min(settings.parallel, report.rows.length); i++) workers.push(worker());
      await Promise.all(workers);
      finish();
    } catch (error) { if (!finished) { report.warnings.push(error.message || String(error)); finish(); } }
    return report;
  }
  return { run: run, options: options, targets: targets, enumerate: enumerate, readMembers: readMembers, classifyPage: classifyPage,
    youtubeInfo: youtubeInfo, tiktokInfo: tiktokInfo, extractObject: extractObject, render: render, services: SERVICES, allowed: allowed, redirectURL: redirectURL };
})();

if (typeof module !== "undefined" && module.exports) module.exports = NodeServiceCheck;
else NodeServiceCheck.run({
  argument: typeof $argument === "undefined" ? {} : $argument,
  params: typeof $environment === "undefined" ? {} : $environment.params || {},
  config: typeof $config === "undefined" ? null : $config,
  store: typeof $persistentStore === "undefined" ? null : $persistentStore,
  http: $httpClient, done: $done,
  later: function (callback, milliseconds) { setTimeout(callback, milliseconds); },
  now: function () { return Date.now(); }
});
