const report = ["Notion", "GitHub", "Slack"].map((provider) => ({ provider, status: "UNSUPPORTED_NOT_PROVISIONED", externalMutation: false, reason: "No dedicated test credential and resource were supplied to SOR-142." }));
// Intentionally not a wrapper around SOR-130: those opt-in scripts can mutate
// dedicated sandboxes when credentials exist.
console.log(JSON.stringify({ ok: true, report }, null, 2));
