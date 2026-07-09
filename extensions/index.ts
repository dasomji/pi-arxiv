import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { XMLParser } from "fast-xml-parser";

const ARXIV_API = "https://export.arxiv.org/api/query";
const ARXIV2MD_API = "https://arxiv2md.org/api/markdown";
const USER_AGENT = "@wienerberliner/pi-arxiv/0.1.0 (pi extension)";
const CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-arxiv", "config.json");
const API_DELAY_MS = 3000;

let lastArxivApiRequestAt = 0;

interface Paper {
  id: string;
  title: string;
  authors: string[];
  abstract: string;
  published: string;
  updated: string;
  categories: string[];
  primaryCategory: string;
  pdfUrl: string;
  absUrl: string;
  comment?: string;
  journalRef?: string;
}

interface SearchDetails {
  query: string;
  category?: string;
  totalResults: number;
  returned: number;
  start: number;
  papers: Paper[];
}

interface PaperDetails {
  paper: Paper | null;
}

interface FetchMarkdownDetails {
  id: string;
  sourceUrl: string;
  path?: string;
  saved: boolean;
  saveDirectory?: string;
  bytes: number;
  lines: number;
  truncated: boolean;
}

interface Config {
  saveDirectory?: string;
  updatedAt?: string;
}

interface LibraryCandidate {
  path: string;
  reason: string;
  score: number;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function textValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (isRecord(value)) {
    const text = value["#text"];
    if (typeof text === "string" || typeof text === "number" || typeof text === "boolean") {
      return String(text);
    }
  }
  return "";
}

function attr(record: unknown, name: string): string | undefined {
  if (!isRecord(record)) return undefined;
  const value = record[`@_${name}`];
  return typeof value === "string" ? value : undefined;
}

function parseArxivId(raw: string): string {
  const trimmed = raw.trim().replace(/^@/, "");
  if (!trimmed) throw new Error("Empty arXiv ID.");

  let candidate = trimmed;
  try {
    const url = new URL(trimmed);
    const host = url.hostname.toLowerCase();
    const isKnownHost =
      host === "arxiv.org" ||
      host === "www.arxiv.org" ||
      host === "arxiv2md.org" ||
      host === "www.arxiv2md.org" ||
      host === "ar5iv.org" ||
      host === "www.ar5iv.org" ||
      host === "ar5iv.labs.arxiv.org";
    if (isKnownHost) {
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] === "abs" || parts[0] === "pdf" || parts[0] === "html") {
        candidate = parts.slice(1).join("/");
      }
    }
  } catch {
    // Not a URL; treat as a bare arXiv identifier.
  }

  candidate = decodeURIComponent(candidate).replace(/\.pdf$/i, "");

  const modern = /^\d{4}\.\d{4,5}(?:v\d+)?$/;
  const oldStyle = /^[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?$/i;
  if (!modern.test(candidate) && !oldStyle.test(candidate)) {
    throw new Error(
      `Invalid arXiv ID: ${raw}. Expected e.g. 2401.12345, 2401.12345v2, or hep-th/9901001.`,
    );
  }

  return candidate;
}

function safeFilePart(input: string, fallback: string): string {
  const cleaned = input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._ -]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
  return cleaned || fallback;
}

function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9. -]+/g, "_");
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function displayPath(path: string): string {
  const home = homedir();
  return path === home ? "~" : path.startsWith(home + "/") ? `~/${path.slice(home.length + 1)}` : path;
}

async function readConfig(): Promise<Config> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed)) {
      return {
        saveDirectory: typeof parsed.saveDirectory === "string" ? parsed.saveDirectory : undefined,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined,
      };
    }
  } catch {
    // Missing or malformed config: treat as unconfigured.
  }
  return {};
}

async function writeConfig(config: Config): Promise<void> {
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify({ ...config, updatedAt: new Date().toISOString() }, null, 2) + "\n");
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function addCandidate(candidates: Map<string, LibraryCandidate>, path: string, reason: string, score: number): Promise<void> {
  const absolute = resolve(expandHome(path));
  if (!(await isDirectory(absolute))) return;
  const current = candidates.get(absolute);
  if (!current || score > current.score) {
    candidates.set(absolute, { path: absolute, reason, score });
  }
}

