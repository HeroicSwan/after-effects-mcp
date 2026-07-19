/**
 * ae-mcp Connect panel
 * Window > ae-mcp-status.jsx
 *
 * NO code runs on AE launch from this file except building UI.
 * Poller starts only when you click CONNECT (after closing all dialogs).
 */
(function (thisObj) {
  function homeDir() {
    try {
      var u = $.getenv("USERPROFILE");
      if (u) return u;
    } catch (e) {}
    return Folder("~").fsName;
  }

  function logLine(msg) {
    try {
      var d = new Folder(homeDir() + "/.ae-mcp");
      if (!d.exists) d.create();
      var f = new File(homeDir() + "/.ae-mcp/panel.log");
      f.open("a");
      f.writeln(new Date().toString() + " " + msg);
      f.close();
    } catch (e) {}
  }

  function ageSeconds(file) {
    try {
      return (new Date().getTime() - file.modified.getTime()) / 1000;
    } catch (e) {
      return 99999;
    }
  }

  function getStatus() {
    var pollerOn = false;
    try {
      pollerOn = !!(typeof $ !== "undefined" && $.global && $.global.__AE_MCP_POLLER_ON__);
    } catch (e) {}

    var hbPath = homeDir() + "/.ae-mcp/instances/default/instance.json";
    var hbFile = new File(hbPath);
    var age = hbFile.exists ? ageSeconds(hbFile) : 99999;
    var live = pollerOn || (hbFile.exists && age < 15);
    var recent = hbFile.exists && age < 180;

    var project = "(no project)";
    try {
      if (app.project && app.project.file) project = app.project.file.name;
      else if (app.project) project = "Untitled";
    } catch (e2) {}

    return {
      live: live,
      recent: recent,
      pollerOn: pollerOn,
      age: Math.floor(age),
      hasHb: hbFile.exists,
      ae: String(app.version),
      project: project,
      hbPath: hbPath,
    };
  }

  function doConnect() {
    logLine("CONNECT");
    // 1) Load engine if needed
    try {
      if ($.global && $.global.__AE_MCP_LOAD_ENGINE__) {
        var loaded = $.global.__AE_MCP_LOAD_ENGINE__();
        logLine("load_engine=" + loaded);
      }
    } catch (e0) {
      logLine("load_engine err " + String(e0));
    }

    // 2) Start poller
    try {
      if ($.global && $.global.__AE_MCP_RESTART_POLLER__) {
        $.global.__AE_MCP_RESTART_POLLER__();
        logLine("restart ok");
        return { ok: true, msg: "Poller restarted" };
      }
      if ($.global && $.global.__AE_MCP_ENSURE_POLLER__) {
        $.global.__AE_MCP_ENSURE_POLLER__();
        if ($.global.__AE_MCP_TICK__) $.global.__AE_MCP_TICK__();
        logLine("ensure ok");
        return { ok: true, msg: "Poller started" };
      }
    } catch (e1) {
      logLine("start err " + String(e1));
      var s = String(e1).toLowerCase();
      if (s.indexOf("modal") !== -1) {
        return {
          ok: false,
          msg: "MODAL OPEN: Close every AE dialog (Save, Prefs, warnings), then CONNECT again.",
        };
      }
      return { ok: false, msg: "Error: " + String(e1) };
    }

    // 3) Direct load engine file
    try {
      var appData = $.getenv("APPDATA");
      var versions = ["25.5", "25.0", "24.6", "24.0", "23.0"];
      for (var i = 0; i < versions.length; i++) {
        var eng = new File(
          appData +
            "\\Adobe\\After Effects\\" +
            versions[i] +
            "\\Scripts\\ae-mcp\\ae-mcp-engine.jsx",
        );
        if (eng.exists) {
          $.evalFile(eng);
          if ($.global.__AE_MCP_RESTART_POLLER__) {
            $.global.__AE_MCP_RESTART_POLLER__();
            return { ok: true, msg: "Engine loaded + poller started" };
          }
        }
      }
    } catch (e2) {
      logLine("direct load err " + String(e2));
      if (String(e2).toLowerCase().indexOf("modal") !== -1) {
        return {
          ok: false,
          msg: "MODAL OPEN: Close every AE dialog, then CONNECT again.",
        };
      }
    }

    return {
      ok: false,
      msg: "Engine not found. Run: node dist/index.js install-bridge then restart AE.",
    };
  }

  function installClients(csv) {
    var nodePath = "node";
    var distIndex = homeDir() + "\\Projects\\ae-mcp\\dist\\index.js";
    try {
      var f = new File(homeDir() + "/.ae-mcp/install.json");
      if (f.exists) {
        f.open("r");
        var meta = eval("(" + f.read() + ")");
        f.close();
        if (meta.node) nodePath = meta.node;
        if (meta.distIndex) distIndex = meta.distIndex;
      }
    } catch (e) {}
    var cmd = '"' + nodePath + '" "' + distIndex + '" setup-clients --providers ' + csv;
    try {
      return String(system.callSystem(cmd));
    } catch (e2) {
      return "ERROR: " + String(e2) + "\nRun in terminal: " + cmd;
    }
  }

  // ---- UI only (safe on load) ----
  var win =
    thisObj instanceof Panel
      ? thisObj
      : new Window("palette", "ae-mcp Connect", undefined, { resizeable: true });

  win.orientation = "column";
  win.alignChildren = ["fill", "top"];
  win.margins = 12;
  win.spacing = 8;

  var row = win.add("group");
  var led = row.add("statictext", undefined, "[ ]");
  var statusTxt = row.add("statictext", undefined, "Not connected - click CONNECT");
  statusTxt.characters = 44;

  var help = win.add(
    "statictext",
    undefined,
    "1) Close ALL AE popups (Save / Prefs / warnings)\n2) Click CONNECT BRIDGE\n3) Status should show [ON] LISTENING\n(No scripts run until you click CONNECT)",
    { multiline: true },
  );
  help.preferredSize = [460, 56];

  var detail = win.add("statictext", undefined, "", { multiline: true });
  detail.preferredSize = [460, 56];

  var connectBtn = win.add("button", undefined, "CONNECT BRIDGE");
  connectBtn.preferredSize = [460, 44];

  var refreshBtn = win.add("button", undefined, "Refresh status");

  var communityBtn = win.add("button", undefined, "Join ae-mcp Discord");
  communityBtn.preferredSize = [460, 32];

  var prov = win.add("panel", undefined, "AI clients");
  prov.orientation = "column";
  prov.alignChildren = ["fill", "top"];
  prov.margins = 10;
  var clientList = prov.add("listbox", undefined, [
    "Grok",
    "Codex",
    "Claude Desktop",
    "Cursor",
    "Claude Code",
    "ChatGPT (remote MCP)"
  ], { multiselect: true });
  clientList.preferredSize = [440, 96];
  clientList.selection = [clientList.items[0]];
  var installBtn = prov.add("button", undefined, "Install selected client configs");

  var logBox = win.add("edittext", undefined, "", { multiline: true, readonly: true });
  logBox.preferredSize = [460, 100];

  function uiLog(m) {
    logBox.text = m + (logBox.text ? "\n" + logBox.text : "");
  }

  function paint(st) {
    if (st.live) {
      led.text = "[ON]";
      statusTxt.text = "LISTENING - bridge active";
      connectBtn.text = "CONNECTED";
      try {
        led.graphics.foregroundColor = led.graphics.newPen(
          led.graphics.PenType.SOLID_COLOR,
          [0.1, 0.75, 0.2],
          1,
        );
      } catch (e) {}
    } else {
      led.text = "[OFF]";
      statusTxt.text = "NOT LISTENING - click CONNECT";
      connectBtn.text = "CONNECT BRIDGE";
      try {
        led.graphics.foregroundColor = led.graphics.newPen(
          led.graphics.PenType.SOLID_COLOR,
          [0.85, 0.15, 0.1],
          1,
        );
      } catch (e2) {}
    }
    detail.text =
      "AE " +
      st.ae +
      " | " +
      st.project +
      "\nPoller: " +
      (st.pollerOn ? "ON" : "off") +
      " | Heartbeat: " +
      (st.hasHb ? st.age + "s ago" : "none") +
      "\n" +
      st.hbPath;
  }

  function refresh() {
    var st = getStatus();
    paint(st);
    return st;
  }

  connectBtn.onClick = function () {
    uiLog("--- CONNECT ---");
    uiLog("Make sure no AE dialog is open.");
    var res = doConnect();
    uiLog(res.msg);
    // Write one heartbeat now
    try {
      if ($.global && $.global.__AE_MCP_TICK__) $.global.__AE_MCP_TICK__();
    } catch (e) {
      uiLog("Tick: " + String(e));
    }
    var st = refresh();
    if (st.live) {
      uiLog("SUCCESS: [ON] LISTENING");
    } else {
      uiLog("Still OFF. Close dialogs, wait 2s, click CONNECT again.");
      uiLog("Or check ~/.ae-mcp/panel.log and bridge.log");
    }
  };

  refreshBtn.onClick = function () {
    refresh();
    uiLog("Refreshed.");
  };

  communityBtn.onClick = function () {
    var url = "https://discord.gg/KAPMFcApuG";
    try {
      if ($.os.toLowerCase().indexOf("windows") !== -1) {
        system.callSystem('cmd /c start "" "' + url + '"');
      } else {
        system.callSystem('open "' + url + '"');
      }
      uiLog("Opened ae-mcp Discord.");
    } catch (e) {
      uiLog("Could not open Discord: " + String(e));
      uiLog(url);
    }
  };

  installBtn.onClick = function () {
    var list = [];
    var selected = clientList.selection;
    if (selected && selected.length !== undefined) {
      for (var ci = 0; ci < selected.length; ci++) {
        var label = String(selected[ci].text);
        if (label === "Grok") list.push("grok");
        else if (label === "Codex") list.push("codex");
        else if (label === "Claude Desktop") list.push("claude-desktop");
        else if (label === "Cursor") list.push("cursor");
        else if (label === "Claude Code") list.push("claude-code");
        else if (label === "ChatGPT (remote MCP)") list.push("chatgpt");
      }
    } else if (selected) {
      var one = String(selected.text);
      if (one === "Grok") list.push("grok");
      else if (one === "Codex") list.push("codex");
      else if (one === "Claude Desktop") list.push("claude-desktop");
      else if (one === "Cursor") list.push("cursor");
      else if (one === "Claude Code") list.push("claude-code");
      else if (one === "ChatGPT (remote MCP)") list.push("chatgpt");
    }
    if (!list.length) {
      uiLog("Select a client.");
      return;
    }
    uiLog("Installing: " + list.join(", "));
    var out = installClients(list.join(","));
    uiLog(out.substring(0, 500));
    uiLog("Restart the AI client.");
  };

  // Safe UI paint only — no scheduleTask, no engine load
  try {
    refresh();
  } catch (e) {}
  uiLog("Panel ready. Close all AE dialogs, then CONNECT BRIDGE.");

  if (win instanceof Window) {
    win.center();
    win.show();
  } else {
    win.layout.layout(true);
  }
})(this);
