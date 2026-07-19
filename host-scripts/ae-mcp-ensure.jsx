/**
 * Manual ensure only. Safe if modal open: fails quietly.
 */
(function () {
  try {
    if ($.global && $.global.__AE_MCP_RESTART_POLLER__) {
      $.global.__AE_MCP_RESTART_POLLER__();
      return;
    }
    if ($.global && $.global.__AE_MCP_ENSURE_POLLER__) {
      $.global.__AE_MCP_ENSURE_POLLER__();
      if ($.global.__AE_MCP_TICK__) $.global.__AE_MCP_TICK__();
      return;
    }
  } catch (e) {
    // Modal dialog open — do nothing (avoids cascading errors)
  }
})();
