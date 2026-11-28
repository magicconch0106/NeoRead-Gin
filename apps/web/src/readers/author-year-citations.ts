import type { PDFBlock, PDFLocation } from "@neoread/core";

export interface AuthorYearReference {
  index: number;
  text: string;
  label: string;
}

export interface ParsedAuthorYearQuery {
  authors: string[];
  etAl: boolean;
  year: string;
  display: string;
}

export interface ResolvedBibliographyEntry {
  block: PDFBlock;
  page: number;
  location: PDFLocation;
  bounds: PDFBlock["bounds"];
  entryText: string;
  title: string;
}

const NON_AUTHOR_WORDS = new Set([
  // Months & seasons
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
  "jan",
  "feb",
  "mar",
  "apr",
  "jun",
  "jul",
  "aug",
  "sep",
  "sept",
  "oct",
  "nov",
  "dec",
  "spring",
  "summer",
  "autumn",
  "fall",
  "winter",
  // Prepositions, conjunctions & time words
  "in",
  "on",
  "at",
  "by",
  "to",
  "of",
  "as",
  "or",
  "if",
  "we",
  "it",
  "he",
  "no",
  "before",
  "after",
  "since",
  "until",
  "during",
  "between",
  "from",
  "around",
  "circa",
  "early",
  "late",
  "mid",
  "year",
  "years",
  "decade",
  "decades",
  "century",
  "wave",
  "phase",
  "stage",
  "round",
  "period",
  "cohort",
  "plan",
  "reform",
  "policy",
  "policies",
  "survey",
  "census",
  "sample",
  "data",
  "dataset",
  "panel",
  "panels",
  // Structural document nouns
  "figure",
  "figures",
  "fig",
  "figs",
  "table",
  "tables",
  "section",
  "sections",
  "appendix",
  "appendices",
  "chapter",
  "chapters",
  "part",
  "parts",
  "model",
  "models",
  "column",
  "columns",
  "row",
  "rows",
  "proposition",
  "theorem",
  "lemma",
  "corollary",
  "hypothesis",
  "assumption",
  "definition",
  "equation",
  "eq",
  "example",
  "note",
  "notes",
  "source",
  "sources",
  "rule",
  "law",
  "act",
  "article",
  "volume",
  "vol",
  "issue",
  "version",
  "edition",
  "page",
  "pages",
  // Common places, acronyms & institutions followed by years
  "china",
  "beijing",
  "shanghai",
  "us",
  "usa",
  "uk",
  "eu",
  "un",
  "nber",
  "cepr",
  "imf",
  "wto",
  "oecd",
  "world",
  "bank",
  "national",
  "ministry",
  "province",
  "provinces",
  "county",
  "counties",
  "city",
  "cities",
  "gdp",
  "ols",
  "fe",
  "iv",
]);

const YEAR_TOKEN = String.raw`(?:18\d{2}|19\d{2}|20[0-3]\d)[a-d]?`;
const LATIN_UPPER = String.raw`[A-Z\u00C0-\u00D6\u00D8-\u00DE\u0100-\u017F]`;
const LATIN_LOWER = String.raw`[a-z\u00DF-\u00F6\u00F8-\u024F]`;
const SURNAME_PART = String.raw`(?:(?:van|von|de|del|della|di|du|la|le|st\.?|d'|o')\s*)?${LATIN_UPPER}(?:${LATIN_UPPER}?${LATIN_LOWER}|[\p{M}'’-]){1,24}(?:-${LATIN_UPPER}(?:${LATIN_UPPER}?${LATIN_LOWER}|[\p{M}'’-]){1,24})?`;
const AUTHOR_GROUP = String.raw`${SURNAME_PART}(?:(?:\s*[,、]\s*${SURNAME_PART}){0,2}\s*(?:[,]?\s*(?:and|&)\s+|[,、]?\s*[和与及]\s*)${SURNAME_PART})?(?:\s+et\s+al\.?|\s*等(?:人)?)?`;

const NARRATIVE_PATTERN = new RegExp(
  String.raw`(?<![\p{Script=Latin}\d])(${AUTHOR_GROUP})\s*([(\uff08])\s*(${YEAR_TOKEN}(?:\s*[,，;；]\s*(?:${YEAR_TOKEN}|[a-d]))*)\s*([)\uff09])`,
  "gu",
);

