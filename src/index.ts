import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Helper: Figma API fetcher
// ---------------------------------------------------------------------------

interface FigmaNode {
  id: string;
  name: string;
  type: string;
  children?: FigmaNode[];
  style?: Record<string, unknown>;
  fills?: Array<{ type: string; color?: { r: number; g: number; b: number; a: number } }>;
  layoutMode?: string;
  primaryAxisAlignItems?: string;
  counterAxisAlignItems?: string;
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  itemSpacing?: number;
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number };
  characters?: string;
}

export function parseFigmaUrl(figmaUrl: string): { fileKey: string; nodeId: string } {
  const url = new URL(figmaUrl);
  const pathParts = url.pathname.split("/");
  const fileIndex = pathParts.indexOf("file") !== -1
    ? pathParts.indexOf("file")
    : pathParts.indexOf("design");
  if (fileIndex === -1 || fileIndex + 1 >= pathParts.length) {
    throw new Error("Invalid Figma URL: could not extract file key.");
  }
  const fileKey = pathParts[fileIndex + 1];
  const nodeId = url.searchParams.get("node-id") ?? "";
  return { fileKey, nodeId };
}

export function simplifyNode(node: FigmaNode): Record<string, unknown> {
  const result: Record<string, unknown> = {
    id: node.id,
    name: node.name,
    type: node.type,
  };

  // Auto-layout properties
  if (node.layoutMode) {
    result.autoLayout = {
      direction: node.layoutMode,
      primaryAxisAlign: node.primaryAxisAlignItems,
      counterAxisAlign: node.counterAxisAlignItems,
      padding: {
        top: node.paddingTop ?? 0,
        right: node.paddingRight ?? 0,
        bottom: node.paddingBottom ?? 0,
        left: node.paddingLeft ?? 0,
      },
      itemSpacing: node.itemSpacing ?? 0,
    };
  }

  // Typography
  if (node.style) {
    result.typography = node.style;
  }

  // Color tokens
  if (node.fills && node.fills.length > 0) {
    result.colorTokens = node.fills
      .filter((f) => f.type === "SOLID" && f.color)
      .map((f) => {
        const c = f.color!;
        return {
          r: Math.round(c.r * 255),
          g: Math.round(c.g * 255),
          b: Math.round(c.b * 255),
          a: c.a,
        };
      });
  }

  // Characters (text content)
  if (node.characters) {
    result.characters = node.characters;
  }

  // Bounding box
  if (node.absoluteBoundingBox) {
    result.boundingBox = node.absoluteBoundingBox;
  }

  // Recurse children
  if (node.children) {
    result.children = node.children.map(simplifyNode);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Helper: AEM boilerplate generators
// ---------------------------------------------------------------------------

interface FigmaDataNode {
  name: string;
  type: string;
  characters?: string;
  children?: FigmaDataNode[];
}

export function toCamelCase(str: string): string {
  return str
    .replace(/[^a-zA-Z0-9]+(.)/g, (_, chr: string) => chr.toUpperCase())
    .replace(/^[A-Z]/, (chr) => chr.toLowerCase());
}

export function toBemClass(componentName: string, element?: string, modifier?: string): string {
  let cls = componentName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  if (element) {
    cls += `__${element.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  }
  if (modifier) {
    cls += `--${modifier.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  }
  return cls;
}

function collectFields(
  node: FigmaDataNode,
  fields: Array<{ name: string; type: "text" | "image" }>,
): void {
  if (node.type === "TEXT" && node.characters) {
    const fieldName = toCamelCase(node.name);
    if (!fields.some((f) => f.name === fieldName)) {
      fields.push({ name: fieldName, type: "text" });
    }
  }
  if (node.type === "RECTANGLE" || node.type === "IMAGE" || node.type === "VECTOR") {
    const fieldName = toCamelCase(node.name);
    if (!fields.some((f) => f.name === fieldName)) {
      fields.push({ name: fieldName, type: "image" });
    }
  }
  if (node.children) {
    for (const child of node.children) {
      collectFields(child, fields);
    }
  }
}

export function generateContentXml(componentName: string): string {
  const jcrTitle = componentName.replace(/([A-Z])/g, " $1").trim();
  return `<?xml version="1.0" encoding="UTF-8"?>
<jcr:root
    xmlns:jcr="http://www.jcp.org/jcr/1.0"
    xmlns:cq="http://www.day.com/jcr/cq/1.0"
    xmlns:sling="http://sling.apache.org/jcr/sling/1.0"
    jcr:primaryType="cq:Component"
    jcr:title="${jcrTitle}"
    sling:resourceSuperType="core/wcm/components/commons/v1/empty"
    componentGroup="Custom Components"/>
`;
}

export function generateDialogXml(
  componentName: string,
  figmaData: FigmaDataNode,
): string {
  const fields: Array<{ name: string; type: "text" | "image" }> = [];
  collectFields(figmaData, fields);

  const fieldItems = fields
    .map((f) => {
      if (f.type === "text") {
        return `                <${f.name}
                    jcr:primaryType="nt:unstructured"
                    sling:resourceType="granite/ui/components/coral/foundation/form/textfield"
                    fieldLabel="${f.name}"
                    name="./${f.name}"/>`;
      }
      return `                <${f.name}
                    jcr:primaryType="nt:unstructured"
                    sling:resourceType="granite/ui/components/coral/foundation/form/pathfield"
                    fieldLabel="${f.name}"
                    name="./${f.name}"
                    rootPath="/content/dam"/>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<jcr:root
    xmlns:jcr="http://www.jcp.org/jcr/1.0"
    xmlns:nt="http://www.jcp.org/jcr/nt/1.0"
    xmlns:cq="http://www.day.com/jcr/cq/1.0"
    xmlns:sling="http://sling.apache.org/jcr/sling/1.0"
    jcr:primaryType="nt:unstructured"
    jcr:title="${componentName} Properties"
    sling:resourceType="cq/gui/components/authoring/dialog">
    <content
        jcr:primaryType="nt:unstructured"
        sling:resourceType="granite/ui/components/coral/foundation/container">
        <items jcr:primaryType="nt:unstructured">
            <tabs
                jcr:primaryType="nt:unstructured"
                sling:resourceType="granite/ui/components/coral/foundation/tabs"
                maximized="{Boolean}true">
                <items jcr:primaryType="nt:unstructured">
                    <properties
                        jcr:primaryType="nt:unstructured"
                        jcr:title="Properties"
                        sling:resourceType="granite/ui/components/coral/foundation/container"
                        margin="{Boolean}true">
                        <items jcr:primaryType="nt:unstructured">
${fieldItems}
                        </items>
                    </properties>
                </items>
            </tabs>
        </items>
    </content>
</jcr:root>
`;
}

export function generateSlingModel(
  componentName: string,
  figmaData: FigmaDataNode,
  targetPath: string,
): string {
  const fields: Array<{ name: string; type: "text" | "image" }> = [];
  collectFields(figmaData, fields);

  // Derive a Java package from the target path
  const packagePath = targetPath
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\//g, ".");

  const className = componentName.charAt(0).toUpperCase() + componentName.slice(1);

  const fieldDeclarations = fields
    .map((f) => {
      return `    @ValueMapValue(injectionStrategy = InjectionStrategy.OPTIONAL)
    private String ${f.name};`;
    })
    .join("\n\n");

  const getters = fields
    .map((f) => {
      const methodName = "get" + f.name.charAt(0).toUpperCase() + f.name.slice(1);
      return `    public String ${methodName}() {
        return ${f.name};
    }`;
    })
    .join("\n\n");

  return `package ${packagePath};

import org.apache.sling.api.resource.Resource;
import org.apache.sling.models.annotations.DefaultInjectionStrategy;
import org.apache.sling.models.annotations.Model;
import org.apache.sling.models.annotations.injectorspecific.ValueMapValue;
import org.apache.sling.models.annotations.InjectionStrategy;

@Model(
    adaptables = Resource.class,
    defaultInjectionStrategy = DefaultInjectionStrategy.OPTIONAL
)
public class ${className} {

${fieldDeclarations}

${getters}
}
`;
}

export function generateHtl(
  componentName: string,
  figmaData: FigmaDataNode,
): string {
  const fields: Array<{ name: string; type: "text" | "image" }> = [];
  collectFields(figmaData, fields);

  const blockName = toBemClass(componentName);
  const className = componentName.charAt(0).toUpperCase() + componentName.slice(1);

  const innerHtml = fields
    .map((f) => {
      const elementClass = toBemClass(componentName, f.name);
      if (f.type === "text") {
        return `    <div class="${elementClass}">\${model.${f.name}}</div>`;
      }
      return `    <img class="${elementClass}" src="\${model.${f.name}}" alt="${f.name}"/>`;
    })
    .join("\n");

  return `<sly data-sly-use.model="${className}">
<div class="${blockName}">
${innerHtml}
</div>
</sly>
`;
}

// ---------------------------------------------------------------------------
// Helper: push_to_aem
// ---------------------------------------------------------------------------

export interface PushToAemResult {
  status: number;
  body: string;
}

export async function pushToAem(
  host: string,
  jcrPath: string,
  contentXml: string,
  user: string,
  password: string,
): Promise<PushToAemResult> {
  const url = `${host}${jcrPath}`;
  const authHeader = "Basic " + Buffer.from(`${user}:${password}`).toString("base64");
  const body = new URLSearchParams();
  body.append("jcr:primaryType", "nt:unstructured");
  body.append(":content", contentXml);
  body.append(":contentType", "application/xml");
  body.append(":operation", "import");

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  const responseBody = await resp.text();
  return { status: resp.status, body: responseBody };
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

export function createServer(): McpServer {
  const server = new McpServer({
    name: "figma-aem-mcp-server",
    version: "1.0.0",
  });

  // ------ Tool A: analyze_figma_node ------
  server.tool(
    "analyze_figma_node",
    "Fetch a Figma node and return a simplified JSON with Auto Layout, typography, and color tokens.",
    {
      figma_url: z.string().url().describe("Full Figma URL including a node-id query parameter"),
      personal_access_token: z.string().min(1).describe("Figma Personal Access Token"),
    },
    async ({ figma_url, personal_access_token }) => {
      const { fileKey, nodeId } = parseFigmaUrl(figma_url);
      const apiUrl = nodeId
        ? `https://api.figma.com/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}`
        : `https://api.figma.com/v1/files/${fileKey}`;

      const response = await fetch(apiUrl, {
        headers: { "X-FIGMA-TOKEN": personal_access_token },
      });

      if (!response.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Figma API error: ${response.status} ${response.statusText}`,
            },
          ],
        };
      }

      const json = (await response.json()) as {
        nodes?: Record<string, { document: FigmaNode }>;
        document?: FigmaNode;
      };

      let rootNode: FigmaNode;
      if (json.nodes && nodeId) {
        const normalizedId = nodeId.replace(/-/g, ":");
        const entry = json.nodes[normalizedId];
        if (!entry) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Node "${nodeId}" not found in Figma response.`,
              },
            ],
          };
        }
        rootNode = entry.document;
      } else if (json.document) {
        rootNode = json.document;
      } else {
        return {
          content: [
            {
              type: "text" as const,
              text: "Unexpected Figma API response structure.",
            },
          ],
        };
      }

      const simplified = simplifyNode(rootNode);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(simplified, null, 2),
          },
        ],
      };
    },
  );

  // ------ Tool B: generate_aem_boilerplate ------
  server.tool(
    "generate_aem_boilerplate",
    "Generate AEM component boilerplate (content XML, dialog, Sling Model, HTL) from Figma node data.",
    {
      component_name: z.string().min(1).describe("PascalCase component name, e.g. HeroBanner"),
      figma_data: z
        .string()
        .min(1)
        .describe("Simplified Figma node JSON (output from analyze_figma_node)"),
      target_path: z
        .string()
        .min(1)
        .describe("Java package / AEM apps path, e.g. com/mysite/components/content"),
    },
    async ({ component_name, figma_data, target_path }) => {
      let parsedFigma: FigmaDataNode;
      try {
        parsedFigma = JSON.parse(figma_data) as FigmaDataNode;
      } catch {
        return {
          content: [
            { type: "text" as const, text: "Invalid figma_data: must be valid JSON." },
          ],
        };
      }

      const contentXml = generateContentXml(component_name);
      const dialogXml = generateDialogXml(component_name, parsedFigma);
      const slingModel = generateSlingModel(component_name, parsedFigma, target_path);
      const htl = generateHtl(component_name, parsedFigma);

      const output = {
        ".content.xml": contentXml,
        "_cq_dialog/.content.xml": dialogXml,
        [`${component_name}.java`]: slingModel,
        [`${component_name}.html`]: htl,
      };

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(output, null, 2),
          },
        ],
      };
    },
  );

  // ------ Tool C: push_to_aem ------
  server.tool(
    "push_to_aem",
    "Push content XML to a running AEM instance via the Sling POST Servlet.",
    {
      jcr_path: z.string().min(1).describe("JCR path, e.g. /apps/mysite/components/heroBanner"),
      content_xml: z.string().min(1).describe("Content XML to import"),
      aem_host: z
        .string()
        .url()
        .default("http://localhost:4502")
        .describe("AEM host URL (default: http://localhost:4502)"),
      aem_user: z.string().default("admin").describe("AEM username (default: admin)"),
      aem_password: z.string().default("admin").describe("AEM password (default: admin)"),
    },
    async ({ jcr_path, content_xml, aem_host, aem_user, aem_password }) => {
      try {
        const result = await pushToAem(aem_host, jcr_path, content_xml, aem_user, aem_password);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { status: result.status, body: result.body },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            { type: "text" as const, text: `AEM push failed: ${message}` },
          ],
        };
      }
    },
  );

  return server;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error in MCP server:", err);
  process.exit(1);
});
