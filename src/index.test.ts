import {
  parseFigmaUrl,
  simplifyNode,
  toCamelCase,
  toBemClass,
  generateContentXml,
  generateDialogXml,
  generateSlingModel,
  generateHtl,
  pushToAem,
  createServer,
} from "./index";

// ---------------------------------------------------------------------------
// parseFigmaUrl
// ---------------------------------------------------------------------------
describe("parseFigmaUrl", () => {
  it("extracts file key and node-id from a standard Figma URL", () => {
    const url =
      "https://www.figma.com/file/ABC123/MyFile?node-id=1-2";
    const result = parseFigmaUrl(url);
    expect(result.fileKey).toBe("ABC123");
    expect(result.nodeId).toBe("1-2");
  });

  it("handles /design/ URLs", () => {
    const url =
      "https://www.figma.com/design/XYZ789/DesignFile?node-id=10-20";
    const result = parseFigmaUrl(url);
    expect(result.fileKey).toBe("XYZ789");
    expect(result.nodeId).toBe("10-20");
  });

  it("returns empty nodeId when not present", () => {
    const url = "https://www.figma.com/file/ABC123/MyFile";
    const result = parseFigmaUrl(url);
    expect(result.fileKey).toBe("ABC123");
    expect(result.nodeId).toBe("");
  });

  it("throws for an invalid URL", () => {
    expect(() => parseFigmaUrl("https://example.com/nope")).toThrow(
      "Invalid Figma URL",
    );
  });
});

// ---------------------------------------------------------------------------
// simplifyNode
// ---------------------------------------------------------------------------
describe("simplifyNode", () => {
  it("returns basic fields for a minimal node", () => {
    const node = { id: "1", name: "Frame", type: "FRAME" };
    const result = simplifyNode(node);
    expect(result).toEqual({ id: "1", name: "Frame", type: "FRAME" });
  });

  it("extracts autoLayout properties", () => {
    const node = {
      id: "2",
      name: "AutoLayout",
      type: "FRAME",
      layoutMode: "HORIZONTAL",
      primaryAxisAlignItems: "CENTER",
      counterAxisAlignItems: "MIN",
      paddingTop: 10,
      paddingRight: 20,
      paddingBottom: 10,
      paddingLeft: 20,
      itemSpacing: 8,
    };
    const result = simplifyNode(node);
    expect(result.autoLayout).toEqual({
      direction: "HORIZONTAL",
      primaryAxisAlign: "CENTER",
      counterAxisAlign: "MIN",
      padding: { top: 10, right: 20, bottom: 10, left: 20 },
      itemSpacing: 8,
    });
  });

  it("extracts color tokens from SOLID fills", () => {
    const node = {
      id: "3",
      name: "Rect",
      type: "RECTANGLE",
      fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 } }],
    };
    const result = simplifyNode(node);
    expect(result.colorTokens).toEqual([{ r: 255, g: 0, b: 0, a: 1 }]);
  });

  it("recurses children", () => {
    const node = {
      id: "p",
      name: "Parent",
      type: "FRAME",
      children: [{ id: "c1", name: "Child", type: "TEXT", characters: "Hello" }],
    };
    const result = simplifyNode(node);
    expect(result.children).toHaveLength(1);
    const child = (result.children as Record<string, unknown>[])[0];
    expect(child.characters).toBe("Hello");
  });
});

// ---------------------------------------------------------------------------
// toCamelCase / toBemClass
// ---------------------------------------------------------------------------
describe("toCamelCase", () => {
  it("converts spaced name", () => {
    expect(toCamelCase("Hero Banner Title")).toBe("heroBannerTitle");
  });

  it("handles single word", () => {
    expect(toCamelCase("title")).toBe("title");
  });
});

describe("toBemClass", () => {
  it("returns block class", () => {
    expect(toBemClass("HeroBanner")).toBe("herobanner");
  });

  it("returns block__element", () => {
    expect(toBemClass("HeroBanner", "title")).toBe("herobanner__title");
  });

  it("returns block__element--modifier", () => {
    expect(toBemClass("HeroBanner", "title", "large")).toBe(
      "herobanner__title--large",
    );
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
  const figmaData = {
    name: "HeroBanner",
    type: "FRAME",
    children: [
      { name: "Heading", type: "TEXT", characters: "Hello World" },
      { name: "Background Image", type: "IMAGE" },
    ],
  };

  it("creates a textfield for TEXT nodes", () => {
    const xml = generateDialogXml("HeroBanner", figmaData);
    expect(xml).toContain("granite/ui/components/coral/foundation/form/textfield");
    expect(xml).toContain('name="./heading"');
  });

  it("creates a pathfield for IMAGE nodes", () => {
    const xml = generateDialogXml("HeroBanner", figmaData);
    expect(xml).toContain("granite/ui/components/coral/foundation/form/pathfield");
    expect(xml).toContain('name="./backgroundImage"');
  });
});

// ---------------------------------------------------------------------------
// generateSlingModel
// ---------------------------------------------------------------------------
describe("generateSlingModel", () => {
  const figmaData = {
    name: "Card",
    type: "FRAME",
    children: [
      { name: "Title", type: "TEXT", characters: "Card Title" },
      { name: "Icon", type: "VECTOR" },
    ],
  };

  it("generates a Java class with @ValueMapValue fields", () => {
    const java = generateSlingModel("Card", figmaData, "com/mysite/components");
    expect(java).toContain("package com.mysite.components;");
    expect(java).toContain("public class Card");
    expect(java).toContain("@ValueMapValue");
    expect(java).toContain("private String title;");
    expect(java).toContain("private String icon;");
  });

  it("generates getter methods", () => {
    const java = generateSlingModel("Card", figmaData, "com/mysite/components");
    expect(java).toContain("public String getTitle()");
    expect(java).toContain("public String getIcon()");
  });
});

// ---------------------------------------------------------------------------
// generateHtl
// ---------------------------------------------------------------------------
describe("generateHtl", () => {
  const figmaData = {
    name: "Card",
    type: "FRAME",
    children: [
      { name: "Title", type: "TEXT", characters: "Card Title" },
      { name: "Icon", type: "VECTOR" },
    ],
  };

  it("uses BEM classes", () => {
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
});

// ---------------------------------------------------------------------------
// pushToAem (mocked fetch)
// ---------------------------------------------------------------------------
describe("pushToAem", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("sends correct request and returns status/body", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      status: 200,
      text: () => Promise.resolve("OK"),
    }) as unknown as typeof fetch;

    const result = await pushToAem(
      "http://localhost:4502",
      "/apps/mysite/components/hero",
      "<jcr:root/>",
      "admin",
      "admin",
    );

    expect(result.status).toBe(200);
    expect(result.body).toBe("OK");

    const call = (global.fetch as jest.Mock).mock.calls[0];
    expect(call[0]).toBe("http://localhost:4502/apps/mysite/components/hero");
    expect(call[1].method).toBe("POST");
    expect(call[1].headers.Authorization).toMatch(/^Basic /);
  });

  it("returns error info on fetch failure", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch;

    await expect(
      pushToAem(
        "http://localhost:4502",
        "/apps/test",
        "<xml/>",
        "admin",
        "admin",
      ),
    ).rejects.toThrow("ECONNREFUSED");
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
