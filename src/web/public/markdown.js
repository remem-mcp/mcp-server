/**
 * Minimal, safe Markdown renderer for the Remem dashboard.
 *
 * Text is parsed into a small tree and turned into DOM nodes with
 * `textContent` only, so report content can never inject HTML or scripts.
 * Supported: headings, paragraphs, nested lists, block quotes, fenced code,
 * horizontal rules, and inline code / bold / italic / links.
 */

const INLINE_PATTERN = /(`[^`\n]+`)|(\*\*[^\n]+?\*\*)|(\*[^*\s][^*\n]*?\*)|(\[[^\]\n]+\]\([^)\s]+\))/g;
const SAFE_URL = /^(https?:\/\/|mailto:)/i;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;

/** Parse inline Markdown into nodes: {type: "text" | "code" | "strong" | "em" | "link"} */
export function parseInline(text) {
  const nodes = [];
  let last = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    if (match.index > last) nodes.push({ type: "text", value: text.slice(last, match.index) });
    const token = match[0];
    if (match[1]) {
      nodes.push({ type: "code", value: token.slice(1, -1) });
    } else if (match[2]) {
      nodes.push({ type: "strong", children: parseInline(token.slice(2, -2)) });
    } else if (match[3]) {
      nodes.push({ type: "em", children: parseInline(token.slice(1, -1)) });
    } else {
      const split = token.lastIndexOf("](");
      const label = token.slice(1, split);
      const url = token.slice(split + 2, -1);
      if (SAFE_URL.test(url)) {
        nodes.push({ type: "link", url, children: parseInline(label) });
      } else {
        nodes.push({ type: "text", value: token });
      }
    }
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push({ type: "text", value: text.slice(last) });
  return nodes;
}

/** Parse consecutive list lines (starting at `start`) into a nested list block */
function parseList(lines, start) {
  const root = { type: "list", ordered: /\d/.test(LIST_ITEM.exec(lines[start])[2]), items: [], indent: 0 };
  root.indent = LIST_ITEM.exec(lines[start])[1].length;
  const stack = [root];
  let index = start;

  for (; index < lines.length; index++) {
    const match = LIST_ITEM.exec(lines[index]);
    if (!match) break;
    const indent = match[1].length;

    while (stack.length > 1 && indent < stack[stack.length - 1].indent) stack.pop();
    let list = stack[stack.length - 1];

    if (indent > list.indent && list.items.length > 0) {
      const nested = { type: "list", ordered: /\d/.test(match[2]), items: [], indent };
      list.items[list.items.length - 1].children.push(nested);
      stack.push(nested);
      list = nested;
    }
    list.items.push({ inline: parseInline(match[3]), children: [] });
  }

  return { block: root, next: index };
}

/** Parse Markdown text into a list of block nodes */
export function parseMarkdown(text) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (line.trim() === "") {
      index++;
      continue;
    }

    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      const code = [];
      index++;
      while (index < lines.length && !lines[index].trim().startsWith(fence[1])) code.push(lines[index++]);
      index++;
      blocks.push({ type: "code", value: code.join("\n") });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, inline: parseInline(heading[2]) });
      index++;
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ type: "rule" });
      index++;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quote = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) quote.push(lines[index++].replace(/^\s*>\s?/, ""));
      blocks.push({ type: "quote", children: parseMarkdown(quote.join("\n")) });
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const { block, next } = parseList(lines, index);
      blocks.push(block);
      index = next;
      continue;
    }

    const paragraph = [];
    while (
      index < lines.length &&
      lines[index].trim() !== "" &&
      !/^\s*(```|~~~|>|#{1,6}\s)/.test(lines[index]) &&
      !LIST_ITEM.test(lines[index])
    ) {
      paragraph.push(parseInline(lines[index++].trim()));
    }
    blocks.push({ type: "paragraph", lines: paragraph });
  }

  return blocks;
}

/** Smallest heading level used anywhere in the blocks (1 when there are no headings) */
export function topHeadingLevel(blocks) {
  let top = 7;
  const visit = (items) => {
    for (const block of items) {
      if (block.type === "heading") top = Math.min(top, block.level);
      else if (block.type === "quote") visit(block.children);
    }
  };
  visit(blocks);
  return top === 7 ? 1 : top;
}

function appendInline(doc, parent, nodes) {
  for (const node of nodes) {
    if (node.type === "text") {
      parent.append(doc.createTextNode(node.value));
    } else if (node.type === "code") {
      const code = doc.createElement("code");
      code.textContent = node.value;
      parent.append(code);
    } else if (node.type === "link") {
      const link = doc.createElement("a");
      link.href = node.url;
      link.rel = "noopener noreferrer";
      appendInline(doc, link, node.children);
      parent.append(link);
    } else {
      const element = doc.createElement(node.type === "strong" ? "strong" : "em");
      appendInline(doc, element, node.children);
      parent.append(element);
    }
  }
}

function appendBlocks(doc, parent, blocks, baseLevel) {
  for (const block of blocks) {
    if (block.type === "heading") {
      // Keep headings below the page's own headings so the outline stays valid
      const heading = doc.createElement(`h${Math.max(1, Math.min(6, baseLevel + block.level - 1))}`);
      appendInline(doc, heading, block.inline);
      parent.append(heading);
    } else if (block.type === "code") {
      const pre = doc.createElement("pre");
      const code = doc.createElement("code");
      code.textContent = block.value;
      pre.tabIndex = 0; // scrollable region must be keyboard reachable
      pre.append(code);
      parent.append(pre);
    } else if (block.type === "rule") {
      parent.append(doc.createElement("hr"));
    } else if (block.type === "quote") {
      const quote = doc.createElement("blockquote");
      appendBlocks(doc, quote, block.children, baseLevel);
      parent.append(quote);
    } else if (block.type === "list") {
      const list = doc.createElement(block.ordered ? "ol" : "ul");
      for (const item of block.items) {
        const li = doc.createElement("li");
        appendInline(doc, li, item.inline);
        appendBlocks(doc, li, item.children, baseLevel);
        list.append(li);
      }
      parent.append(list);
    } else {
      const paragraph = doc.createElement("p");
      block.lines.forEach((line, lineIndex) => {
        if (lineIndex > 0) paragraph.append(doc.createElement("br"));
        appendInline(doc, paragraph, line);
      });
      parent.append(paragraph);
    }
  }
}

/**
 * Render Markdown into `container` (replacing its content).
 *
 * @param {HTMLElement} container
 * @param {string} text
 * @param {number} baseLevel - Heading level used for a Markdown "#" heading
 */
export function renderMarkdown(container, text, baseLevel = 3) {
  const blocks = parseMarkdown(text);
  // Reports often start at "##"; shift so their top heading lands on baseLevel
  // and no heading level is skipped on the page.
  const top = topHeadingLevel(blocks);
  container.replaceChildren();
  appendBlocks(container.ownerDocument, container, blocks, baseLevel - (top - 1));
}
