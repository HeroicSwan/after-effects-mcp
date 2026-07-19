/**
 * Manual / diagnostic kick — same as ensure (non-blocking by default).
 * For a short sync pump pass ? not needed; MCP server auto-kicks ensure.
 *
 * File > Scripts > Run Script File… → ae-mcp-probe.jsx
 */
(function () {
  function getenv(name) {
    try {
      return $.getenv(name);
    } catch (e) {
      return null;
    }
  }

  var appData = getenv("APPDATA");
  if (appData) {
    var versions = ["25.5", "25.0", "24.6", "24.0", "23.0", "22.6"];
    for (var i = 0; i < versions.length; i++) {
      var boot = new File(
        appData +
          "\\Adobe\\After Effects\\" +
          versions[i] +
          "\\Scripts\\Startup\\ae-mcp-bootstrap.jsx",
      );
      if (boot.exists) {
        try {
          if ($.global) {
            $.global.__AE_MCP_BOOT_LOADED__ = false;
            $.global.__AE_MCP_POLLER_ON__ = false;
          }
          $.evalFile(boot);
          break;
        } catch (e) {}
      }
    }
  }

  if (typeof $.global.__AE_MCP_RESTART_POLLER__ === "function") {
    $.global.__AE_MCP_RESTART_POLLER__();
  } else if (typeof $.global.__AE_MCP_ENSURE_POLLER__ === "function") {
    $.global.__AE_MCP_ENSURE_POLLER__();
  }
  // No blocking pump — avoids long "Executing script…" dialog
})();
