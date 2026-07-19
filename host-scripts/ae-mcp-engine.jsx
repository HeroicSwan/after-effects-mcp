/**
 * ae-mcp engine — poller + command processing
 * Loaded ONLY on CONNECT (not from Startup auto-run).
 * ES3 / ExtendScript safe. ASCII only.
 */
(function () {
  if ($.global.__AE_MCP_ENGINE_READY__) {
    return;
  }
  $.global.__AE_MCP_ENGINE_READY__ = true;

  var POLL_MS = 1500;

  function log(msg) {
    try {
      var home = Folder("~").fsName;
      var dir = new Folder(home + "/.ae-mcp");
      if (!dir.exists) dir.create();
      var f = new File(home + "/.ae-mcp/bridge.log");
      f.encoding = "UTF-8";
      f.open("a");
      f.writeln(new Date().toString() + " " + msg);
      f.close();
    } catch (e) {}
  }

  function homeDir() {
    try {
      var u = $.getenv("USERPROFILE");
      if (u) return u;
    } catch (e) {}
    return Folder("~").fsName;
  }

  function ensureDirs() {
    var root = new Folder(homeDir() + "/.ae-mcp");
    if (!root.exists) root.create();
    var inst = new Folder(homeDir() + "/.ae-mcp/instances");
    if (!inst.exists) inst.create();
    var def = new Folder(homeDir() + "/.ae-mcp/instances/default");
    if (!def.exists) def.create();
    var prev = new Folder(homeDir() + "/.ae-mcp/previews");
    if (!prev.exists) prev.create();
    return def;
  }

  function esc(s) {
    s = String(s);
    var out = "";
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (c === "\\") out += "\\\\";
      else if (c === '"') out += '\\"';
      else if (c === "\n") out += "\\n";
      else if (c === "\r") out += "\\r";
      else if (c === "\t") out += "\\t";
      else out += c;
    }
    return out;
  }

  function pad2(n) {
    return n < 10 ? "0" + n : String(n);
  }

  function nowIso() {
    var d = new Date();
    return (
      d.getUTCFullYear() +
      "-" +
      pad2(d.getUTCMonth() + 1) +
      "-" +
      pad2(d.getUTCDate()) +
      "T" +
      pad2(d.getUTCHours()) +
      ":" +
      pad2(d.getUTCMinutes()) +
      ":" +
      pad2(d.getUTCSeconds()) +
      "Z"
    );
  }

  function writeHeartbeat() {
    var dir = ensureDirs();
    var projectName = "null";
    var projectPath = "null";
    try {
      if (app.project && app.project.file) {
        projectName = '"' + esc(app.project.file.name) + '"';
        projectPath = '"' + esc(app.project.file.fsName) + '"';
      } else if (app.project) {
        projectName = '"Untitled"';
      }
    } catch (e) {
      return false;
    }
    var json =
      "{" +
      '"instanceId":"default",' +
      '"aeVersion":"' +
      esc(String(app.version)) +
      '",' +
      '"projectName":' +
      projectName +
      "," +
      '"projectPath":' +
      projectPath +
      "," +
      '"lastSeen":"' +
      nowIso() +
      '",' +
      '"pollMs":' +
      POLL_MS +
      "," +
      '"protocolVersion":1,' +
      '"listening":true' +
      "}";
    try {
      var f = new File(dir.fsName + "/instance.json");
      f.encoding = "UTF-8";
      if (!f.open("w")) return false;
      f.write(json);
      f.close();
      return true;
    } catch (e2) {
      return false;
    }
  }

  function readTextFile(file) {
    if (!file.exists) return null;
    file.encoding = "UTF-8";
    file.open("r");
    var t = file.read();
    file.close();
    return t;
  }

  function writeResult(dir, objStr) {
    var f = new File(dir.fsName + "/result.json");
    f.encoding = "UTF-8";
    f.open("w");
    f.write(objStr);
    f.close();
  }

  function safeParse(text) {
    try {
      return eval("(" + text + ")");
    } catch (e) {
      return null;
    }
  }

  function jstr(v) {
    if (v === null || typeof v === "undefined") return "null";
    if (typeof v === "number") return isNaN(v) ? "null" : String(v);
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "string") return '"' + esc(v) + '"';
    if (v instanceof Array) {
      var a = [];
      for (var i = 0; i < v.length; i++) a.push(jstr(v[i]));
      return "[" + a.join(",") + "]";
    }
    if (typeof v === "object") {
      var p = [];
      for (var k in v) {
        if (v.hasOwnProperty(k) && typeof v[k] !== "undefined") {
          p.push('"' + esc(k) + '":' + jstr(v[k]));
        }
      }
      return "{" + p.join(",") + "}";
    }
    return "null";
  }

  // Bump when methods API changes so AE always reloads new tools
  var METHODS_VERSION = 3;

  function loadMethods(force) {
    try {
      if (
        !force &&
        $.global.__AE_MCP_DISPATCH__ &&
        $.global.__AE_MCP_METHODS_VERSION__ === METHODS_VERSION
      ) {
        return true;
      }
      var appData = $.getenv("APPDATA");
      if (!appData) return false;
      var versions = ["25.5", "25.0", "24.6", "24.0", "23.0"];
      for (var i = 0; i < versions.length; i++) {
        var pack = new File(
          appData +
            "\\Adobe\\After Effects\\" +
            versions[i] +
            "\\Scripts\\ae-mcp\\ae-mcp-methods.jsx",
        );
        // Skip empty/corrupt installs (we've hit 0-byte methods before)
        if (pack.exists && pack.length > 1000) {
          $.evalFile(pack);
          if ($.global.__AE_MCP_DISPATCH__) {
            $.global.__AE_MCP_METHODS_VERSION__ = METHODS_VERSION;
            log("methods loaded v" + METHODS_VERSION + " " + pack.fsName);
            return true;
          }
        }
      }
    } catch (e) {
      log("methods fail: " + String(e));
    }
    return false;
  }

  function handleHealth() {
    var active = null;
    try {
      if (app.project.activeItem && app.project.activeItem instanceof CompItem) {
        active = app.project.activeItem.name;
      }
    } catch (e) {}
    return {
      connected: true,
      listening: true,
      aeVersion: String(app.version),
      projectOpen: !!app.project,
      projectName: app.project && app.project.file ? app.project.file.name : app.project ? "Untitled" : null,
      projectPath: app.project && app.project.file ? app.project.file.fsName : null,
      activeComp: active,
      numItems: app.project ? app.project.numItems : 0,
      bridge: "ae-mcp-engine",
      protocolVersion: 1,
      home: homeDir(),
    };
  }

  function processCommand() {
    // Always try to refresh methods so new tools work without reconnect
    try {
      loadMethods(false);
    } catch (eLM) {}
    var dir = ensureDirs();
    var cmdFile = new File(dir.fsName + "/command.json");
    if (!cmdFile.exists) return;
    var text = readTextFile(cmdFile);
    try {
      cmdFile.remove();
    } catch (e) {}
    if (!text) return;
    var cmd = safeParse(text);
    if (!cmd || !cmd.requestId) return;

    var start = new Date().getTime();
    var undoName = (cmd.meta && cmd.meta.undoName) || "MCP";
    try {
      var data = null;
      if (cmd.op === "ping" || cmd.method === "system.ping") {
        data = { pong: true };
      } else if (cmd.method === "system.health") {
        data = handleHealth();
      } else if ($.global.__AE_MCP_DISPATCH__) {
        app.beginUndoGroup(undoName);
        data = $.global.__AE_MCP_DISPATCH__(cmd.method, cmd.args || {}, cmd.code);
        app.endUndoGroup();
      } else if (cmd.method === "system.runJsx" && cmd.code) {
        app.beginUndoGroup(undoName);
        var fn = new Function("args", cmd.code);
        data = { result: fn((cmd.args && cmd.args.args) || cmd.args || {}) };
        app.endUndoGroup();
      } else {
        throw {
          code: "LIMITED_BRIDGE",
          message: "Methods not loaded. Re-run install-bridge.",
        };
      }
      writeResult(
        dir,
        jstr({
          protocolVersion: 1,
          requestId: cmd.requestId,
          ok: true,
          data: data,
          error: null,
          timingMs: new Date().getTime() - start,
          instanceId: "default",
          aeVersion: String(app.version),
        }),
      );
    } catch (err) {
      try {
        app.endUndoGroup();
      } catch (e2) {}
      var code = "AE_ERROR";
      var message = String(err);
      var hint = "";
      if (err && typeof err === "object") {
        if (err.code) code = String(err.code);
        if (err.message) message = String(err.message);
        if (err.hint) hint = String(err.hint);
      }
      if (message.toLowerCase().indexOf("modal") !== -1) {
        code = "AE_MODAL";
        hint = "Close AE dialogs then retry.";
      }
      try {
        writeResult(
          dir,
          jstr({
            protocolVersion: 1,
            requestId: cmd.requestId,
            ok: false,
            error: { code: code, message: message, hint: hint },
            instanceId: "default",
            aeVersion: String(app.version),
          }),
        );
      } catch (e3) {}
    }
  }

  function scheduleNext() {
    try {
      if ($.global.__AE_MCP_TASK_ID__) {
        try {
          app.cancelTask($.global.__AE_MCP_TASK_ID__);
        } catch (e0) {}
      }
      $.global.__AE_MCP_TASK_ID__ = app.scheduleTask(
        "try{if($.global.__AE_MCP_TICK__){$.global.__AE_MCP_TICK__();}}catch(e){}",
        POLL_MS,
        false,
      );
    } catch (e1) {
      // Modal open — try again later with longer delay
      try {
        $.global.__AE_MCP_TASK_ID__ = app.scheduleTask(
          "try{if($.global.__AE_MCP_TICK__){$.global.__AE_MCP_TICK__();}}catch(e){}",
          5000,
          false,
        );
      } catch (e2) {
        log("schedule blocked: " + String(e2));
        $.global.__AE_MCP_CHAIN_STARTED__ = false;
      }
    }
  }

  function tick() {
    try {
      $.global.__AE_MCP_POLLER_ON__ = true;
      writeHeartbeat();
      processCommand();
    } catch (e) {
      try {
        log("tick: " + String(e));
      } catch (e2) {}
    }
    try {
      scheduleNext();
    } catch (e3) {}
  }

  function ensurePoller() {
    loadMethods();
    $.global.__AE_MCP_TICK__ = tick;
    $.global.__AE_MCP_POLLER_ON__ = true;
    try {
      writeHeartbeat();
    } catch (e) {}
    if (!$.global.__AE_MCP_CHAIN_STARTED__) {
      $.global.__AE_MCP_CHAIN_STARTED__ = true;
      scheduleNext();
      log("poller started");
    }
  }

  function restartPoller() {
    $.global.__AE_MCP_CHAIN_STARTED__ = false;
    try {
      if ($.global.__AE_MCP_TASK_ID__) app.cancelTask($.global.__AE_MCP_TASK_ID__);
    } catch (e) {}
    $.global.__AE_MCP_TASK_ID__ = null;
    ensurePoller();
    try {
      tick();
    } catch (e2) {}
  }

  $.global.__AE_MCP_TICK__ = tick;
  $.global.__AE_MCP_ENSURE_POLLER__ = ensurePoller;
  $.global.__AE_MCP_RESTART_POLLER__ = restartPoller;
  $.global.__AE_MCP_PUMP__ = function () {
    try {
      ensurePoller();
      writeHeartbeat();
      processCommand();
    } catch (e) {}
  };

  log("engine ready");
})();
