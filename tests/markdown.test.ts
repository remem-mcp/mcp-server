import { describe, expect, it } from "vitest";

// @ts-expect-error -- plain browser module without type declarations
import { parseInline, parseMarkdown, topHeadingLevel } from "../src/web/public/markdown.js";

describe("dashboard markdown parser", () => {
  it("parses headings, paragraphs, rules and code fences", () => {
    const blocks = parseMarkdown("# Title\n\nfirst line\nsecond line\n\n---\n\n```\n# not a heading\n<b>raw</b>\n```");
    expect(blocks.map((b: { type: string }) => b.type)).toEqual(["heading", "paragraph", "rule", "code"]);
    expect(blocks[0].level).toBe(1);
    expect(blocks[1].lines).toHaveLength(2);
    expect(blocks[3].value).toBe("# not a heading\n<b>raw</b>");
  });

  it("finds the top heading level so rendered headings do not skip levels", () => {
    expect(topHeadingLevel(parseMarkdown("## Report\n### Section\n> # quoted"))).toBe(1);
    expect(topHeadingLevel(parseMarkdown("## Report\n### Section"))).toBe(2);
    expect(topHeadingLevel(parseMarkdown("just text"))).toBe(1);
  });

  it("parses nested and ordered lists", () => {
    const [list] = parseMarkdown("- one\n  - nested\n- two\n\n1. first\n2. second");
    expect(list.ordered).toBe(false);
    expect(list.items).toHaveLength(2);
    expect(list.items[0].children[0].items[0].inline[0].value).toBe("nested");

    const ordered = parseMarkdown("1. first\n2. second")[0];
    expect(ordered.ordered).toBe(true);
    expect(ordered.items).toHaveLength(2);
  });

  it("parses block quotes", () => {
    const [quote] = parseMarkdown("> quoted\n> text");
    expect(quote.type).toBe("quote");
    expect(quote.children[0].type).toBe("paragraph");
  });

  it("parses inline code, emphasis and links", () => {
    const nodes = parseInline("a `code` **bold *both*** [site](https://example.com) end");
    expect(nodes.map((n: { type: string }) => n.type)).toEqual(["text", "code", "text", "strong", "text", "link", "text"]);
    expect(nodes[5].url).toBe("https://example.com");
  });

  it("does not turn unsafe URLs into links", () => {
    const nodes = parseInline("[click](javascript:alert(1)) [data](data:text/html,x)");
    expect(nodes.every((n: { type: string }) => n.type === "text")).toBe(true);
  });

  it("keeps HTML as plain text", () => {
    const [paragraph] = parseMarkdown("<script>alert(1)</script>");
    expect(paragraph.type).toBe("paragraph");
    expect(paragraph.lines[0][0]).toEqual({ type: "text", value: "<script>alert(1)</script>" });
  });
});