async function searchLibraryDirs(root: string, candidates: Map<string, LibraryCandidate>, maxDepth: number): Promise<void> {
  const targetNames = new Map<string, number>([
    ["papers", 95],
    ["paper", 80],
    ["arxiv", 100],
    ["arxiv papers", 100],
    ["literature", 92],
    ["readings", 86],
    ["reading", 84],
    ["references", 78],
    ["library", 70],
    ["sources", 72],
  ]);
  const skip = new Set([
    ".cache",
    ".config",
    ".git",
    ".local",
    ".npm",
    ".pi",
    "Library",
    "node_modules",
    "Applications",
  ]);

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    const entries = await readdir(dir, { withFileTypes: true, encoding: "utf8" }).catch(() => null);
    if (!entries) return;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (skip.has(entry.name)) continue;
      if (entry.name.startsWith(".") && entry.name !== ".obsidian") continue;

      const full = join(dir, entry.name);
      const lower = entry.name.toLowerCase();
      const score = targetNames.get(lower);
      if (score !== undefined) {
        await addCandidate(candidates, full, `Found directory named ${entry.name}`, score - depth * 4);
      }

      if (entry.name === ".obsidian") {
        await addCandidate(candidates, dir, "Found Obsidian vault", 75 - depth * 4);
        continue;
      }

      await walk(full, depth + 1);
    }
  }

  if (await isDirectory(root)) {
    await walk(root, 0);
  }
}

async function discoverLibraries(): Promise<LibraryCandidate[]> {
  const candidates = new Map<string, LibraryCandidate>();
  const home = homedir();

  const common = [
    [join(home, "Documents", "Arxiv"), "Common arXiv papers folder", 110] as const,
    [join(home, "Documents", "Papers"), "Common papers folder", 105] as const,
    [join(home, "Documents", "Research"), "Common research folder", 90] as const,
    [join(home, "Papers"), "Common papers folder", 104] as const,
    [join(home, "Research"), "Common research folder", 90] as const,
    [join(home, "arxiv"), "Existing arXiv folder", 100] as const,
    [join(home, "Dropbox", "Papers"), "Dropbox papers folder", 94] as const,
    [join(home, "Obsidian"), "Obsidian root", 80] as const,
  ];

  for (const [path, reason, score] of common) {
    await addCandidate(candidates, path, reason, score);
  }

  const roots = [home, join(home, "Documents"), join(home, "Dropbox"), join(home, "Obsidian")];
  for (const root of roots) {
    await searchLibraryDirs(root, candidates, root === home ? 2 : 3);
  }

  return [...candidates.values()].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, 10);
}

function recommendedLibraryPath(candidates: LibraryCandidate[]): string {
  return candidates[0]?.path ?? join(homedir(), "Documents", "Arxiv");
}

async function configureLibrary(ctx: ExtensionContext, forcePrompt: boolean): Promise<string> {
  const envPath = process.env.PI_ARXIV_LIBRARY;
  if (!forcePrompt && envPath) {
    const expanded = resolve(expandHome(envPath));
    await mkdir(expanded, { recursive: true });
    return expanded;
  }

  const config = await readConfig();
  if (!forcePrompt && config.saveDirectory) {
    const expanded = resolve(expandHome(config.saveDirectory));
    await mkdir(expanded, { recursive: true });
    return expanded;
  }

  const candidates = await discoverLibraries();
  const recommendation = recommendedLibraryPath(candidates);

  if (!ctx.hasUI) {
    await mkdir(recommendation, { recursive: true });
    await writeConfig({ saveDirectory: recommendation });
    return recommendation;
  }

  const labels = new Map<string, string | "custom">();
  for (const candidate of candidates) {
    const label = `Use ${displayPath(candidate.path)} — ${candidate.reason}`;
    labels.set(label, candidate.path);
  }

  if (candidates.length === 0) {
    const label = `Use recommended folder ${displayPath(recommendation)}`;
    labels.set(label, recommendation);
  } else {
    const label = `Use recommended new folder ${displayPath(join(homedir(), "Documents", "Arxiv"))}`;
    labels.set(label, join(homedir(), "Documents", "Arxiv"));
  }
  labels.set("Choose a custom folder…", "custom");

  const choice = await ctx.ui.select("Where should pi-arxiv save fetched Markdown papers?", [...labels.keys()]);
  const selected = choice ? labels.get(choice) : recommendation;

  let saveDirectory: string;
  if (selected === "custom") {
    const input = await ctx.ui.input("Folder for fetched arXiv Markdown files", displayPath(recommendation));
    saveDirectory = resolve(expandHome(input?.trim() || recommendation));
  } else {
    saveDirectory = resolve(expandHome(selected ?? recommendation));
  }

  await mkdir(saveDirectory, { recursive: true });
  await writeConfig({ saveDirectory });
  ctx.ui.notify(`pi-arxiv will save Markdown papers to ${displayPath(saveDirectory)}`, "info");
  return saveDirectory;
}

