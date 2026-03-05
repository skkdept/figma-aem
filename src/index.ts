import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile } from "child_process";
import * as fse from "fs-extra";
import * as path from "path";

// ---------------------------------------------------------------------------
// Naming helpers
// ---------------------------------------------------------------------------

/** Convert an arbitrary string to camelCase (for Java field names). */
export function toCamelCase(str: string): string {
  return str
    .replace(/[^a-zA-Z0-9]+(.)/g, (_, chr: string) => chr.toUpperCase())
    .replace(/^[A-Z]/, (chr) => chr.toLowerCase());
}

/** Convert a string to PascalCase (for Java class names). */
export function toPascalCase(str: string): string {
  const camel = toCamelCase(str);
  return camel.charAt(0).toUpperCase() + camel.slice(1);
}

/** Convert a string to kebab-case (for JCR node names). */
export function toKebabCase(str: string): string {
  return str
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .toLowerCase()
    .replace(/^-+|-+$/g, "");
}

// ---------------------------------------------------------------------------
// Shell helper
// ---------------------------------------------------------------------------

/**
 * Validate that a string is safe to use as a Maven argument value.
 * Rejects shell metacharacters to prevent command injection.
 */
export function validateMavenArg(value: string, label: string): void {
  if (/[`$;|&<>(){}!\\]/.test(value)) {
    throw new Error(
      `Invalid ${label}: contains disallowed characters. Only alphanumeric, spaces, dots, hyphens, and underscores are permitted.`,
    );
  }
}

export function execFileAsync(
  file: string,
  args: string[],
  options?: { cwd?: string },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd: options?.cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`Command failed: ${err.message}\nstderr: ${stderr}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

// ---------------------------------------------------------------------------
// Figma types & helpers
// ---------------------------------------------------------------------------

export interface FigmaNode {
  id: string;
  name: string;
  type: string;
  children?: FigmaNode[];
  layoutMode?: string;
  characters?: string;
}

export interface FrameInfo {
  id: string;
  name: string;
  type: string;
  classification: "Component" | "Container";
}

/**
 * Classify a top-level frame as Component or Container.
 * A Container is a frame that has children which are themselves frames (or instances).
 * A Component is everything else (leaf-level design element).
 */
export function classifyFrame(node: FigmaNode): "Component" | "Container" {
  if (!node.children || node.children.length === 0) {
    return "Component";
  }
  const hasNestedFrames = node.children.some(
    (child) =>
      child.type === "FRAME" ||
      child.type === "COMPONENT" ||
      child.type === "INSTANCE",
  );
  return hasNestedFrames ? "Container" : "Component";
}

/**
 * Recursively traverse the Figma tree and collect all top-level frames
 * (direct children of CANVAS pages).
 */
export function collectTopLevelFrames(node: FigmaNode): FrameInfo[] {
  const frames: FrameInfo[] = [];

  if (node.type === "CANVAS" && node.children) {
    for (const child of node.children) {
      if (
        child.type === "FRAME" ||
        child.type === "COMPONENT" ||
        child.type === "COMPONENT_SET"
      ) {
        frames.push({
          id: child.id,
          name: child.name,
          type: child.type,
          classification: classifyFrame(child),
        });
      }
    }
  }

  // Recurse into pages if we're at document level
  if (node.children) {
    for (const child of node.children) {
      if (child.type === "CANVAS") {
        frames.push(...collectTopLevelFrames(child));
      }
    }
  }

  return frames;
}

// ---------------------------------------------------------------------------
// Figma-data field extraction
// ---------------------------------------------------------------------------

export interface FieldInfo {
  name: string;
  type: "text" | "image";
}

export function collectFields(
  node: FigmaNode,
  fields: FieldInfo[],
): void {
  if (node.type === "TEXT" && node.characters) {
    const fieldName = toCamelCase(node.name);
    if (!fields.some((f) => f.name === fieldName)) {
      fields.push({ name: fieldName, type: "text" });
    }
  }
  if (
    node.type === "RECTANGLE" ||
    node.type === "IMAGE" ||
    node.type === "VECTOR"
  ) {
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

// ---------------------------------------------------------------------------
// Code generators for write_component_ui
// ---------------------------------------------------------------------------

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
  figmaData: FigmaNode,
): string {
  const fields: FieldInfo[] = [];
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

export function generateHtl(
  componentName: string,
  figmaData: FigmaNode,
): string {
  const fields: FieldInfo[] = [];
  collectFields(figmaData, fields);

  const blockName = toKebabCase(componentName);
  const className = toPascalCase(componentName);

  /** Convert camelCase field name to a human-readable label. */
  const toLabel = (name: string): string =>
    name.replace(/([A-Z])/g, " $1").trim().toLowerCase();

  const innerHtml = fields
    .map((f) => {
      const elementClass = `${blockName}__${toKebabCase(f.name)}`;
      if (f.type === "text") {
        return `    <div class="${elementClass}">\${model.${f.name}}</div>`;
      }
      return `    <img class="${elementClass}" src="\${model.${f.name}}" alt="${toLabel(f.name)}"/>`;
    })
    .join("\n");

  // Map Figma auto-layout to flexbox CSS (inline, inside the component markup)
  let styleBlock = "";
  if (figmaData.layoutMode) {
    const direction = figmaData.layoutMode === "HORIZONTAL" ? "row" : "column";
    styleBlock = `\n    <style>
    .${blockName} {
        display: flex;
        flex-direction: ${direction};
    }
    </style>`;
  }

  return `<sly data-sly-use.model="${className}">
<div class="${blockName}">
${innerHtml}${styleBlock}
</div>
</sly>
`;
}

// ---------------------------------------------------------------------------
// Code generator for write_component_logic
// ---------------------------------------------------------------------------

export function generateSlingModel(
  componentName: string,
  figmaData: FigmaNode,
  packageName: string,
): string {
  const fields: FieldInfo[] = [];
  collectFields(figmaData, fields);

  const className = toPascalCase(componentName);
  const kebabName = toKebabCase(componentName);

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

  return `package ${packageName};

import org.apache.sling.api.SlingHttpServletRequest;
import org.apache.sling.api.resource.Resource;
import org.apache.sling.models.annotations.DefaultInjectionStrategy;
import org.apache.sling.models.annotations.Exporter;
import org.apache.sling.models.annotations.Model;
import org.apache.sling.models.annotations.injectorspecific.ValueMapValue;
import org.apache.sling.models.annotations.InjectionStrategy;

@Model(
    adaptables = {Resource.class, SlingHttpServletRequest.class},
    defaultInjectionStrategy = DefaultInjectionStrategy.OPTIONAL,
    resourceType = "${kebabName}"
)
@Exporter(name = "jackson", extensions = "json")
public class ${className} {

${fieldDeclarations}

${getters}
}
`;
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

export function createServer(): McpServer {
  const server = new McpServer({
    name: "aem-master-architect",
    version: "1.0.0",
  });

  // ------ Tool 1: init_project ------
  server.tool(
    "init_project",
    "Create a full Maven multi-module AEM project structure using the aem-project-archetype.",
    {
      appId: z.string().min(1).describe("Application ID (e.g. 'mysite')"),
      groupId: z.string().min(1).describe("Maven Group ID (e.g. 'com.mysite')"),
      appTitle: z.string().min(1).describe("Human-readable application title (e.g. 'My Site')"),
    },
    async ({ appId, groupId, appTitle }) => {
      try {
        // Validate inputs to prevent injection
        validateMavenArg(appId, "appId");
        validateMavenArg(groupId, "groupId");
        validateMavenArg(appTitle, "appTitle");

        const args = [
          "archetype:generate", "-B",
          "-DarchetypeGroupId=com.adobe.aem",
          "-DarchetypeArtifactId=aem-project-archetype",
          "-DarchetypeVersion=49",
          `-DappTitle=${appTitle}`,
          `-DappId=${appId}`,
          `-DgroupId=${groupId}`,
          `-DartifactId=${appId}`,
          `-Dpackage=${groupId}`,
        ];

        const { stdout, stderr } = await execFileAsync("mvn", args);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { success: true, appId, projectPath: path.resolve(appId), stdout, stderr },
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
            { type: "text" as const, text: JSON.stringify({ success: false, error: message }, null, 2) },
          ],
        };
      }
    },
  );

  // ------ Tool 2: crawl_figma ------
  server.tool(
    "crawl_figma",
    "Recursively traverse the Figma JSON tree and return all top-level frames, classifying each as Component or Container.",
    {
      figmaUrl: z.string().url().describe("Full Figma file URL"),
      figmaToken: z.string().min(1).describe("Figma Personal Access Token"),
    },
    async ({ figmaUrl, figmaToken }) => {
      try {
        const url = new URL(figmaUrl);
        const pathParts = url.pathname.split("/");
        const fileIndex =
          pathParts.indexOf("file") !== -1
            ? pathParts.indexOf("file")
            : pathParts.indexOf("design");
        if (fileIndex === -1 || fileIndex + 1 >= pathParts.length) {
          throw new Error("Invalid Figma URL: could not extract file key.");
        }
        const fileKey = pathParts[fileIndex + 1];

        const apiUrl = `https://api.figma.com/v1/files/${fileKey}`;
        const response = await fetch(apiUrl, {
          headers: { "X-FIGMA-TOKEN": figmaToken },
        });

        if (!response.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: false,
                  error: `Figma API error: ${response.status} ${response.statusText}`,
                }, null, 2),
              },
            ],
          };
        }

        const json = (await response.json()) as { document: FigmaNode };
        const frames = collectTopLevelFrames(json.document);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: true, frames }, null, 2),
            },
          ],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ success: false, error: message }, null, 2) },
          ],
        };
      }
    },
  );

  // ------ Tool 3: write_component_ui ------
  server.tool(
    "write_component_ui",
    "Create AEM component UI files: HTL template, .content.xml, and Granite UI Dialog XML in the ui.apps module.",
    {
      componentName: z.string().min(1).describe("PascalCase component name (e.g. 'HeroBanner')"),
      figmaJson: z.string().min(1).describe("Figma node JSON describing the component structure"),
      projectPath: z.string().min(1).describe("Absolute path to the AEM project root"),
    },
    async ({ componentName, figmaJson, projectPath }) => {
      try {
        const figmaData = JSON.parse(figmaJson) as FigmaNode;
        const kebabName = toKebabCase(componentName);

        // Discover the ui.apps component directory
        const uiAppsBase = path.join(
          projectPath,
          "ui.apps",
          "src",
          "main",
          "content",
          "jcr_root",
          "apps",
        );
        // Find the app folder — prefer a directory that already contains 'components'
        let appFolder: string;
        if (await fse.pathExists(uiAppsBase)) {
          const entries = await fse.readdir(uiAppsBase);
          const dirs: string[] = [];
          for (const entry of entries) {
            const stat = await fse.stat(path.join(uiAppsBase, entry));
            if (stat.isDirectory()) {
              dirs.push(entry);
            }
          }
          // Prefer the directory that already has a 'components' subfolder
          let found: string | undefined;
          for (const dir of dirs) {
            if (await fse.pathExists(path.join(uiAppsBase, dir, "components"))) {
              found = dir;
              break;
            }
          }
          appFolder = found ?? (dirs.length > 0 ? dirs[0] : path.basename(projectPath));
        } else {
          appFolder = path.basename(projectPath);
        }

        const componentDir = path.join(
          uiAppsBase,
          appFolder,
          "components",
          kebabName,
        );

        await fse.ensureDir(componentDir);
        await fse.ensureDir(path.join(componentDir, "_cq_dialog"));

        // Generate files
        const contentXml = generateContentXml(componentName);
        const dialogXml = generateDialogXml(componentName, figmaData);
        const htl = generateHtl(componentName, figmaData);

        await fse.writeFile(
          path.join(componentDir, ".content.xml"),
          contentXml,
          "utf-8",
        );
        await fse.writeFile(
          path.join(componentDir, "_cq_dialog", ".content.xml"),
          dialogXml,
          "utf-8",
        );
        await fse.writeFile(
          path.join(componentDir, `${kebabName}.html`),
          htl,
          "utf-8",
        );

        const filesWritten = [
          path.join(componentDir, ".content.xml"),
          path.join(componentDir, "_cq_dialog", ".content.xml"),
          path.join(componentDir, `${kebabName}.html`),
        ];

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: true, componentDir, filesWritten }, null, 2),
            },
          ],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ success: false, error: message }, null, 2) },
          ],
        };
      }
    },
  );

  // ------ Tool 4: write_component_logic ------
  server.tool(
    "write_component_logic",
    "Generate a Java Sling Model for an AEM component in the core module, with @Model, @ValueMapValue, and @Exporter annotations.",
    {
      componentName: z.string().min(1).describe("PascalCase component name (e.g. 'HeroBanner')"),
      figmaJson: z.string().min(1).describe("Figma node JSON describing the component structure"),
      projectPath: z.string().min(1).describe("Absolute path to the AEM project root"),
    },
    async ({ componentName, figmaJson, projectPath }) => {
      try {
        const figmaData = JSON.parse(figmaJson) as FigmaNode;
        const className = toPascalCase(componentName);

        // Discover the Java source root in the core module
        const coreJavaBase = path.join(projectPath, "core", "src", "main", "java");

        // Resolve the package from the existing directory structure
        let packageName = "com.example.core.models";
        if (await fse.pathExists(coreJavaBase)) {
          const visited = new Set<string>();

          // Walk to find a 'models' directory
          const findPackage = async (dir: string, depth: number): Promise<string | null> => {
            if (depth > 6) return null;
            const realDir = await fse.realpath(dir);
            if (visited.has(realDir)) return null;
            visited.add(realDir);

            const entries = await fse.readdir(dir);
            for (const entry of entries) {
              const full = path.join(dir, entry);
              const stat = await fse.stat(full);
              if (stat.isDirectory()) {
                if (entry === "models") {
                  return full;
                }
                const result = await findPackage(full, depth + 1);
                if (result) return result;
              }
            }
            return null;
          };

          const modelsDir = await findPackage(coreJavaBase, 0);
          if (modelsDir) {
            packageName = path.relative(coreJavaBase, modelsDir).replace(/\//g, ".").replace(/\\/g, ".");
          } else {
            // Use the first package found and append .models
            const firstLevel = await fse.readdir(coreJavaBase);
            if (firstLevel.length > 0) {
              const walkDown = async (dir: string, depth: number): Promise<string> => {
                if (depth > 4) return dir;
                const realDir = await fse.realpath(dir);
                if (visited.has(realDir)) return dir;
                visited.add(realDir);

                const entries = await fse.readdir(dir);
                const dirs = [];
                for (const entry of entries) {
                  const full = path.join(dir, entry);
                  const stat = await fse.stat(full);
                  if (stat.isDirectory()) dirs.push(full);
                }
                if (dirs.length === 1) return walkDown(dirs[0], depth + 1);
                return dir;
              };
              const deepest = await walkDown(coreJavaBase, 0);
              const relPath = path.relative(coreJavaBase, deepest);
              if (relPath) {
                packageName = relPath.replace(/\//g, ".").replace(/\\/g, ".") + ".models";
              }
            }
          }
        }

        // Create the directory structure and write the Java file
        const packageDir = path.join(coreJavaBase, packageName.replace(/\./g, "/"));
        await fse.ensureDir(packageDir);

        const javaCode = generateSlingModel(componentName, figmaData, packageName);
        const javaFilePath = path.join(packageDir, `${className}.java`);
        await fse.writeFile(javaFilePath, javaCode, "utf-8");

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { success: true, javaFilePath, packageName, className },
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
            { type: "text" as const, text: JSON.stringify({ success: false, error: message }, null, 2) },
          ],
        };
      }
    },
  );

  // ------ Tool 5: deploy_project ------
  server.tool(
    "deploy_project",
    "Build and deploy the AEM project to a running AEM instance using Maven.",
    {
      projectPath: z.string().min(1).describe("Absolute path to the AEM project root"),
    },
    async ({ projectPath }) => {
      try {
        const { stdout, stderr } = await execFileAsync(
          "mvn",
          ["clean", "install", "-PautoInstallPackage"],
          { cwd: projectPath },
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: true, stdout, stderr }, null, 2),
            },
          ],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ success: false, error: message }, null, 2) },
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
