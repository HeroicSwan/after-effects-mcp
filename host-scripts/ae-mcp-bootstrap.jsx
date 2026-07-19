/**
 * ae-mcp Startup entry — SAFE / INERT on load
 *
 * AE runs every .jsx in Scripts/Startup at launch. We must NOT call
 * scheduleTask or do heavy work here (causes:
 * "cannot run a script while a modal dialog is waiting").
 *
 * Real poller starts only when you click CONNECT in:
 *   Window > ae-mcp-status.jsx
 */
(function () {
  // Mark installed only. No scheduleTask. No file I/O required.
  try {
    $.global.__AE_MCP_INSTALLED__ = true;
    $.global.__AE_MCP_VERSION__ = "0.2-safe";
  } catch (e) {}

  // Expose a lazy loader the panel can call on CONNECT (user gesture, no modal).
  $.global.__AE_MCP_LOAD_ENGINE__ = function () {
    if ($.global.__AE_MCP_ENGINE_LOADED__) {
      return true;
    }
    try {
      var appData = $.getenv("APPDATA");
      if (!appData) return false;
      var versions = ["25.5", "25.0", "24.6", "24.0", "23.6", "23.0", "22.6"];
      var i;
      var engine = null;
      // Prefer Scripts/ae-mcp/ (NOT Startup — not auto-run)
      for (i = 0; i < versions.length; i++) {
        var p = new File(
          appData +
            "\\Adobe\\After Effects\\" +
            versions[i] +
            "\\Scripts\\ae-mcp\\ae-mcp-engine.jsx",
        );
        if (p.exists) {
          engine = p;
          break;
        }
      }
      // Fallback: package path via install.json
      if (!engine) {
        try {
          var home = Folder("~").fsName;
          var metaF = new File(home + "/.ae-mcp/install.json");
          if (metaF.exists) {
            metaF.open("r");
            var meta = eval("(" + metaF.read() + ")");
            metaF.close();
            if (meta.packageRoot) {
              var alt = new File(meta.packageRoot + "/host-scripts/ae-mcp-engine.jsx");
              if (alt.exists) engine = alt;
            }
          }
        } catch (e2) {}
      }
      if (!engine || !engine.exists) return false;
      $.evalFile(engine);
      $.global.__AE_MCP_ENGINE_LOADED__ = true;
      return true;
    } catch (e3) {
      return false;
    }
  };
})();