async function rateLimitArxivApi(): Promise<void> {
  const now = Date.now();
  const waitMs = Math.max(0, lastArxivApiRequestAt + API_DELAY_MS - now);
  if (waitMs > 0) {
    await new Promise((resolveWait) => setTimeout(resolveWait, waitMs));
  }
  lastArxivApiRequestAt = Date.now();
}

async function fetchText(url: URL, signal?: AbortSignal): Promise<string> {
  const response = await fetch(url, {
    signal,
    headers: { "user-agent": USER_AGENT },
  });
  if (!response.ok) {
    throw new Error(`Request failed: HTTP ${response.status} ${response.statusText} for ${url.toString()}`);
  }
  return response.text();
}

async function fetchArxivApi(params: URLSearchParams, signal?: AbortSignal): Promise<string> {
  await rateLimitArxivApi();
  const url = new URL(ARXIV_API);
  url.search = params.toString();
  return fetchText(url, signal);
}

function parseEntry(entry: unknown): Paper {
  if (!isRecord(entry)) throw new Error("Invalid arXiv API entry.");
  const links = asArray(entry.link).filter(isRecord);
  const pdfLink = links.find((link) => attr(link, "type") === "application/pdf");
  const absLink = links.find((link) => attr(link, "rel") === "alternate");

  const rawId = textValue(entry.id);
  const id = rawId.replace(/^https?:\/\/arxiv\.org\/abs\//, "").replace(/^https?:\/\/export\.arxiv\.org\/abs\//, "");

  const authors = asArray(entry.author)
    .map((author) => (isRecord(author) ? textValue(author.name) : ""))
    .filter((author) => author.length > 0);

  const categories = asArray(entry.category)
    .map((category) => attr(category, "term") ?? "")
    .filter((category) => category.length > 0);

  const title = textValue(entry.title).replace(/\s+/g, " ").trim();
  const abstract = textValue(entry.summary).replace(/\s+/g, " ").trim();
  const primaryCategoryValue = entry["arxiv:primary_category"];

  return {
    id,
    title,
    authors,
    abstract,
    published: textValue(entry.published),
    updated: textValue(entry.updated),
    categories,
    primaryCategory: attr(primaryCategoryValue, "term") ?? categories[0] ?? "",
    pdfUrl: attr(pdfLink, "href") ?? `https://arxiv.org/pdf/${id}`,
    absUrl: attr(absLink, "href") ?? `https://arxiv.org/abs/${id}`,
    comment: textValue(entry["arxiv:comment"]) || undefined,
    journalRef: textValue(entry["arxiv:journal_ref"]) || undefined,
  };
}

function parseFeed(xml: string): { papers: Paper[]; totalResults: number } {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
  const parsed: unknown = parser.parse(xml);
  if (!isRecord(parsed) || !isRecord(parsed.feed)) throw new Error("Invalid arXiv API response.");
  const feed = parsed.feed;
  const totalResults = Number.parseInt(textValue(feed["opensearch:totalResults"]), 10) || 0;
  const papers = asArray(feed.entry).map(parseEntry);
  return { papers, totalResults };
}

function buildSearchQuery(query: string, category?: string): string {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) throw new Error("Search query is required.");
  const base = `all:${trimmedQuery}`;
  return category?.trim() ? `cat:${category.trim()} AND ${base}` : base;
}

async function searchPapers(params: {
  query: string;
  category?: string;
  maxResults?: number;
  sortBy?: "relevance" | "lastUpdatedDate" | "submittedDate";
  sortOrder?: "ascending" | "descending";
  start?: number;
}, signal?: AbortSignal): Promise<{ papers: Paper[]; totalResults: number; start: number }> {
  const maxResults = Math.max(1, Math.min(Math.floor(params.maxResults ?? 10), 50));
  const start = Math.max(0, Math.floor(params.start ?? 0));
  const query = buildSearchQuery(params.query, params.category);
  const urlParams = new URLSearchParams({
    search_query: query,
    start: String(start),
    max_results: String(maxResults),
    sortBy: params.sortBy ?? "relevance",
    sortOrder: params.sortOrder ?? "descending",
  });
  const xml = await fetchArxivApi(urlParams, signal);
  const { papers, totalResults } = parseFeed(xml);
  return { papers, totalResults, start };
}

