import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditHtmlWcagIssues,
  extractLinksFromContent,
  formatPrCommentMarkdown,
  isSafePublicHttpUrl,
  scanFiles
} from "../src/index.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");

test("1. WCAG HTML auditor catches missing html lang, missing img alt, and empty links/buttons", () => {
  const brokenHtml = `<!DOCTYPE html>
<html>
<body>
  <img src="/hero.png">
  <a href="/pricing"></a>
  <button type="button">   </button>
</body>
</html>`;

  const issues = auditHtmlWcagIssues(brokenHtml, "public/bad.html");
  const rules = issues.map((i) => i.rule);
  assert.ok(rules.some((r) => r.includes("html-has-lang")), "Expected html-has-lang error");
  assert.ok(rules.some((r) => r.includes("img-alt")), "Expected img-alt error");
  assert.ok(rules.some((r) => r.includes("link-name")), "Expected link-name error");
  assert.ok(rules.some((r) => r.includes("button-name")), "Expected button-name error");
});

test("2. Accessible HTML with lang, alt, and aria-label passes with zero WCAG issues", () => {
  const cleanHtml = `<!DOCTYPE html>
<html lang="en">
<body>
  <img src="/logo.svg" alt="DynoNode Logo" />
  <img src="/spacer.gif" alt="" role="presentation" />
  <a href="/docs" aria-label="Read documentation"><svg></svg></a>
  <button type="button">Run Audit</button>
</body>
</html>`;

  const issues = auditHtmlWcagIssues(cleanHtml, "public/clean.html");
  assert.equal(issues.length, 0);
});

test("3. Link extractor & SSRF-safe scanner detect dead 404 HTTP links and missing local files", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-guard-test-"));
  try {
    fs.writeFileSync(path.join(tmpDir, "exists.md"), "# Valid Target\n", "utf8");
    fs.writeFileSync(
      path.join(tmpDir, "guide.md"),
      [
        "# PR Test Guide",
        "- [Good Local](./exists.md)",
        "- [Missing Local](./missing-page.md)",
        "- [Good Remote](https://dynonode.com/docs)",
        "- [Dead Remote](https://example.com/404-dead-route)"
      ].join("\n"),
      "utf8"
    );

    const mockFetch = async (url) => {
      const s = String(url);
      if (s.includes("404-dead-route")) return new Response("Not Found", { status: 404 });
      return new Response("OK", { status: 200 });
    };

    const links = extractLinksFromContent(fs.readFileSync(path.join(tmpDir, "guide.md"), "utf8"), ".md");
    assert.equal(links.length, 4);

    assert.equal(isSafePublicHttpUrl("http://127.0.0.1:8787/api/health"), false);
    assert.equal(isSafePublicHttpUrl("http://169.254.169.254/latest/meta-data"), false);
    assert.equal(isSafePublicHttpUrl("https://supalaunch.dynonode.com/"), true);

    const scanResult = await scanFiles(["guide.md"], {
      rootDir: tmpDir,
      checkExternal: true,
      fetchImpl: mockFetch
    });

    assert.equal(scanResult.scannedCount, 1);
    assert.equal(scanResult.brokenLinksCount, 2);
    assert.equal(scanResult.wcagIssuesCount, 0);

    const mdReport = formatPrCommentMarkdown(scanResult);
    assert.match(mdReport, /\| `guide\.md` \| Broken Local Path \|/);
    assert.match(mdReport, /\| `guide\.md` \| Dead HTTP Link \|/);
    assert.match(mdReport, /https:\/\/wcag\.dynonode\.com\//);
    assert.match(mdReport, /https:\/\/revenueguard\.dynonode\.com\//);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("4. GitHub Marketplace manifest (action.yml), package.json & strict zero-forbidden-word compliance", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "package.json"), "utf8"));
  assert.equal(pkg.name, "@dynonode/pr-guard-action");
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.dependencies, undefined, "Action must have zero runtime dependencies");

  const actionYml = fs.readFileSync(path.join(ROOT_DIR, "action.yml"), "utf8");
  assert.match(actionYml, /using:\s*"node20"/);
  assert.match(actionYml, /main:\s*"src\/index\.mjs"/);

  const forbidden = [
    "mol" + "lie",
    "dynono" + "des",
    "node" + "works",
    "node" + "drive",
    "8878" + "5816",
    "onbe" + "perkt",
    "unlim" + "ited"
  ];

  function scan(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === "node_modules") continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) scan(full);
      else {
        const txt = fs.readFileSync(full, "utf8").toLowerCase();
        for (const w of forbidden) {
          assert.equal(txt.includes(w), false, `Forbidden term ${w} in ${full}`);
        }
      }
    }
  }
  scan(ROOT_DIR);
});