const PAREN_BLOCK_PATTERN = /[(\uff08]([^()\uff08\uff09]{4,240})[)\uff09]/gu;

const LEADING_QUALIFIER =
  /^(?:see\s*,?\s*e\.g\.\s*,?|e\.g\.\s*,?|i\.e\.\s*,?|cf\.\s*,?|see\s+also\s+|see\s+|for\s+example\s*,?|for\s+instance\s*,?|inter\s+alia\s*,?|among\s+others\s*,?|following\s+|citing\s+|quoted\s+in\s+|reproduced\s+from\s+|例如\s*[，,]?|参见\s*|详见\s*|见\s*|如\s*|又见\s*|参考\s*)+/iu;

const PAREN_ITEM_PATTERN = new RegExp(
  String.raw`^(${AUTHOR_GROUP})\s*[,，]?\s*(${YEAR_TOKEN}(?:\s*[,，]\s*(?:${YEAR_TOKEN}|[a-d]))*)(?:\s*[,，:]\s*(?:p{1,2}\.?\s*\d+(?:[–-]\d+)?|ch(?:ap)?\.?\s*\d+|sec\.?\s*\d+|第\s*\d+\s*页))?\s*$`,
  "u",
);

const LEADING_DISCOURSE_ADVERBS = new Set([
  "interestingly",
  "specifically",
  "similarly",
  "relatedly",
  "notably",
  "importantly",
  "moreover",
  "furthermore",
  "however",
  "nevertheless",
  "nonetheless",
  "meanwhile",
  "consequently",
  "accordingly",
  "alternatively",
  "conversely",
  "empirically",
  "theoretically",
  "historically",
  "traditionally",
  "recently",
  "first",
  "second",
  "third",
  "fourth",
  "finally",
  "lastly",
  "overall",
  "indeed",
  "following",
  "unlike",
]);

function trimLeadingDiscourseWords(rawAuthors: string): {
  authors: string;
  trimmedChars: number;
} {
  let current = rawAuthors;
  let trimmedChars = 0;
  while (true) {
    const m = /^([A-Za-z]+)\s*[,、]\s+/.exec(current);
    if (!m) break;
    if (!LEADING_DISCOURSE_ADVERBS.has(m[1].toLowerCase())) break;
    trimmedChars += m[0].length;
    current = current.slice(m[0].length);
  }
  return { authors: current, trimmedChars };
}

function stripAccents(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/[’']/g, "'")
    .toLowerCase();
}

function extractSurnamesAndEtAl(rawAuthors: string): {
  surnames: string[];
  etAl: boolean;
} | null {
  let cleaned = rawAuthors.trim();
  let etAl = false;
  if (/(?:\s+et\s+al\.?|\s*等(?:人)?)$/iu.test(cleaned)) {
    etAl = true;
    cleaned = cleaned.replace(/(?:\s+et\s+al\.?|\s*等(?:人)?)$/iu, "").trim();
  }
  const parts = cleaned
    .split(/\s*(?:,\s*and\s+|,\s*&\s+|\s+and\s+|\s*&\s*|[、,]\s*[和与及]\s*|\s*[和与及]\s*|[,、])\s*/iu)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length || parts.length > 4) return null;
  const surnames: string[] = [];
  for (const part of parts) {
    if (!/^[\p{Lu}dDoO]/u.test(part)) return null;
    const norm = stripAccents(part.replace(/\./g, "")).trim();
    const headWord = norm.split(/[\s-]+/)[0];
    if (
      norm.length < 2 ||
      NON_AUTHOR_WORDS.has(norm) ||
      NON_AUTHOR_WORDS.has(headWord)
    ) {
      return null;
    }
    // disallow ALL-CAPS acronyms of 2-5 letters like "NBER", "OECD", "DID"
    if (/^[A-Z]{2,6}$/.test(part)) return null;
    surnames.push(part.replace(/\s+/g, " "));
  }
  if (parts.length > 3) etAl = true;
  return { surnames: surnames.slice(0, 3), etAl };
}

export function formatAuthorYearLabel(
  surnames: string[],
  etAl: boolean,
  year: string,
): string {
  return `cite:${surnames.join("|")}${etAl ? "*" : ""}@${year.toLowerCase()}`;
}