async function lookupPaper(rawId: string, signal?: AbortSignal): Promise<Paper | null> {
  const id = parseArxivId(rawId);
  const urlParams = new URLSearchParams({ id_list: id });
  const xml = await fetchArxivApi(urlParams, signal);
  const { papers } = parseFeed(xml);
  const paper = papers[0];
  return paper && paper.title ? paper : null;
}

function formatPaper(paper: Paper, index?: number): string {
  const prefix = index === undefined ? "" : `[${index + 1}] `;
  const lines = [
    `${prefix}${paper.title}`,
    `    ID: ${paper.id}`,
    `    Authors: ${paper.authors.join(", ") || "Unknown"}`,
    `    Published: ${paper.published.slice(0, 10) || "Unknown"}  Updated: ${paper.updated.slice(0, 10) || "Unknown"}`,
    `    Categories: ${paper.categories.join(", ") || "Unknown"}`,
    `    PDF: ${paper.pdfUrl}`,
    `    Abstract: ${paper.abstract}`,
  ];
  if (paper.comment) lines.splice(6, 0, `    Comment: ${paper.comment}`);
  if (paper.journalRef) lines.splice(6, 0, `    Journal: ${paper.journalRef}`);
  return lines.join("\n");
}

function truncateForTool(text: string): { text: string; truncated: boolean } {
  const truncation = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  let output = truncation.content;
  if (truncation.truncated) {
    output += `\n\n[Output truncated: ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}]`;
  }
  return { text: output, truncated: truncation.truncated };
}

async function fetchMarkdownFromArxiv2md(id: string, params: {
  removeRefs?: boolean;
  removeToc?: boolean;
  removeCitations?: boolean;
  frontmatter?: boolean;
}, signal?: AbortSignal): Promise<{ markdown: string; sourceUrl: string }> {
  const url = new URL(ARXIV2MD_API);
  url.searchParams.set("url", id);
  url.searchParams.set("remove_refs", String(params.removeRefs ?? true));
  url.searchParams.set("remove_toc", String(params.removeToc ?? true));
  url.searchParams.set("remove_citations", String(params.removeCitations ?? true));
  url.searchParams.set("frontmatter", String(params.frontmatter ?? true));
  return { markdown: await fetchText(url, signal), sourceUrl: url.toString() };
}

