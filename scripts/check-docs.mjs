#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { parseDocument } from 'yaml';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const packageJson = JSON.parse(
  readFileSync(path.join(projectRoot, 'package.json'), 'utf8'),
);
const markdownPaths = [
  'README.md',
  'AGENTS.md',
  ...readdirSync(path.join(projectRoot, 'docs'))
    .filter((entry) => entry.endsWith('.md'))
    .sort(compareCodeUnits)
    .map((entry) => `docs/${entry}`),
];
const documents = new Map();
const errors = [];
let checkedSnippets = 0;

for (const relativePath of markdownPaths) {
  documents.set(relativePath, parseMarkdown(relativePath));
}

for (const document of documents.values()) {
  validateLinks(document);
}

const packageExports = new Set(
  Object.keys(packageJson.exports).map((entry) =>
    entry === '.' ? packageJson.name : `${packageJson.name}${entry.slice(1)}`,
  ),
);
validateDocumentedExports(
  'docs/architecture.md',
  'Public entry points',
  packageExports,
);

if (errors.length > 0) {
  for (const error of errors) process.stderr.write(`docs: ${error}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `docs: checked ${markdownPaths.length} files and ${checkedSnippets} structured snippets\n`,
  );
}

function parseMarkdown(relativePath) {
  const absolutePath = path.join(projectRoot, relativePath);
  const lines = readFileSync(absolutePath, 'utf8').split('\n');
  const headings = [];
  const anchors = new Set();
  const anchorCounts = new Map();
  const links = [];
  let fence;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (fence !== undefined) {
      if (line.trim() === fence.marker) {
        validateSnippet(relativePath, fence, index + 1);
        fence = undefined;
      } else {
        fence.lines.push(line);
      }
      continue;
    }

    const fenceMatch = /^(`{3,}|~{3,})(.*)$/.exec(line);
    if (fenceMatch !== null) {
      const [language = '', ...flags] = fenceMatch[2].trim().split(/\s+/);
      fence = {
        marker: fenceMatch[1],
        language,
        flags: new Set(flags),
        lines: [],
        startLine: index + 1,
      };
      continue;
    }

    const headingMatch = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (headingMatch !== null) {
      const level = headingMatch[1].length;
      const text = headingMatch[2];
      const baseAnchor = githubAnchor(text);
      const duplicate = anchorCounts.get(baseAnchor) ?? 0;
      anchorCounts.set(baseAnchor, duplicate + 1);
      const anchor =
        duplicate === 0 ? baseAnchor : `${baseAnchor}-${duplicate}`;
      headings.push({ level, text, line: index + 1, anchor });
      anchors.add(anchor);
    }

    for (const match of line.matchAll(
      /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    )) {
      links.push({ href: match[1], line: index + 1 });
    }
  }

  if (fence !== undefined) {
    addError(relativePath, fence.startLine, 'unclosed fenced code block');
  }

  return {
    relativePath,
    lines,
    headings,
    anchors,
    links,
  };
}

function validateSnippet(relativePath, fence, endLine) {
  if (fence.flags.has('fragment')) return;
  const source = `${fence.lines.join('\n')}\n`;
  const language = fence.language.toLowerCase();

  if (language === 'json') {
    checkedSnippets += 1;
    try {
      JSON.parse(source);
    } catch (error) {
      addError(
        relativePath,
        fence.startLine,
        `invalid JSON snippet: ${error.message}`,
      );
    }
    return;
  }

  if (language === 'yaml' || language === 'yml') {
    checkedSnippets += 1;
    const document = parseDocument(source, {
      prettyErrors: false,
      uniqueKeys: true,
    });
    for (const error of document.errors) {
      addError(
        relativePath,
        fence.startLine,
        `invalid YAML snippet: ${error.message}`,
      );
    }
    return;
  }

  if (!['js', 'javascript', 'ts', 'typescript'].includes(language)) return;
  checkedSnippets += 1;
  const isTypeScript = language === 'ts' || language === 'typescript';
  const result = ts.transpileModule(source, {
    fileName: `snippet.${isTypeScript ? 'ts' : 'js'}`,
    reportDiagnostics: true,
    compilerOptions: {
      allowJs: !isTypeScript,
      module: ts.ModuleKind.NodeNext,
      target: ts.ScriptTarget.ES2022,
    },
  });
  for (const diagnostic of result.diagnostics ?? []) {
    if (diagnostic.category !== ts.DiagnosticCategory.Error) continue;
    addError(
      relativePath,
      fence.startLine,
      `invalid ${language} snippet: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`,
    );
  }

  if (fence.flags.has('check')) {
    const execution = spawnSync(process.execPath, ['--input-type=module'], {
      cwd: projectRoot,
      input: source,
      encoding: 'utf8',
    });
    if (execution.status !== 0) {
      const detail = execution.stderr.trim() || execution.stdout.trim();
      addError(
        relativePath,
        fence.startLine,
        `executable snippet failed before line ${endLine}: ${detail}`,
      );
    }
  }
}

