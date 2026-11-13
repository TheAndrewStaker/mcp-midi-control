# MCP host compatibility

The server implements the open [Model Context Protocol](https://modelcontextprotocol.io)
spec, so it works with any spec-compliant MCP host; the protocol layer is
host-agnostic and only the config file location differs.

| Host | Status | Config location |
|---|---|---|
| **Claude Desktop** (Anthropic) | ✅ Primary target | `claude_desktop_config.json` (per-platform path; `npm run setup-claude-desktop` finds it for you) |
| **Claude Code** (CLI) | ✅ Tested | `claude mcp add` registers it; or `~/.claude.json` |
| **Cursor** | ✅ Spec-compliant, works | `.cursor/mcp.json` (project) or global settings |
| **Windsurf** (Codeium) | ✅ Spec-compliant | `~/.codeium/windsurf/mcp_config.json` |
| **Continue.dev** (VS Code) | ✅ Spec-compliant | `~/.continue/config.json` |
| **VS Code GitHub Copilot Chat** | ✅ Spec-compliant | VS Code settings → `chat.mcp.servers` |
| **Cline / Roo Code** (VS Code) | ✅ Spec-compliant | Extension-specific JSON |
| **LM Studio, Goose, Ollama-based hosts** | ✅ Most support MCP | Per-host config |
| **ChatGPT Desktop** (OpenAI) | 🟡 Partial: this project's tool descriptions are large (~10 KB) and may hit description-length limits in some surfaces | OS-specific |
| **Microsoft Copilot Studio** | 🟡 Better for cloud-hosted MCP servers than local-stdio | Azure-side |
| **Google Gemini first-party** | ⚠️ No native MCP; Gemini Extensions / function-calling is similar-but-distinct, and adapter layers exist | Adapter-specific |

The JSON shape is near-universal across hosts:

```json
{
  "mcpServers": {
    "mcp-midi-control": {
      "command": "node",
      "args": ["/path/to/packages/server-all/dist/server/index.js"]
    }
  }
}
```

What differs per host: the file location, the top-level key name (some use
`mcpServers`, some `mcp.servers`), and whether they honor `cwd` / `env`
fields. Claude Desktop does not honor `cwd`, which is why the recommended
setup points at the absolute path to the built
`packages/server-all/dist/server/index.js` rather than running `tsx`
against source. After editing whichever config your host uses, restart it.

Claude Desktop is the primary target because of how cleanly its Connectors
panel surfaces tool calls, but any spec-compliant host should work.
Hardware features (USB MIDI, device drivers) are the same regardless of
host.