async function uniquePath(path: string): Promise<string> {
  if (!existsSync(path)) return path;
  const dotIndex = basename(path).lastIndexOf(".");
  const stem = dotIndex > 0 ? path.slice(0, -basename(path).length + dotIndex) : path;
  const ext = dotIndex > 0 ? basename(path).slice(dotIndex) : "";
  for (let i = 2; i < 1000; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not find an available filename near ${path}`);
}

async function saveMarkdown(id: string, title: string | undefined, markdown: string, directory: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  const name = `${safeId(id)} - ${safeFilePart(title ?? "", "paper")}.md`;
  const path = await uniquePath(join(directory, name));
  await writeFile(path, markdown, "utf8");
  return path;
}

function renderPaperSummary(paper: Paper): string {
  let text = `${paper.title}\n${paper.id} · ${paper.published.slice(0, 10)}`;
  if (paper.authors.length > 0) {
    text += `\n${paper.authors.join(", ")}`;
  }
  return text;
}

export default function piArxiv(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    const config = await readConfig();
    if (!config.saveDirectory && ctx.hasUI) {
      ctx.ui.setStatus("pi-arxiv", "arXiv library not configured (/arxiv-library)");
    } else if (config.saveDirectory && ctx.hasUI) {
      ctx.ui.setStatus("pi-arxiv", `arXiv → ${displayPath(resolve(expandHome(config.saveDirectory)))}`);
    }
  });

  pi.registerCommand("arxiv-library", {
    description: "Choose where pi-arxiv saves fetched Markdown papers",
    handler: async (_args, ctx) => {
      const path = await configureLibrary(ctx, true);
      ctx.ui.setStatus("pi-arxiv", `arXiv → ${displayPath(path)}`);
    },
  });

  pi.registerTool({
    name: "arxiv_search",
    label: "arXiv Search",
    description:
      "Search arXiv papers by query, optional category, sorting, and pagination. Returns titles, authors, abstracts, dates, categories, and links.",
    promptSnippet: "Search arXiv papers by query/category and return metadata with abstracts and links",
    promptGuidelines: [
      "Use arxiv_search when the user asks to find papers, recent papers, related work, or papers in an arXiv category.",
      "Use arxiv_fetch2md after arxiv_search when the user wants the full body of a specific paper as Markdown.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query, e.g. 'diffusion policies robotics'" }),
      category: Type.Optional(Type.String({ description: "Optional arXiv category filter, e.g. cs.RO, cs.LG, cs.CV, stat.ML" })),
      max_results: Type.Optional(Type.Number({ description: "Max papers to return (default 10, max 50)", default: 10 })),
      sort_by: Type.Optional(
        StringEnum(["relevance", "lastUpdatedDate", "submittedDate"] as const, { description: "Sort order (default relevance)" }),
      ),
      sort_order: Type.Optional(
        StringEnum(["ascending", "descending"] as const, { description: "Sort direction (default descending)" }),
      ),
      start: Type.Optional(Type.Number({ description: "Start index for pagination (default 0)", default: 0 })),
    }),
    async execute(_toolCallId, params, signal) {
      const { papers, totalResults, start } = await searchPapers(
        {
          query: params.query,
          category: params.category,
          maxResults: params.max_results,
          sortBy: params.sort_by,
          sortOrder: params.sort_order,
          start: params.start,
        },
        signal,
      );

      if (papers.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No papers found for query: ${params.query}` }],
          details: { query: params.query, category: params.category, totalResults: 0, returned: 0, start, papers } satisfies SearchDetails,
        };
      }

      const body = papers.map((paper, index) => formatPaper(paper, index)).join("\n\n");
      const { text } = truncateForTool(`Found ${totalResults} papers (showing ${start + 1}-${start + papers.length}):\n\n${body}`);
      return {
        content: [{ type: "text" as const, text }],
        details: { query: params.query, category: params.category, totalResults, returned: papers.length, start, papers } satisfies SearchDetails,
      };
    },
    renderCall(args, theme) {
      let text = `${theme.bold("arxiv_search")} ${theme.fg("accent", `\"${String(args.query ?? "")}\"`)}`;
      if (args.category) text += theme.fg("muted", ` cat:${String(args.category)}`);
      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as SearchDetails | undefined;
      if (!details || details.returned === 0) return new Text(theme.fg("dim", "No papers found"), 0, 0);
      let text = theme.fg("success", `${details.totalResults} results`) + theme.fg("dim", ` (showing ${details.returned})`);
      if (expanded) {
        for (const paper of details.papers) {
          text += "\n\n" + theme.fg("accent", theme.bold(paper.title));
          text += "\n" + theme.fg("dim", `${paper.id} · ${paper.published.slice(0, 10)} · ${paper.authors.slice(0, 3).join(", ")}${paper.authors.length > 3 ? " et al." : ""}`);
        }
      }
      return new Text(text, 0, 0);
    },
  });

  pi.registerTool({
    name: "arxiv_paper",
    label: "arXiv Paper",
    description: "Fetch exact metadata for one arXiv paper by ID or URL. Returns title, authors, abstract, dates, categories, and links.",
    promptSnippet: "Look up exact metadata for one arXiv paper by ID or URL",
    promptGuidelines: ["Use arxiv_paper when the user gives a specific arXiv ID/URL and wants metadata or abstract."],
    parameters: Type.Object({
      id: Type.String({ description: "arXiv ID or URL, e.g. 2401.12345v2 or https://arxiv.org/abs/2401.12345" }),
    }),
    async execute(_toolCallId, params, signal) {
      const paper = await lookupPaper(params.id, signal);
      if (!paper) {
        return {
          content: [{ type: "text" as const, text: `Paper not found: ${params.id}` }],
          details: { paper: null } as PaperDetails,
        };
      }
      return {
        content: [{ type: "text" as const, text: formatPaper(paper) }],
        details: { paper } as PaperDetails,
      };
    },
    renderCall(args, theme) {
      return new Text(`${theme.bold("arxiv_paper")} ${theme.fg("accent", String(args.id ?? ""))}`, 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as PaperDetails | undefined;
      if (!details?.paper) return new Text(theme.fg("error", "Paper not found"), 0, 0);
      let text = theme.fg("accent", theme.bold(details.paper.title));
      text += "\n" + theme.fg("dim", `${details.paper.id} · ${details.paper.published.slice(0, 10)}`);
      if (expanded) text += "\n\n" + details.paper.abstract;
      return new Text(text, 0, 0);
    },
  });

  pi.registerTool({
    name: "arxiv_fetch2md",
    label: "arXiv Fetch Markdown",
    description:
      "Fetch the full body of an arXiv paper as Markdown using arxiv2md. Saves the Markdown to the configured paper library unless save=false.",
    promptSnippet: "Fetch a specific arXiv paper body as Markdown through arxiv2md and save it to the paper library",
    promptGuidelines: [
      "Use arxiv_fetch2md when the user asks to read, analyze, summarize, or quote the full body of a specific arXiv paper.",
      "Use arxiv_fetch2md instead of scraping PDFs; it uses arxiv2md's HTML-to-Markdown pipeline when available.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "arXiv ID or URL, e.g. 2501.11120v1 or https://arxiv.org/abs/2501.11120v1" }),
      save: Type.Optional(Type.Boolean({ description: "Whether to save the Markdown file (default true)", default: true })),
      save_directory: Type.Optional(Type.String({ description: "Override folder for this fetch. If omitted, pi-arxiv uses/configures the library folder." })),
      remove_refs: Type.Optional(Type.Boolean({ description: "Ask arxiv2md to remove references (default true)", default: true })),
      remove_toc: Type.Optional(Type.Boolean({ description: "Ask arxiv2md to remove table of contents (default true)", default: true })),
      remove_citations: Type.Optional(Type.Boolean({ description: "Ask arxiv2md to remove inline citations/internal links (default true)", default: true })),
      frontmatter: Type.Optional(Type.Boolean({ description: "Ask arxiv2md to include YAML frontmatter (default true)", default: true })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const id = parseArxivId(params.id);
      const paper = await lookupPaper(id, signal).catch(() => null);
      const { markdown, sourceUrl } = await fetchMarkdownFromArxiv2md(
        id,
        {
          removeRefs: params.remove_refs,
          removeToc: params.remove_toc,
          removeCitations: params.remove_citations,
          frontmatter: params.frontmatter,
        },
        signal,
      );

      const save = params.save ?? true;
      let outputPath: string | undefined;
      let saveDirectory: string | undefined;
      if (save) {
        saveDirectory = params.save_directory ? resolve(expandHome(params.save_directory)) : await configureLibrary(ctx, false);
        outputPath = await saveMarkdown(id, paper?.title, markdown, saveDirectory);
      }

      const lineCount = markdown.split("\n").length;
      const bytes = Buffer.byteLength(markdown);
      const { text, truncated } = truncateForTool(
        `${paper ? `# ${renderPaperSummary(paper)}\n\n` : ""}${outputPath ? `Saved Markdown to: ${outputPath}\nSource: ${sourceUrl}\n\n` : `Source: ${sourceUrl}\n\n`}${markdown}`,
      );

      return {
        content: [{ type: "text" as const, text }],
        details: {
          id,
          sourceUrl,
          path: outputPath,
          saved: Boolean(outputPath),
          saveDirectory,
          bytes,
          lines: lineCount,
          truncated,
        } satisfies FetchMarkdownDetails,
      };
    },
    renderCall(args, theme) {
      return new Text(`${theme.bold("arxiv_fetch2md")} ${theme.fg("accent", String(args.id ?? ""))}`, 0, 0);
    },
    renderResult(result, { expanded }, theme, context) {
      const details = result.details as FetchMarkdownDetails | undefined;
      if (context.isError) {
        const message = result.content.find((block) => block.type === "text")?.text ?? "Fetch failed";
        return new Text(theme.fg("error", message), 0, 0);
      }
      if (!details) return new Text("", 0, 0);
      let text = theme.fg("success", `Fetched ${details.id} as Markdown`);
      text += theme.fg("dim", ` (${details.lines} lines, ${formatSize(details.bytes)})`);
      if (details.path) text += "\n" + theme.fg("muted", `Saved: ${details.path}`);
      if (expanded) {
        const markdown = result.content.find((block) => block.type === "text")?.text;
        if (markdown) text += "\n\n" + theme.fg("toolOutput", markdown);
      }
      return new Text(text, 0, 0);
    },
  });
}
