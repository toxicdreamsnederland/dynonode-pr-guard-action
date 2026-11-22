#!/usr/bin/env node
/**
 * @dynonode/pr-guard-action — Zero-dependency GitHub Action & CLI
 * Scans changed .md / .html files in pull requests for:
 *   1. Dead / broken local & HTTP(S) links
 *   2. WCAG 2.2 AA regressions: <img> missing alt, <html> missing lang, and empty <a>/<button> controls
 */

import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const BLOCKED_V4 = new net.BlockList();
BLOCKED_V4.addSubnet("0.0.0.0", 8, "ipv4");
BLOCKED_V4.addSubnet("10.0.0.0", 8, "ipv4");
BLOCKED_V4.addSubnet("100.64.0.0", 10, "ipv4");
BLOCKED_V4.addSubnet("127.0.0.0", 8, "ipv4");
BLOCKED_V4.addSubnet("169.254.0.0", 16, "ipv4");
BLOCKED_V4.addSubnet("172.16.0.0", 12, "ipv4");
BLOCKED_V4.addSubnet("192.168.0.0", 16, "ipv4");

export function isSafePublicHttpUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (u.username || u.password) return false;
    const host = u.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      host.endsWith(".internal") ||
      host.startsWith("[")
    ) {
      return false;
    }
    if (net.isIPv4(host) && BLOCKED_V4.check(host, "ipv4")) return false;
    if (net.isIPv6(host)) return false;
    return true;
  } catch {
    return false;
  }
}

function stripFencedCodeAndScripts(text, ext) {
  if (ext === ".md") {
    return text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]+`/g, "");
  }
  return text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
}

export function extractLinksFromContent(content, ext = ".html") {
  const cleaned = stripFencedCodeAndScripts(String(content || ""), ext);
  const found = [];

  if (ext === ".md") {
    const mdLinkRe = /(?<!!)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    for (const m of cleaned.matchAll(mdLinkRe)) {
      found.push({ label: m[1].trim(), target: m[2].trim() });
    }
    const autoLinkRe = /<(https?:\/\/[^>\s]+)>/gi;
    for (const m of cleaned.matchAll(autoLinkRe)) {
      found.push({ label: m[1].trim(), target: m[1].trim() });
    }
  } else {
    const hrefRe = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi;
    for (const m of cleaned.matchAll(hrefRe)) {
      const target = (m[1] ?? m[2] ?? m[3] ?? "").trim();
      if (target) found.push({ label: "", target });
    }
  }

  return found.filter(
    (item) =>
      item.target &&
      !item.target.startsWith("#") &&
      !/^(mailto:|tel:|javascript:|data:)/i.test(item.target)
  );
}

function stripTagsToText(innerHtml) {
  return String(innerHtml || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasAccessibleAttrOrImgAlt(openTag, innerHtml = "") {
  if (/\baria-label\s*=\s*(?:"[^"\s][^"]*"|'[^'\s][^']*')/i.test(openTag)) return true;
  if (/\baria-labelledby\s*=\s*(?:"[^"\s][^"]*"|'[^'\s][^']*')/i.test(openTag)) return true;
  if (/\btitle\s*=\s*(?:"[^"\s][^"]*"|'[^'\s][^']*')/i.test(openTag)) return true;
  if (/<img\b[^>]*\balt\s*=\s*(?:"[^"\s][^"]*"|'[^'\s][^']*')/i.test(innerHtml)) return true;
  if (/<svg\b[^>]*>[\s\S]*?<title\b[^>]*>[^<]+<\/title>/i.test(innerHtml)) return true;
  return false;
}

export function auditHtmlWcagIssues(html, filePath = "index.html") {
  const cleaned = stripFencedCodeAndScripts(String(html || ""), ".html");
  const issues = [];

  // 1. Full HTML documents must declare a non-empty lang attribute on <html> (WCAG 2.2 SC 3.1.1)
  const htmlTagMatch = cleaned.match(/<html\b([^>]*)>/i);
  if (htmlTagMatch) {
    const attrs = htmlTagMatch[1] || "";
    const langMatch = attrs.match(/\blang\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const langVal = (langMatch?.[1] ?? langMatch?.[2] ?? langMatch?.[3] ?? "").trim();
    if (!langVal) {
      issues.push({
        file: filePath,
        type: "wcag",
        rule: "WCAG 3.1.1 (html-has-lang)",
        severity: "error",
        detail: "`<html>` element is missing a valid non-empty `lang` attribute."
      });
    }
  }

  // 2. Non-hidden <img> tags must include an `alt` attribute (WCAG 2.2 SC 1.1.1)
  const imgRe = /<img\b([^>]*)>/gi;
  for (const m of cleaned.matchAll(imgRe)) {
    const attrs = m[1] || "";
    if (/\baria-hidden\s*=\s*(?:"true"|'true')/i.test(attrs)) continue;
    if (/\brole\s*=\s*(?:"presentation"|'presentation'|"none"|'none')/i.test(attrs)) continue;
    if (!/\balt\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i.test(attrs)) {
      const srcMatch = attrs.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
      const src = (srcMatch?.[1] ?? srcMatch?.[2] ?? srcMatch?.[3] ?? "unknown").slice(0, 60);
      issues.push({
        file: filePath,
        type: "wcag",
        rule: "WCAG 1.1.1 (img-alt)",
        severity: "error",
        detail: `\`<img>\` missing \`alt\` attribute (src: \`${src}\`).`
      });
    }
  }

  // 3. Empty <a href="..."></a> or <button></button> without accessible name (WCAG 2.2 SC 2.4.4 / 4.1.2)
  const controlRe = /<(a|button)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  for (const m of cleaned.matchAll(controlRe)) {
    const tag = m[1].toLowerCase();
    const attrs = m[2] || "";
    const inner = m[3] || "";
    if (/\baria-hidden\s*=\s*(?:"true"|'true')/i.test(attrs)) continue;
    if (tag === "a" && !/\bhref\s*=/i.test(attrs)) continue;

    const visibleText = stripTagsToText(inner);
    if (!visibleText && !hasAccessibleAttrOrImgAlt(attrs, inner)) {
      issues.push({
        file: filePath,
        type: "wcag",
        rule: tag === "a" ? "WCAG 2.4.4 (link-name)" : "WCAG 4.1.2 (button-name)",
        severity: "error",
        detail: `Empty \`<${tag}>\` element has no accessible text, \`aria-label\`, or image \`alt\`.`
      });
    }
  }

  return issues;
}

