# Electivus Debug

Generated from the repository's canonical skills and config/agent-plugin.json. Do not edit this bundle by hand.

Synchronize available Salesforce logs with sf electivus, search the local corpus, then investigate selected executions. Includes three standalone skills and the optional Certinia analyzer configured for analysis only.

Requires local Node.js 22.19+ (Node 24 recommended), Salesforce CLI with @electivus/plugin-electivus for org capture, and ripgrep or the agent's equivalent local search tools. The first MCP start downloads @certinia/apex-log-mcp@2.0.1 from npm; this bundle is not an offline MCP runtime.

[Installation, updates and validation](https://github.com/Electivus/Apex-Log-Viewer/blob/main/docs/AGENT-SKILL.md)
