import {
  toCamelCase,
  toPascalCase,
  toKebabCase,
  classifyFrame,
  collectTopLevelFrames,
  collectFields,
  generateContentXml,
  generateDialogXml,
  generateHtl,
  generateSlingModel,
  execAsync,
  createServer,
  FigmaNode,
  FieldInfo,
} from "./index";
import * as fse from "fs-extra";
import * as path from "path";
import * as os from "os";

// ---------------------------------------------------------------------------
// Naming helpers
// ---------------------------------------------------------------------------
describe("toCamelCase", () => {
  it("converts spaced name", () => {
    expect(toCamelCase("Hero Banner Title")).toBe("heroBannerTitle");
  });

  it("handles single word", () => {
    expect(toCamelCase("title")).toBe("title");
  });

  it("handles PascalCase input", () => {
    expect(toCamelCase("HeroBanner")).toBe("heroBanner");
  });
});

describe("toPascalCase", () => {
  it("converts spaced name", () => {
    expect(toPascalCase("hero banner")).toBe("HeroBanner");
  });

  it("handles already PascalCase", () => {
    expect(toPascalCase("HeroBanner")).toBe("HeroBanner");
  });

  it("handles single word", () => {
    expect(toPascalCase("card")).toBe("Card");
  });
});

describe("toKebabCase", () => {
  it("converts PascalCase", () => {
    expect(toKebabCase("HeroBanner")).toBe("hero-banner");
  });

  it("converts camelCase", () => {
    expect(toKebabCase("heroBanner")).toBe("hero-banner");
  });

  it("handles spaces", () => {
    expect(toKebabCase("Hero Banner")).toBe("hero-banner");
  });

  it("handles single word", () => {
    expect(toKebabCase("card")).toBe("card");
  });
});

// ---------------------------------------------------------------------------
// classifyFrame
// ---------------------------------------------------------------------------
describe("classifyFrame", () => {
  it("classifies a frame with no children as Component", () => {
    const node: FigmaNode = { id: "1", name: "Icon", type: "FRAME" };
    expect(classifyFrame(node)).toBe("Component");
  });

  it("classifies a frame with only TEXT children as Component", () => {
    const node: FigmaNode = {
      id: "2",
      name: "Badge",
      type: "FRAME",
      children: [
        { id: "2a", name: "Label", type: "TEXT", characters: "Hello" },
      ],
    };
    expect(classifyFrame(node)).toBe("Component");
  });

  it("classifies a frame with nested FRAMEs as Container", () => {
    const node: FigmaNode = {
      id: "3",
      name: "Page Layout",
      type: "FRAME",
      children: [
        { id: "3a", name: "Header", type: "FRAME" },
        { id: "3b", name: "Footer", type: "FRAME" },
      ],
    };
    expect(classifyFrame(node)).toBe("Container");
  });

  it("classifies a frame with INSTANCE children as Container", () => {
    const node: FigmaNode = {
      id: "4",
      name: "Card Grid",
      type: "FRAME",
      children: [
        { id: "4a", name: "Card 1", type: "INSTANCE" },
        { id: "4b", name: "Card 2", type: "INSTANCE" },
      ],
    };
    expect(classifyFrame(node)).toBe("Container");
  });
});