export async function checkFileLinks(
  links,
  {
    sourceFile,
    rootDir = process.cwd(),
    checkExternal = true,
    timeoutMs = 6000,
    fetchImpl = globalThis.fetch,
    urlCache = new Map()
  } = {}
) {
  const broken = [];
  const sourceDir = path.dirname(path.resolve(rootDir, sourceFile));

  for (const { target } of links) {
    const cleanTarget = target.split("#")[0].split("?")[0];
    if (!cleanTarget) continue;

    if (/^https?:\/\//i.test(target)) {
      if (!checkExternal) continue;
      if (!isSafePublicHttpUrl(target)) continue;

      let cached = urlCache.get(target);
      if (!cached) {
        try {
          let res = await fetchImpl(target, {
            method: "HEAD",
            redirect: "manual",
            headers: { "User-Agent": "DynoNode-PR-Guard/1.0 (+https://revenueguard.dynonode.com)" },
            signal: AbortSignal.timeout(timeoutMs)
          });
          if (res.status === 405 || res.status === 403) {
            res = await fetchImpl(target, {
              method: "GET",
              redirect: "manual",
              headers: { "User-Agent": "DynoNode-PR-Guard/1.0 (+https://revenueguard.dynonode.com)" },
              signal: AbortSignal.timeout(timeoutMs)
            });
          }
          const dead = res.status === 404 || res.status === 410 || res.status >= 500;
          cached = { dead, status: res.status };
        } catch (err) {
          cached = { dead: true, status: "ERR_NETWORK", message: err?.message || "timeout" };
        }
        urlCache.set(target, cached);
      }

      if (cached.dead) {
        broken.push({
          file: sourceFile,
          type: "broken_link",
          rule: "Dead HTTP Link",
          severity: "error",
          detail: `\`${target}\` returned \`${cached.status}\`.`
        });
      }
    } else {
      // Local relative or root-relative link check
      const resolved = cleanTarget.startsWith("/")
        ? path.join(rootDir, cleanTarget.slice(1))
        : path.resolve(sourceDir, cleanTarget);
      const existsDirect = fs.existsSync(resolved);
      const existsIndex =
        existsDirect && fs.statSync(resolved).isDirectory()
          ? fs.existsSync(path.join(resolved, "index.html")) || fs.existsSync(path.join(resolved, "README.md"))
          : existsDirect || fs.existsSync(`${resolved}.html`) || fs.existsSync(path.join(resolved, "index.html"));

      if (!existsIndex) {
        broken.push({
          file: sourceFile,
          type: "broken_link",
          rule: "Broken Local Path",
          severity: "error",
          detail: `Relative target \`${target}\` does not resolve on disk.`
        });
      }
    }
  }

  return broken;
}