export function parseAuthorYearLabel(
  label: string,
): ParsedAuthorYearQuery | undefined {
  if (!label.startsWith("cite:")) return undefined;
  const body = label.slice(5);
  const at = body.lastIndexOf("@");
  if (at <= 0) return undefined;
  let authorPart = body.slice(0, at);
  const year = body.slice(at + 1).trim().toLowerCase();
  const etAl = authorPart.endsWith("*");
  if (etAl) authorPart = authorPart.slice(0, -1);
  const authors = authorPart
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!authors.length || !year) return undefined;
  const authorDisplay = etAl
    ? `${authors[0]} et al.`
    : authors.length === 1
      ? authors[0]
      : authors.length === 2
        ? `${authors[0]} & ${authors[1]}`
        : `${authors.slice(0, -1).join(", ")} & ${authors[authors.length - 1]}`;
  return {
    authors,
    etAl,
    year,
    display: `${authorDisplay} (${year})`,
  };
}

function expandYearTokens(
  rawYears: string,
  baseOffset: number,
): { year: string; start: number; end: number }[] {
  const results: { year: string; start: number; end: number }[] = [];
  let lastFourDigit = "";
  const tokenRegex = new RegExp(`(${YEAR_TOKEN}|[a-d])`, "g");
  for (const m of rawYears.matchAll(tokenRegex)) {
    const token = m[1];
    const start = baseOffset + (m.index ?? 0);
    const end = start + token.length;
    if (token.length === 1 && lastFourDigit) {
      results.push({ year: `${lastFourDigit}${token}`, start, end });
    } else if (token.length >= 4) {
      lastFourDigit = token.slice(0, 4);
      results.push({ year: token, start, end });
    }
  }
  return results;
}

/**
 * Extracts non-overlapping economics/social-science `(Author, Year)` citations
 * from English or Chinese text while ignoring dates, months, and section labels.
 */
export function authorYearReferences(text: string): AuthorYearReference[] {
  if (!/\d{4}/.test(text)) return [];
  const refs: AuthorYearReference[] = [];

  for (const match of text.matchAll(NARRATIVE_PATTERN)) {
    const rawMatchIndex = match.index ?? 0;
    const { authors: rawAuthors, trimmedChars } = trimLeadingDiscourseWords(
      match[1],
    );
    const fullIndex = rawMatchIndex + trimmedChars;
    const fullText = match[0].slice(trimmedChars);
    const rawYears = match[3];
    const parsed = extractSurnamesAndEtAl(rawAuthors);
    if (!parsed) continue;
    const yearsStartInMatch = fullText.indexOf(rawYears, rawAuthors.length);
    const years = expandYearTokens(rawYears, fullIndex + yearsStartInMatch);
    if (!years.length) continue;
    if (years.length === 1) {
      refs.push({
        index: fullIndex,
        text: fullText,
        label: formatAuthorYearLabel(
          parsed.surnames,
          parsed.etAl,
          years[0].year,
        ),
      });
    } else {
      for (const y of years) {
        refs.push({
          index: y.start,
          text: text.slice(y.start, y.end),
          label: formatAuthorYearLabel(parsed.surnames, parsed.etAl, y.year),
        });
      }
    }
  }

  const overlapsExisting = (start: number, end: number) =>
    refs.some((r) => Math.min(r.index + r.text.length, end) > Math.max(r.index, start));

  for (const paren of text.matchAll(PAREN_BLOCK_PATTERN)) {
    const contentStart = (paren.index ?? 0) + 1;
    const content = paren[1];
    if (!/\d{4}/.test(content)) continue;
    let cursor = 0;
    for (const seg of content.split(/([;；])/)) {
      if (seg === ";" || seg === "；") {
        cursor += seg.length;
        continue;
      }
      const segStart = contentStart + cursor;
      cursor += seg.length;

      const leadWs = /^\s*/.exec(seg)?.[0].length ?? 0;
      const afterWs = seg.slice(leadWs);
      const qualMatch = LEADING_QUALIFIER.exec(afterWs);
      const qualLen = qualMatch ? qualMatch[0].length : 0;
      const afterQual = afterWs.slice(qualLen);
      const innerWs = /^\s*/.exec(afterQual)?.[0].length ?? 0;
      const body = afterQual.slice(innerWs);
      const bodyStart = segStart + leadWs + qualLen + innerWs;

      const itemMatch = PAREN_ITEM_PATTERN.exec(body);
      if (!itemMatch) continue;
      const rawAuthors = itemMatch[1];
      const rawYears = itemMatch[2];
      const parsed = extractSurnamesAndEtAl(rawAuthors);
      if (!parsed) continue;

      const yearsOffset = body.indexOf(rawYears, rawAuthors.length);
      const years = expandYearTokens(rawYears, bodyStart + yearsOffset);
      if (!years.length) continue;

      if (years.length === 1) {
        const trimmed = body.trimEnd();
        const itemEnd = bodyStart + trimmed.length;
        if (!overlapsExisting(bodyStart, itemEnd)) {
          refs.push({
            index: bodyStart,
            text: text.slice(bodyStart, itemEnd),
            label: formatAuthorYearLabel(
              parsed.surnames,
              parsed.etAl,
              years[0].year,
            ),
          });
        }
      } else {
        // First span covers "Author YYYY", subsequent spans cover additional years "YYYYb".
        const firstEnd = years[0].end;
        if (!overlapsExisting(bodyStart, firstEnd)) {
          refs.push({
            index: bodyStart,
            text: text.slice(bodyStart, firstEnd),
            label: formatAuthorYearLabel(
              parsed.surnames,
              parsed.etAl,
              years[0].year,
            ),
          });
        }
        for (const y of years.slice(1)) {
          if (!overlapsExisting(y.start, y.end)) {
            refs.push({
              index: y.start,
              text: text.slice(y.start, y.end),
              label: formatAuthorYearLabel(
                parsed.surnames,
                parsed.etAl,
                y.year,
              ),
            });
          }
        }
      }
    }
  }

  return refs.sort((a, b) => a.index - b.index);
}

