# figma-aem MCP Server

A Node.js TypeScript [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server that automates AEM component creation from Figma designs.

## Tools

| Tool | Description |
|------|-------------|
| `analyze_figma_node` | Fetches a Figma node via the REST API and returns simplified Auto Layout, typography, and color token data. |
| `generate_aem_boilerplate` | Generates AEM component boilerplate (`.content.xml`, Granite UI dialog, Sling Model, HTL) from Figma node data. |
| `push_to_aem` | Pushes content XML to a running AEM instance via the Sling POST Servlet. |

## Quick Start

```bash
npm install
npm run build
```

### Register with an MCP client

Copy the block from `mcp_config.json` into your client's configuration:

```jsonc
{
  "mcpServers": {
    "figma-aem": {
      "command": "node",
      "args": ["dist/index.js"]
    }
  }
}
```

## Development

```bash
npm test        # run tests
npm run build   # compile TypeScript
npm start       # start the MCP server (stdio transport)
```