export async function scanFiles(
  filePaths,
  {
    rootDir = process.cwd(),
    checkExternal = true,
    timeoutMs = 6000,
    fetchImpl = globalThis.fetch
  } = {}
) {
  const urlCache = new Map();
  const findings = [];
  let scannedCount = 0;

  for (const rawFile of filePaths) {
    const absPath = path.resolve(rootDir, rawFile);
    if (!fs.existsSync(absPath) || fs.statSync(absPath).isDirectory()) continue;
    const ext = path.extname(absPath).toLowerCase();
    if (ext !== ".md" && ext !== ".html" && ext !== ".htm") continue;

    scannedCount++;
    const relPath = path.relative(rootDir, absPath).replace(/\\/g, "/");
    const content = fs.readFileSync(absPath, "utf8");

    if (ext === ".html" || ext === ".htm") {
      findings.push(...auditHtmlWcagIssues(content, relPath));
    }

    const links = extractLinksFromContent(content, ext === ".htm" ? ".html" : ext);
    const brokenLinks = await checkFileLinks(links, {
      sourceFile: relPath,
      rootDir,
      checkExternal,
      timeoutMs,
      fetchImpl,
      urlCache
    });
    findings.push(...brokenLinks);
  }

  const brokenLinksCount = findings.filter((f) => f.type === "broken_link").length;
  const wcagIssuesCount = findings.filter((f) => f.type === "wcag").length;

  return {
    scannedCount,
    issuesCount: findings.length,
    brokenLinksCount,
    wcagIssuesCount,
    findings
  };
}

export function formatPrCommentMarkdown(result) {
  const lines = [
    "### 🛡️ DynoNode PR Link & WCAG 2.2 Guard",
    "",
    `**Scanned:** \`${result.scannedCount}\` file(s) · **Broken Links:** \`${result.brokenLinksCount}\` · **WCAG Issues:** \`${result.wcagIssuesCount}\``,
    ""
  ];

  if (result.findings.length === 0) {
    lines.push("✅ **All checked links and WCAG 2.2 Level AA HTML rules passed with zero regressions.**");
  } else {
    lines.push("| File | Check / Rule | Severity | Finding |");
    lines.push("| :--- | :--- | :--- | :--- |");
    for (const f of result.findings) {
      const safeDetail = String(f.detail).replace(/\|/g, "\\|");
      lines.push(`| \`${f.file}\` | ${f.rule} | \`${f.severity.toUpperCase()}\` | ${safeDetail} |`);
    }
  }

  lines.push(
    "",
    "---",
    "<sub>Automated by `@dynonode/pr-guard-action` · Need full 50-page live DOM WCAG 2.2 AA & EAA batch audits? [A11y Sentinel](https://wcag.dynonode.com/) · Need 24/7 HTTP-200 out-of-stock & affiliate link monitoring? [RevenueGuard 404](https://revenueguard.dynonode.com/)</sub>"
  );

  return lines.join("\n") + "\n";
}

function discoverFilesToScan(rootDir, explicitPaths = "") {
  const results = [];
  const collectRecursive = (target) => {
    if (!fs.existsSync(target)) return;
    const st = fs.statSync(target);
    if (st.isDirectory()) {
      for (const ent of fs.readdirSync(target, { withFileTypes: true })) {
        if (["node_modules", ".git", ".next", "dist"].includes(ent.name)) continue;
        collectRecursive(path.join(target, ent.name));
      }
    } else if (/\.(md|html|htm)$/i.test(target)) {
      results.push(path.relative(rootDir, target));
    }
  };

  if (explicitPaths.trim()) {
    for (const part of explicitPaths.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean)) {
      collectRecursive(path.resolve(rootDir, part));
    }
    return [...new Set(results)];
  }

  try {
    const baseSha = process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : "HEAD~1";
    const out = execFileSync("git", ["diff", "--name-only", "--diff-filter=ACMRT", baseSha], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    const diffFiles = out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((f) => /\.(md|html|htm)$/i.test(f) && fs.existsSync(path.resolve(rootDir, f)));
    if (diffFiles.length > 0) return diffFiles;
  } catch {}

  collectRecursive(rootDir);
  return [...new Set(results)];
}

async function runCli() {
  const rootDir = process.env.GITHUB_WORKSPACE || process.cwd();
  const explicitPaths = process.env.INPUT_PATHS || process.argv.slice(2).join(",");
  const checkExternal = (process.env["INPUT_CHECK-EXTERNAL-LINKS"] || "true").toLowerCase() !== "false";
  const timeoutMs = Number(process.env["INPUT_TIMEOUT-MS"] || 6000);
  const failOnIssues = (process.env["INPUT_FAIL-ON-ISSUES"] || "true").toLowerCase() !== "false";

  const files = discoverFilesToScan(rootDir, explicitPaths);
  const result = await scanFiles(files, { rootDir, checkExternal, timeoutMs });
  const markdown = formatPrCommentMarkdown(result);

  process.stdout.write(markdown);

  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown, "utf8");
  }
  if (process.env.GITHUB_OUTPUT) {
    const delim = `EOF_${Date.now()}`;
    const outLines = [
      `issues-count=${result.issuesCount}`,
      `broken-links-count=${result.brokenLinksCount}`,
      `wcag-issues-count=${result.wcagIssuesCount}`,
      `markdown-report<<${delim}`,
      markdown.trimEnd(),
      delim
    ];
    fs.appendFileSync(process.env.GITHUB_OUTPUT, outLines.join("\n") + "\n", "utf8");
  }

  if (failOnIssues && result.issuesCount > 0) {
    process.exitCode = 1;
  }
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  runCli().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