interface ParsedBibItem {
  block: PDFBlock;
  startOffset: number;
  endOffset: number;
  authorsHeader: string;
  firstSurnameNorm: string;
  headerNorm: string;
  year: string;
  entryText: string;
}

function collectBibliographyBlocks(blocks: PDFBlock[]): PDFBlock[] {
  const labeled = blocks.filter(
    (b) =>
      ["reference", "reference_content"].includes(b.label) && b.text.trim(),
  );
  if (labeled.length) return labeled;
  const headingIdx = blocks.findIndex(
    (b) =>
      ["paragraph_title", "doc_title", "text"].includes(b.label) &&
      /^(?:references|bibliography|literature\s+cited|works\s+cited|参考文献)\s*$/iu.test(
        b.text.trim(),
      ),
  );
  if (headingIdx < 0) return [];
  const result: PDFBlock[] = [];
  for (let i = headingIdx + 1; i < blocks.length; i++) {
    const b = blocks[i];
    if (
      b.label === "paragraph_title" &&
      /^(?:appendix|appendices|table|figure|附录)\b/iu.test(b.text.trim())
    ) {
      break;
    }
    if (b.text.trim() && !["header", "footer", "number"].includes(b.label)) {
      result.push(b);
    }
  }
  return result;
}

const ENTRY_ANCHOR_PATTERN = new RegExp(
  String.raw`(?:^|(?<=[.?!;”"'\)\]])\s+)(?:([—–_-]{2,}\.?|\.)\s*(${YEAR_TOKEN})(?=[.:\s)\]])|([\p{Lu}][^0-9?!\n]{1,260}?(?:[.,]\s*|\s+[(\uff08]))(${YEAR_TOKEN})(?=[.):\uff09\s,;]))`,
  "gu",
);