// ---------------------------------------------------------------------------
// collectTopLevelFrames
// ---------------------------------------------------------------------------
describe("collectTopLevelFrames", () => {
  it("collects frames from CANVAS pages", () => {
    const doc: FigmaNode = {
      id: "0:0",
      name: "Document",
      type: "DOCUMENT",
      children: [
        {
          id: "1:1",
          name: "Page 1",
          type: "CANVAS",
          children: [
            { id: "2:1", name: "HeroBanner", type: "FRAME" },
            {
              id: "2:2",
              name: "CardGrid",
              type: "FRAME",
              children: [
                { id: "3:1", name: "Card", type: "COMPONENT" },
              ],
            },
            { id: "2:3", name: "Icon", type: "COMPONENT" },
          ],
        },
      ],
    };

    const frames = collectTopLevelFrames(doc);
    expect(frames).toHaveLength(3);
    expect(frames[0].name).toBe("HeroBanner");
    expect(frames[0].classification).toBe("Component");
    expect(frames[1].name).toBe("CardGrid");
    expect(frames[1].classification).toBe("Container");
    expect(frames[2].name).toBe("Icon");
    expect(frames[2].classification).toBe("Component");
  });

  it("ignores non-frame children of canvas", () => {
    const doc: FigmaNode = {
      id: "0:0",
      name: "Document",
      type: "DOCUMENT",
      children: [
        {
          id: "1:1",
          name: "Page",
          type: "CANVAS",
          children: [
            { id: "2:1", name: "Label", type: "TEXT", characters: "hi" },
          ],
        },
      ],
    };

    const frames = collectTopLevelFrames(doc);
    expect(frames).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// collectFields
// ---------------------------------------------------------------------------
describe("collectFields", () => {
  it("collects text and image fields", () => {
    const node: FigmaNode = {
      id: "1",
      name: "Card",
      type: "FRAME",
      children: [
        { id: "2", name: "Title", type: "TEXT", characters: "Hello" },
        { id: "3", name: "Background", type: "IMAGE" },
        { id: "4", name: "Icon", type: "VECTOR" },
      ],
    };
    const fields: FieldInfo[] = [];
    collectFields(node, fields);
    expect(fields).toEqual([
      { name: "title", type: "text" },
      { name: "background", type: "image" },
      { name: "icon", type: "image" },
    ]);
  });

  it("de-duplicates fields by name", () => {
    const node: FigmaNode = {
      id: "1",
      name: "Card",
      type: "FRAME",
      children: [
        { id: "2", name: "Title", type: "TEXT", characters: "A" },
        { id: "3", name: "Title", type: "TEXT", characters: "B" },
      ],
    };
    const fields: FieldInfo[] = [];
    collectFields(node, fields);
    expect(fields).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// generateContentXml
// ---------------------------------------------------------------------------
describe("generateContentXml", () => {
  it("produces valid component XML", () => {
    const xml = generateContentXml("HeroBanner");
    expect(xml).toContain('jcr:primaryType="cq:Component"');
    expect(xml).toContain('jcr:title="Hero Banner"');
    expect(xml).toContain('componentGroup="Custom Components"');
  });
});

// ---------------------------------------------------------------------------
// generateDialogXml
// ---------------------------------------------------------------------------
describe("generateDialogXml", () => {
  const figmaData: FigmaNode = {
    id: "1",
    name: "HeroBanner",
    type: "FRAME",
    children: [
      { id: "2", name: "Heading", type: "TEXT", characters: "Hello World" },
      { id: "3", name: "Background Image", type: "IMAGE" },
    ],
  };

  it("creates a textfield for TEXT nodes", () => {
    const xml = generateDialogXml("HeroBanner", figmaData);
    expect(xml).toContain(
      "granite/ui/components/coral/foundation/form/textfield",
    );
    expect(xml).toContain('name="./heading"');
  });

  it("creates a pathfield for IMAGE nodes", () => {
    const xml = generateDialogXml("HeroBanner", figmaData);
    expect(xml).toContain(
      "granite/ui/components/coral/foundation/form/pathfield",
    );
    expect(xml).toContain('name="./backgroundImage"');
  });
});

// ---------------------------------------------------------------------------
// generateHtl
// ---------------------------------------------------------------------------
describe("generateHtl", () => {
  const figmaData: FigmaNode = {
    id: "1",
    name: "Card",
    type: "FRAME",
    children: [
      { id: "2", name: "Title", type: "TEXT", characters: "Card Title" },
      { id: "3", name: "Icon", type: "VECTOR" },
    ],
  };

  it("uses kebab-case classes", () => {
    const htl = generateHtl("Card", figmaData);
    expect(htl).toContain('class="card"');
    expect(htl).toContain('class="card__title"');
    expect(htl).toContain('class="card__icon"');
  });

  it("uses data-sly-use with model class", () => {
    const htl = generateHtl("Card", figmaData);
    expect(htl).toContain('data-sly-use.model="Card"');
  });

  it("renders text in a div and images in an img tag", () => {
    const htl = generateHtl("Card", figmaData);
    expect(htl).toContain("<div");
    expect(htl).toContain("<img");
  });

  it("includes flexbox style block when layoutMode is set", () => {
    const figmaWithLayout: FigmaNode = {
      id: "1",
      name: "Row",
      type: "FRAME",
      layoutMode: "HORIZONTAL",
      children: [
        { id: "2", name: "Label", type: "TEXT", characters: "hi" },
      ],
    };
    const htl = generateHtl("Row", figmaWithLayout);
    expect(htl).toContain("display: flex");
    expect(htl).toContain("flex-direction: row");
  });

  it("generates column direction for VERTICAL layout", () => {
    const figmaVertical: FigmaNode = {
      id: "1",
      name: "Stack",
      type: "FRAME",
      layoutMode: "VERTICAL",
      children: [
        { id: "2", name: "Label", type: "TEXT", characters: "hi" },
      ],
    };
    const htl = generateHtl("Stack", figmaVertical);
    expect(htl).toContain("flex-direction: column");
  });
});

// ---------------------------------------------------------------------------
// generateSlingModel
// ---------------------------------------------------------------------------
describe("generateSlingModel", () => {
  const figmaData: FigmaNode = {
    id: "1",
    name: "Card",
    type: "FRAME",
    children: [
      { id: "2", name: "Title", type: "TEXT", characters: "Card Title" },
      { id: "3", name: "Icon", type: "VECTOR" },
    ],
  };

  it("generates a Java class with @Model, @ValueMapValue, and @Exporter", () => {
    const java = generateSlingModel("Card", figmaData, "com.mysite.core.models");
    expect(java).toContain("package com.mysite.core.models;");
    expect(java).toContain("public class Card");
    expect(java).toContain("@Model(");
    expect(java).toContain("@ValueMapValue");
    expect(java).toContain("@Exporter(name = \"jackson\", extensions = \"json\")");
    expect(java).toContain("private String title;");
    expect(java).toContain("private String icon;");
  });

  it("generates getter methods", () => {
    const java = generateSlingModel("Card", figmaData, "com.mysite.core.models");
    expect(java).toContain("public String getTitle()");
    expect(java).toContain("public String getIcon()");
  });

  it("includes resourceType as kebab-case", () => {
    const java = generateSlingModel(
      "HeroBanner",
      figmaData,
      "com.mysite.core.models",
    );
    expect(java).toContain('resourceType = "hero-banner"');
  });
});

// ---------------------------------------------------------------------------
// execAsync
// ---------------------------------------------------------------------------
describe("execAsync", () => {
  it("resolves with stdout on success", async () => {
    const result = await execAsync("echo hello");
    expect(result.stdout.trim()).toBe("hello");
  });

  it("rejects on a bad command", async () => {
    await expect(execAsync("false")).rejects.toThrow("Command failed");
  });
});

// ---------------------------------------------------------------------------
// write_component_ui integration (file system)
// ---------------------------------------------------------------------------
describe("write_component_ui integration", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), "aem-test-"));
    // Create a minimal ui.apps structure
    const uiAppsDir = path.join(
      tmpDir,
      "ui.apps",
      "src",
      "main",
      "content",
      "jcr_root",
      "apps",
      "mysite",
      "components",
    );
    await fse.ensureDir(uiAppsDir);
  });

  afterEach(async () => {
    await fse.remove(tmpDir);
  });

  it("writes component files to the correct location", async () => {
    const figmaData: FigmaNode = {
      id: "1",
      name: "HeroBanner",
      type: "FRAME",
      children: [
        { id: "2", name: "Title", type: "TEXT", characters: "Hello" },
      ],
    };

    const kebabName = toKebabCase("HeroBanner");
    const componentDir = path.join(
      tmpDir,
      "ui.apps",
      "src",
      "main",
      "content",
      "jcr_root",
      "apps",
      "mysite",
      "components",
      kebabName,
    );

    await fse.ensureDir(componentDir);
    await fse.ensureDir(path.join(componentDir, "_cq_dialog"));

    const contentXml = generateContentXml("HeroBanner");
    const dialogXml = generateDialogXml("HeroBanner", figmaData);
    const htl = generateHtl("HeroBanner", figmaData);

    await fse.writeFile(path.join(componentDir, ".content.xml"), contentXml);
    await fse.writeFile(
      path.join(componentDir, "_cq_dialog", ".content.xml"),
      dialogXml,
    );
    await fse.writeFile(
      path.join(componentDir, `${kebabName}.html`),
      htl,
    );

    expect(await fse.pathExists(path.join(componentDir, ".content.xml"))).toBe(
      true,
    );
    expect(
      await fse.pathExists(
        path.join(componentDir, "_cq_dialog", ".content.xml"),
      ),
    ).toBe(true);
    expect(
      await fse.pathExists(path.join(componentDir, `${kebabName}.html`)),
    ).toBe(true);

    const writtenXml = await fse.readFile(
      path.join(componentDir, ".content.xml"),
      "utf-8",
    );
    expect(writtenXml).toContain('jcr:title="Hero Banner"');
  });
});

// ---------------------------------------------------------------------------
// write_component_logic integration (file system)
// ---------------------------------------------------------------------------
describe("write_component_logic integration", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), "aem-test-"));
    // Create a minimal core module structure
    const modelsDir = path.join(
      tmpDir,
      "core",
      "src",
      "main",
      "java",
      "com",
      "mysite",
      "core",
      "models",
    );
    await fse.ensureDir(modelsDir);
  });

  afterEach(async () => {
    await fse.remove(tmpDir);
  });

  it("writes a Sling Model Java file", async () => {
    const figmaData: FigmaNode = {
      id: "1",
      name: "Card",
      type: "FRAME",
      children: [
        { id: "2", name: "Title", type: "TEXT", characters: "Hi" },
      ],
    };

    const packageName = "com.mysite.core.models";
    const className = toPascalCase("Card");
    const packageDir = path.join(
      tmpDir,
      "core",
      "src",
      "main",
      "java",
      "com",
      "mysite",
      "core",
      "models",
    );

    const javaCode = generateSlingModel("Card", figmaData, packageName);
    const javaFile = path.join(packageDir, `${className}.java`);
    await fse.writeFile(javaFile, javaCode, "utf-8");

    expect(await fse.pathExists(javaFile)).toBe(true);
    const content = await fse.readFile(javaFile, "utf-8");
    expect(content).toContain("package com.mysite.core.models;");
    expect(content).toContain("@Exporter");
    expect(content).toContain("public class Card");
  });
});

// ---------------------------------------------------------------------------
// createServer – smoke test
// ---------------------------------------------------------------------------
describe("createServer", () => {
  it("returns an McpServer instance", () => {
    const server = createServer();
    expect(server).toBeDefined();
  });
});
