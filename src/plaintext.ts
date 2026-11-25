/**
 * Converts a Markdown report to plain text that reads well when pasted
 * into chat tools or e-mail, where Markdown is not rendered.
 */

const HEADING_MARKS = ["■", "◆", "▼"];

/** Remove inline Markdown syntax */
function stripInline(text: string): string {
  return text
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\*\*([^\n]+?)\*\*/g, "$1")
    .replace(/(^|[^*])\*([^*\s][^*\n]*?)\*/g, "$1$2")
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, "$1 ($2)");
}

export function markdownToPlainText(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const levels = lines.map((line) => /^(#{1,6})\s/.exec(line)?.[1].length).filter((level) => level !== undefined);
  const top = levels.length > 0 ? Math.min(...levels) : 1;

  const output: string[] = [];
  let inFence = false;

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      output.push(`    ${line}`);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      const mark = HEADING_MARKS[Math.min(heading[1].length - top, HEADING_MARKS.length - 1)];
      if (output.length > 0 && output[output.length - 1] !== "") output.push("");
      output.push(`${mark} ${stripInline(heading[2])}`);
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      output.push("────────────────");
      continue;
    }

    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      output.push(`${bullet[1]}・${stripInline(bullet[2])}`);
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(line);
    output.push(quote ? `  ${stripInline(quote[1])}` : stripInline(line));
  }

  return output
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