function validateLinks(document) {
  for (const { href, line } of document.links) {
    if (href.startsWith('mailto:')) continue;
    if (href.startsWith('http://') || href.startsWith('https://')) {
      validateRepositoryLink(document.relativePath, line, href);
      continue;
    }

    const [pathPart, anchor] = href.split('#', 2);
    const targetPath =
      pathPart === ''
        ? document.relativePath
        : relativeToProject(
            path.resolve(
              projectRoot,
              path.dirname(document.relativePath),
              decodeURIComponent(pathPart),
            ),
          );
    if (
      targetPath === undefined ||
      !existsSync(path.join(projectRoot, targetPath))
    ) {
      addError(
        document.relativePath,
        line,
        `link target does not exist: ${href}`,
      );
      continue;
    }
    if (anchor !== undefined) {
      const targetDocument = documents.get(targetPath);
      if (targetDocument !== undefined && !targetDocument.anchors.has(anchor)) {
        addError(
          document.relativePath,
          line,
          `link anchor does not exist: ${href}`,
        );
      }
    }
    if (isPublished(document.relativePath) && !isPublished(targetPath)) {
      addError(
        document.relativePath,
        line,
        `relative link is unavailable in the published package: ${href}`,
      );
    }
  }
}

function validateRepositoryLink(relativePath, line, href) {
  const match =
    /^https:\/\/github\.com\/stripe\/forge\/(blob|tree)\/main\/([^#?]+)(?:#[^?]+)?$/.exec(
      href,
    );
  if (match === null) return;
  const targetPath = decodeURIComponent(match[2]);
  const absolutePath = path.join(projectRoot, targetPath);
  if (!existsSync(absolutePath)) {
    addError(
      relativePath,
      line,
      `repository link target does not exist: ${href}`,
    );
    return;
  }
  const expectedKind = statSync(absolutePath).isDirectory() ? 'tree' : 'blob';
  if (match[1] !== expectedKind) {
    addError(
      relativePath,
      line,
      `repository link must use ${expectedKind}: ${href}`,
    );
  }
}

function validateDocumentedExports(relativePath, headingText, expected) {
  const document = documents.get(relativePath);
  const headingIndex = document.headings.findIndex(
    ({ text }) => text === headingText,
  );
  if (headingIndex < 0) {
    addError(relativePath, 1, `missing export section: ${headingText}`);
    return;
  }
  const heading = document.headings[headingIndex];
  const nextHeading = document.headings
    .slice(headingIndex + 1)
    .find(({ level }) => level <= heading.level);
  const endLine = nextHeading?.line ?? document.lines.length + 1;
  const section = document.lines.slice(heading.line, endLine - 1).join('\n');
  const actual = new Set(
    [...section.matchAll(/@stripe\/forge(?:\/[A-Za-z0-9._/-]+)?/g)].map(
      (match) => match[0],
    ),
  );
  if (!setsEqual(actual, expected)) {
    addError(
      relativePath,
      heading.line,
      `documented exports differ from package.json; expected ${formatSet(expected)}, found ${formatSet(actual)}`,
    );
  }
}

function isPublished(relativePath) {
  if (relativePath === 'package.json') return true;
  return packageJson.files.some(
    (entry) => relativePath === entry || relativePath.startsWith(`${entry}/`),
  );
}

function relativeToProject(absolutePath) {
  const relativePath = path.relative(projectRoot, absolutePath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath))
    return undefined;
  return relativePath.split(path.sep).join('/');
}

function githubAnchor(text) {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[`*_~]/g, '')
    .replace(/[^\p{L}\p{N}\- _]/gu, '')
    .trim()
    .replace(/\s/g, '-');
}

function setsEqual(left, right) {
  return (
    left.size === right.size && [...left].every((value) => right.has(value))
  );
}

function formatSet(values) {
  return [...values].sort(compareCodeUnits).join(', ');
}

function addError(relativePath, line, message) {
  errors.push(`${relativePath}:${line}: ${message}`);
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
