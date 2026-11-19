const fs = require("fs");
const path = require("path");

// src/ is split into role modules (see src/Code.js, which re-exports
// them for tests). Apps Script runs a single file, so the build
// concatenates the modules in this order — the order they appeared
// in the original single-file Code.js, so top-level statements run
// in the same sequence — and strips the ESM import/export syntax.
const MODULES = [
  "publicActions.js",
  "auth.js",
  "snsCounts.js",
  "threadsDetail.js",
  "xDetail.js",
  "xReactions.js",
  "threadsAuth.js",
  "instagramDetail.js",
  "instagramDaily.js",
  "diagnostics.js",
  "instagramMedia.js",
  "mediaDuration.js",
  "mediaDurationDebug.js",
  "youtubeDetail.js",
  "historyWrite.js",
  "blogHistory.js",
  "snsHistoryRead.js",
  "sheetRead.js",
  "collect.js",
  "ga4.js",
  "comments.js",
  "commentsRss.js",
  "perfRss.js",
  "main.js",
];

const build = ({
  rootDir = process.cwd(),
  fsModule = fs,
  pathModule = path,
} = {}) => {
  const appsscriptPath = pathModule.join(rootDir, "appsscript.json");
  const distDir = pathModule.join(rootDir, "dist");
  const distPath = pathModule.join(distDir, "Code.gs");
  const distManifestPath = pathModule.join(distDir, "appsscript.json");

  fsModule.mkdirSync(distDir, { recursive: true });
  const compiled = MODULES.map((name) => {
    const source = fsModule.readFileSync(
      pathModule.join(rootDir, "src", name),
      "utf8"
    );
    return source
      .replace(/^import\s[^\n]*\n/gm, "")
      .replace(/^export\s*\{[^}]*\};?[ \t]*\n/gm, "")
      .replace(/^export\s+/gm, "");
  }).join("");
  fsModule.writeFileSync(distPath, compiled);
  fsModule.copyFileSync(appsscriptPath, distManifestPath);
};

const runIfMain = ({ main = require.main, current = module, buildFn = build } = {}) => {
  if (main === current) {
    buildFn();
    return true;
  }
  return false;
};

runIfMain();

module.exports = { build, runIfMain };