function trimPrecedingSentenceTail(rawHeader: string): {
  header: string;
  trimmedChars: number;
} {
  // Split after non-initial sentence endings like "University of Chicago Press. " or "China.” "
  const boundary =
    /(?:\.”|”\.|"\.|[?!;]|(?<!\b(?:[\p{Lu}]|Jr|Sr|St|Dr|et\s+al))\.)\s+(?=[\p{Lu}])/gu;
  let cutIndex = 0;
  for (const m of rawHeader.matchAll(boundary)) {
    cutIndex = (m.index ?? 0) + m[0].length;
  }
  return {
    header: rawHeader.slice(cutIndex),
    trimmedChars: cutIndex,
  };
}

function firstSurnameFromHeader(header: string): string {
  const cleaned = header
    .trim()
    .replace(/^(?:[\[\d.\]]+\s*)/, "");
  const commaIdx = cleaned.indexOf(",");
  if (commaIdx > 0 && commaIdx < 32) {
    return stripAccents(cleaned.slice(0, commaIdx).trim());
  }
  const tokens = cleaned.split(/\s+/);
  if (
    tokens.length >= 2 &&
    /^(?:van|von|de|del|della|di|du|la|le|st\.?)$/i.test(tokens[0])
  ) {
    return stripAccents(`${tokens[0]} ${tokens[1]}`);
  }
  return stripAccents(tokens[0] ?? "");
}

function parseBibliographyEntries(blocks: PDFBlock[]): ParsedBibItem[] {
  const bibBlocks = collectBibliographyBlocks(blocks);
  if (!bibBlocks.length) return [];
  const entries: ParsedBibItem[] = [];
  let lastAuthorsHeader = "";
  let danglingAuthorPrefix: { block: PDFBlock; text: string } | undefined;

  for (const block of bibBlocks) {
    const raw = block.text.replace(/\s+/g, " ").trim();
    if (!raw) continue;

    // Only merge a dangling author prefix on the same page when the next block doesn't start a fresh "Surname, Firstname" entry.
    const startsFreshAuthor = /^[\p{Lu}][\p{Ll}\p{M}'’-]+,\s+[\p{Lu}]/u.test(
      raw,
    );
    const canJoinPrefix =
      danglingAuthorPrefix &&
      danglingAuthorPrefix.block.page === block.page &&
      !startsFreshAuthor &&
      new RegExp(`^.{0,180}\\b${YEAR_TOKEN}\\b`).test(raw);
    const combined = canJoinPrefix
      ? `${danglingAuthorPrefix!.text} ${raw}`
      : raw;
    const prefixLen = canJoinPrefix ? danglingAuthorPrefix!.text.length + 1 : 0;
    const anchorBlock = canJoinPrefix ? danglingAuthorPrefix!.block : block;
    danglingAuthorPrefix = undefined;

    const matches = Array.from(combined.matchAll(ENTRY_ANCHOR_PATTERN));
    if (!matches.length) {
      if (
        /^[\p{Lu}][\p{Ll}\p{M}'’-]+,\s+[\p{Lu}]/u.test(raw) &&
        raw.length < 220 &&
        !/\d{4}/.test(raw)
      ) {
        danglingAuthorPrefix = { block, text: raw };
        entries.push({
          block,
          startOffset: 0,
          endOffset: raw.length,
          authorsHeader: raw,
          firstSurnameNorm: firstSurnameFromHeader(raw),
          headerNorm: stripAccents(raw),
          year: "*",
          entryText: raw,
        });
      }
      continue;
    }

    const rawStarts: number[] = matches.map((m) => {
      const baseIdx = m.index ?? 0;
      if (m[1]) return baseIdx;
      const groupOffset = m[0].indexOf(m[3]);
      const { trimmedChars } = trimPrecedingSentenceTail(m[3]);
      return baseIdx + Math.max(0, groupOffset) + trimmedChars;
    });

    for (let i = 0; i < matches.length; i++) {
      const m = matches[i];
      const startInCombined = rawStarts[i];
      const endInCombined =
        i + 1 < matches.length ? rawStarts[i + 1] : combined.length;
      const repeatedRule = m[1];
      const year = (m[2] ?? m[4] ?? "").toLowerCase();
      const rawAuthorGroup = m[3] ? trimPrecedingSentenceTail(m[3]).header : "";
      let authorsHeader = rawAuthorGroup.trim().replace(/[.,(\uff08]\s*$/, "");

      if (repeatedRule) {
        if (!lastAuthorsHeader) continue;
        authorsHeader = lastAuthorsHeader;
      } else if (authorsHeader) {
        lastAuthorsHeader = authorsHeader;
      }
      if (!authorsHeader || !year) continue;

      let snippet = combined.slice(startInCombined, endInCombined).trim();
      if (repeatedRule) {
        snippet = snippet.replace(
          /^(?:[—–_-]{2,}\.?|\.)\s*/,
          `${authorsHeader}. `,
        );
      }
      if (snippet.length > 420) {
        snippet = `${snippet.slice(0, 417).trimEnd()}…`;
      }

      const targetBlock = startInCombined < prefixLen ? anchorBlock : block;
      const localStart =
        startInCombined < prefixLen
          ? 0
          : Math.max(0, startInCombined - prefixLen);
      const localEnd =
        startInCombined < prefixLen
          ? anchorBlock.text.length
          : Math.min(raw.length, endInCombined - prefixLen);

      entries.push({
        block: targetBlock,
        startOffset: localStart,
        endOffset: Math.max(localStart + 20, localEnd),
        authorsHeader,
        firstSurnameNorm: firstSurnameFromHeader(authorsHeader),
        headerNorm: stripAccents(authorsHeader),
        year,
        entryText: snippet,
      });
    }
  }
  return entries;
}

function containsWord(haystackNorm: string, surnameNorm: string): boolean {
  const escaped = surnameNorm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z])${escaped}(?:$|[^a-z])`).test(haystackNorm);
}

/**
 * Resolves a `cite:Author@Year` label against parsed PDF bibliography blocks.
 */
export function resolveAuthorYearReference(
  blocks: PDFBlock[],
  label: string,
): ResolvedBibliographyEntry | undefined {
  const query = parseAuthorYearLabel(label);
  if (!query) return undefined;
  const entries = parseBibliographyEntries(blocks);
  if (!entries.length) return undefined;

  const firstQueryNorm = stripAccents(query.authors[0]);
  const baseQueryYear = query.year.slice(0, 4);

  let best: { entry: ParsedBibItem; score: number } | undefined;
  for (const entry of entries) {
    const entryBaseYear = entry.year.slice(0, 4);
    let yearScore = 0;
    if (entry.year === query.year) {
      yearScore = 120;
    } else if (query.year.length === 4 && entryBaseYear === baseQueryYear) {
      yearScore = 80;
    } else if (entry.year.length === 4 && entry.year === baseQueryYear) {
      yearScore = 70;
    } else if (entry.year === "*") {
      yearScore = 40;
    } else {
      continue;
    }

    const firstMatches =
      entry.firstSurnameNorm === firstQueryNorm ||
      entry.firstSurnameNorm.endsWith(` ${firstQueryNorm}`) ||
      entry.headerNorm.startsWith(`${firstQueryNorm},`) ||
      entry.headerNorm.startsWith(`${firstQueryNorm} `);
    if (!firstMatches) continue;

    let score = 200 + yearScore;
    for (const coAuthor of query.authors.slice(1)) {
      const coNorm = stripAccents(coAuthor);
      if (containsWord(entry.headerNorm, coNorm)) {
        score += 60;
      } else {
        score -= 90;
      }
    }

    const headerHasMulti =
      /\band\b|&|\bet\s+al\b|,.*,/.test(entry.headerNorm);
    if (query.authors.length === 1 && !query.etAl && !headerHasMulti) {
      score += 25;
    } else if (query.etAl && headerHasMulti) {
      score += 25;
    }

    if (!best || score > best.score) {
      best = { entry, score };
    }
  }

  if (!best || best.score < 220) return undefined;
  const { entry } = best;
  const totalLen = Math.max(1, entry.block.text.replace(/\s+/g, " ").trim().length);
  const startFrac = Math.max(0, Math.min(0.92, entry.startOffset / totalLen));
  const spanFrac = Math.max(
    0.08,
    Math.min(0.28, (entry.endOffset - entry.startOffset) / totalLen + 0.05),
  );
  const yTop = Math.max(
    0,
    entry.block.bounds.y + entry.block.bounds.height * startFrac - 0.012,
  );
  const height = Math.min(
    1 - yTop,
    Math.max(0.075, entry.block.bounds.height * spanFrac + 0.024),
  );
  const xLeft = Math.max(0, entry.block.bounds.x - 0.012);
  const width = Math.min(1 - xLeft, entry.block.bounds.width + 0.024);

  return {
    block: entry.block,
    page: entry.block.page,
    location: {
      type: "pdf",
      page: entry.block.page,
      x: entry.block.bounds.x,
      y: Math.min(0.96, entry.block.bounds.y + entry.block.bounds.height * startFrac),
    },
    bounds: {
      x: xLeft,
      y: yTop,
      width,
      height,
    },
    entryText: entry.entryText,
    title: `${query.display} · 第 ${entry.block.page} 页`,
  };
}
