import { api, publicationURL } from "@neoread/api";
import type {
  Creator,
  Document,
  PDFBlock,
  PaperItemType,
  PaperMetadata,
  PaperMetadataField,
  Processing,
} from "@neoread/core";

export interface ExtractedFrontMatter {
  title?: string;
  creators?: Creator[];
  date?: string;
  itemType?: PaperItemType;
  venue?: string;
  affiliation?: string;
  abstract?: string;
  doi?: string;
  arxiv?: string;
}

const HAN = /\p{Script=Han}/u;

const MONTHS: Record<string, string> = {
  january: "01",
  jan: "01",
  february: "02",
  feb: "02",
  march: "03",
  mar: "03",
  april: "04",
  apr: "04",
  may: "05",
  june: "06",
  jun: "06",
  july: "07",
  jul: "07",
  august: "08",
  aug: "08",
  september: "09",
  sep: "09",
  sept: "09",
  october: "10",
  oct: "10",
  november: "11",
  nov: "11",
  december: "12",
  dec: "12",
};

const NAME_PARTICLES = new Set([
  "van",
  "von",
  "de",
  "del",
  "della",
  "di",
  "du",
  "la",
  "le",
  "st",
  "st.",
  "der",
  "den",
  "ten",
  "ter",
]);

const NAME_SUFFIXES = new Set(["jr", "jr.", "sr", "sr.", "ii", "iii", "iv"]);

const NON_PERSON_WORDS = new Set([
  "university",
  "college",
  "school",
  "department",
  "institute",
  "institution",
  "academy",
  "center",
  "centre",
  "laboratory",
  "faculty",
  "business",
  "economics",
  "management",
  "finance",
  "political",
  "science",
  "sciences",
  "digital",
  "national",
  "bureau",
  "research",
  "working",
  "paper",
  "series",
  "discussion",
  "preprint",
  "preliminary",
  "incomplete",
  "draft",
  "version",
  "abstract",
  "introduction",
  "keywords",
  "classification",
  "jel",
  "corresponding",
  "author",
  "authors",
  "information",
  "affiliation",
  "address",
  "mailing",
  "email",
  "telephone",
  "phone",
  "financial",
  "support",
  "acknowledgments",
  "acknowledgements",
  "published",
  "online",
  "articles",
  "advance",
  "journal",
  "review",
  "quarterly",
  "american",
  "china",
  "beijing",
  "shanghai",
  "nanjing",
  "suzhou",
  "chicago",
  "harvard",
  "stanford",
  "princeton",
  "mit",
  "nber",
  "cepr",
  "ssrn",
  "iza",
  "bread",
  "cifar",
  ...Object.keys(MONTHS),
]);

const BAD_PDF_AUTHORS = new Set([
  "administrator",
  "admin",
  "user",
  "owner",
  "author",
  "unknown",
  "untitled",
  "microsoft",
  "microsoft office user",
  "windows user",
  "macbook",
  "latex",
  "pdftex",
  "arxiv",
]);

const PREPRINT_VENUE_RE =
  /\b(?:working\s+paper|discussion\s+paper|staff\s+paper|research\s+paper\s+series|nber|ssrn|cepr|iza|arxiv|openreview|biorxiv|medrxiv|socarxiv|chemrxiv|techrxiv|osf\s+preprints|preprint|unpublished\s+manuscript|job\s+market\s+paper)\b|预印本|工作论文|讨论稿|未刊稿/i;

const PREPRINT_DOI_RE =
  /^10\.(?:3386|2139\/ssrn|48550\/arxiv|1101|31235|31219|26434|21203)\b/i;

export function isPreprintVenueOrDOI(venue?: string, doi?: string): boolean {
  if (doi && PREPRINT_DOI_RE.test(doi.trim())) return true;
  if (venue && PREPRINT_VENUE_RE.test(venue.trim())) return true;
  return false;
}

function stripFootnoteSymbols(raw: string): string {
  return raw
    .replace(/[\u2020\u2021\u00a7\u00b6\u2217*∗†‡§¶⊕⊗]+/gu, " ")
    .replace(/(?<=[A-Za-z\p{Script=Han}])\s*(?:\d+(?:\s*,\s*\d+)*)(?=\s|$|[,;，；])/gu, "")
    .replace(/\b(?:ORCID|https?:\/\/orcid\.org\/\S+)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isInitialToken(token: string): boolean {
  return /^(?:[A-Z]\.|[A-Z]-[A-Z]\.?|[A-Z]{1,2}-[A-Z])$/.test(token);
}

function isCapitalizedNameToken(token: string): boolean {
  if (isInitialToken(token)) return true;
  if (!/^[A-Z\u00C0-\u017F][A-Za-z\u00C0-\u024F'’-]{1,24}$/.test(token))
    return false;
  if (/^[A-Z]{3,}$/.test(token)) return false;
  return !NON_PERSON_WORDS.has(token.toLowerCase().replace(/\.$/, ""));
}

function singleNameToCreator(raw: string): Creator | null {
  const cleaned = stripFootnoteSymbols(raw)
    .replace(/^[,;，；:：.\s]+|[,;，；:：.\s]+$/g, "")
    .trim();
  if (!cleaned || cleaned.length > 80) return null;
  if (/@|https?:\/\//i.test(cleaned)) return null;

  const comma = /^([^,，]+)[,，]\s*(.+)$/.exec(cleaned);
  if (comma) {
    const family = comma[1].trim();
    const given = comma[2].trim();
    if (!family || !given) return null;
    if (
      NON_PERSON_WORDS.has(family.toLowerCase()) ||
      NON_PERSON_WORDS.has(given.split(/\s+/)[0].toLowerCase())
    ) {
      return null;
    }
    return { family, given };
  }

  if (HAN.test(cleaned)) {
    const compact = cleaned.replace(/\s+/g, "");
    if (compact.length < 2 || compact.length > 10) return null;
    if (/大学|学院|研究|经济|管理|中心|基金|作者|通讯|邮箱|地址/.test(compact))
      return null;
    return { name: compact };
  }

  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    return /^[A-Z\u00C0-\u017F][a-z\u00DF-\u024F]{1,24}$/.test(parts[0]) &&
      !NON_PERSON_WORDS.has(parts[0].toLowerCase())
      ? { name: parts[0] }
      : null;
  }
  if (parts.length > 5) return null;
  for (const p of parts) {
    const lower = p.toLowerCase().replace(/\.$/, "");
    if (NAME_PARTICLES.has(lower) || NAME_SUFFIXES.has(lower)) continue;
    if (!isCapitalizedNameToken(p)) return null;
  }

  // Keep suffix like "Jr." with family or handle "Van Reenen"
  let end = parts.length - 1;
  let suffix = "";
  if (end >= 2 && NAME_SUFFIXES.has(parts[end].toLowerCase())) {
    suffix = ` ${parts[end]}`;
    end--;
  }
  let familyStart = end;
  while (
    familyStart > 1 &&
    NAME_PARTICLES.has(parts[familyStart - 1].toLowerCase())
  ) {
    familyStart--;
  }
  const given = parts.slice(0, familyStart).join(" ");
  const family = parts.slice(familyStart, end + 1).join(" ") + suffix;
  if (!given || !family) return null;
  return { given, family };
}

/**
 * Splits a space-separated LaTeX `\and` author line like
 * `"Kaicheng Luo Shaoda Wang David Y. Yang *"` into individual creators.
 */
function splitSpaceSeparatedLatinAuthors(
  cleaned: string,
  footnoteSurnames?: Set<string>,
): Creator[] | null {
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  if (tokens.length < 2 || tokens.length > 24) return null;
  if (
    !tokens.every((t) => {
      const lower = t.toLowerCase().replace(/\.$/, "");
      return (
        NAME_PARTICLES.has(lower) ||
        NAME_SUFFIXES.has(lower) ||
        isCapitalizedNameToken(t)
      );
    })
  ) {
    return null;
  }

  // Strategy 1: Exact surname boundaries from page-1 `* Surname: University` footnote.
  if (footnoteSurnames && footnoteSurnames.size >= 2) {
    const segments: string[][] = [];
    let current: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      current.push(tok);
      const normTok = tok.toLowerCase().replace(/\.$/, "");
      if (footnoteSurnames.has(normTok) && current.length >= 2) {
        segments.push(current);
        current = [];
      }
    }
    if (current.length === 0 && segments.length >= 2) {
      const built = segments
        .map((seg) => singleNameToCreator(seg.join(" ")))
        .filter((c): c is Creator => c !== null);
      if (built.length === segments.length) return built;
    }
  }

  // Strategy 2: Group middle initials (`Y.`) and particles (`van`, `de`) with adjacent tokens,
  // then pair `[Given (+ Initials)] [Family]` when there are >= 4 name units (`2k` units).
  const units: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const lower = tok.toLowerCase().replace(/\.$/, "");
    if (isInitialToken(tok) && units.length > 0 && i + 1 < tokens.length) {
      // Attach middle initial to the preceding given name ("David" + "Y." -> "David Y.")
      units[units.length - 1] = `${units[units.length - 1]} ${tok}`;
    } else if (NAME_PARTICLES.has(lower) && i + 1 < tokens.length) {
      tokens[i + 1] = `${tok} ${tokens[i + 1]}`;
    } else if (NAME_SUFFIXES.has(lower) && units.length > 0) {
      units[units.length - 1] = `${units[units.length - 1]} ${tok}`;
    } else {
      units.push(tok);
    }
  }

  if (units.length >= 4 && units.length % 2 === 0 && units.length <= 12) {
    const creators: Creator[] = [];
    for (let i = 0; i < units.length; i += 2) {
      const c = singleNameToCreator(`${units[i]} ${units[i + 1]}`);
      if (!c) return null;
      creators.push(c);
    }
    return creators;
  }

  const single = singleNameToCreator(cleaned);
  return single ? [single] : null;
}

/**
 * Parses single or multi-author strings across working papers, preprints,
 * and manual paste formats (`;`, `；`, `,`, `and`, `&`, `\n`, or LaTeX `\and` spaces).
 */
export function splitAuthorStringToCreators(
  rawText: string,
  footnoteSurnames?: Set<string>,
): Creator[] {
  const strippedPrefix = rawText
    .trim()
    .replace(/^(?:author\s+information|authors?|names?|by|作者|姓名)\s*[:：]\s*/i, "");
  if (!strippedPrefix) return [];

  const lines = strippedPrefix
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);

  const out: Creator[] = [];
  for (const line of lines) {
    const cleanedLine = stripFootnoteSymbols(line)
      .replace(/;\s*,/g, ";")
      .replace(/,\s*;/g, ";")
      .trim();
    if (!cleanedLine) continue;

    // Explicit multi-author delimiters: `;`, `；`, `、`, ` and `, ` & `
    if (/[;；、]|\s+(?:and|&)\s+|\s*[和与]\s*/i.test(cleanedLine)) {
      const chunks = cleanedLine
        .split(/\s*(?:,\s*and\s+|,\s*&\s+|[;；、]|\s+and\s+|\s*&\s*)\s*/i)
        .flatMap((part) => {
          // Inside each chunk, check if comma-separated list of "Given Family, Given Family"
          const commaParts = part.split(/\s*[,，]\s*/).filter(Boolean);
          if (commaParts.length >= 3) return commaParts;
          if (
            commaParts.length === 2 &&
            /\s/.test(commaParts[0]) &&
            /\s/.test(commaParts[1])
          ) {
            return commaParts;
          }
          return [part];
        });
      for (const chunk of chunks) {
        const c =
          splitSpaceSeparatedLatinAuthors(chunk, footnoteSurnames) ??
          (singleNameToCreator(chunk) ? [singleNameToCreator(chunk)!] : []);
        out.push(...c);
      }
      continue;
    }

    // Comma-only check: distinguish single `"Vaswani, Ashish"` from `"Huixin Wang, Jing Fang, ..."`
    const commaParts = cleanedLine.split(/\s*[,，]\s*/).filter(Boolean);
    if (
      commaParts.length >= 3 ||
      (commaParts.length === 2 &&
        ((/\s/.test(commaParts[0]) && /\s/.test(commaParts[1])) ||
          (HAN.test(commaParts[0]) && HAN.test(commaParts[1]))))
    ) {
      for (const part of commaParts) {
        const c = singleNameToCreator(part);
        if (c) out.push(c);
      }
      continue;
    }

    // Chinese space-separated names (`"任保平  钞小静"`)
    if (HAN.test(cleanedLine) && /\s/.test(cleanedLine)) {
      const hanParts = cleanedLine.split(/\s+/).filter(Boolean);
      if (
        hanParts.length >= 2 &&
        hanParts.every((p) => HAN.test(p) && p.length >= 2 && p.length <= 5)
      ) {
        for (const p of hanParts) {
          const c = singleNameToCreator(p);
          if (c) out.push(c);
        }
        continue;
      }
    }

    // Space-separated Latin multi-author line (`"Shaoda Wang David Y. Yang"`) or single author
    const spaceAuthors = splitSpaceSeparatedLatinAuthors(
      cleanedLine,
      footnoteSurnames,
    );
    if (spaceAuthors?.length) {
      out.push(...spaceAuthors);
      continue;
    }

    const single = singleNameToCreator(cleanedLine);
    if (single) out.push(single);
  }
  return out;
}

/**
 * Detects whether an existing `creators` array was accidentally saved as a
 * single mangled multi-author blob (e.g. semicolon-joined or 2 full names in 1 struct).
 */
export function isMangledCreators(creators?: Creator[]): boolean {
  if (!creators?.length) return false;
  return creators.some((c) => {
    const full = [c.given, c.family, c.name].filter(Boolean).join(" ");
    if (/[;；、]/.test(full)) return true;
    if (c.given && c.family) {
      const givenWords = c.given
        .trim()
        .split(/\s+/)
        .filter((w) => !isInitialToken(w) && !NAME_PARTICLES.has(w.toLowerCase()));
      const familyWords = c.family
        .trim()
        .split(/\s+/)
        .filter(
          (w) =>
            !isInitialToken(w) &&
            !NAME_PARTICLES.has(w.toLowerCase()) &&
            !NAME_SUFFIXES.has(w.toLowerCase()),
        );
      // e.g. given="David Yang", family="Shaoda Wang" (2 non-particle family words!)
      if (givenWords.length >= 2 && familyWords.length >= 2) return true;
    }
    return false;
  });
}

function extractFootnoteSurnames(blocks: PDFBlock[]): {
  surnames: Set<string>;
  affiliations: string[];
} {
  const surnames = new Set<string>();
  const affiliations: string[] = [];
  for (const b of blocks) {
    if (b.page > 2 || !b.text.trim()) continue;
    if (
      b.label === "footnote" ||
      /^\s*[*∗†‡]/.test(b.text) ||
      /@[a-z0-9.-]+\.[a-z]{2,}/i.test(b.text)
    ) {
      // Match patterns like `. Wang: University of Chicago and NBER;` or `Luo: MIT;`
      const regex =
        /(?:^|[.*∗†‡;]\s*)([A-Z\u00C0-\u017F][A-Za-z\u00C0-\u024F'’-]{1,22})\s*:\s*([^;.\n]{4,120})/g;
      for (const m of b.text.matchAll(regex)) {
        const surname = m[1].trim().toLowerCase();
        const aff = m[2].trim();
        if (
          !NON_PERSON_WORDS.has(surname) &&
          /\b(?:university|college|school|institute|department|nber|cepr|harvard|mit|stanford|chicago|princeton|yale|berkeley|columbia|wharton|informs|academy|bank|fed)\b|大学|学院|研究院/i.test(
            aff,
          )
        ) {
          surnames.add(surname);
          affiliations.push(
            aff
              .replace(/\s+and\s+[A-Z0-9-]+$/, "")
              .replace(/[,;:\s]+$/, "")
              .trim(),
          );
        }
      }
    }
  }
  return { surnames, affiliations };
}

function parseFlexibleDate(
  text: string,
  allowStandalone: boolean,
): { date: string; priority: number } | null {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  if (/\b(?:accessed|retrieved|visited|downloaded)\b/i.test(cleaned)) {
    return null;
  }

  // Check for explicit "This version / Current version / Revised" first!
  const thisVersion =
    /(?:this\s+version|current\s+version|present\s+version|revised(?:\s+version)?|updated|本版本|修订日期)\s*[:：]?\s*([^;.\n]{4,40})/i.exec(
      cleaned,
    );
  if (thisVersion) {
    const inner = parseSingleDatePhrase(thisVersion[1]);
    if (inner) return { date: inner, priority: 100 };
  }

  if (!allowStandalone) return null;

  // Standalone short date block on cover page (e.g. "February 24, 2025", "November 2026", "2025年2月24日")
  if (cleaned.length <= 64) {
    const direct = parseSingleDatePhrase(cleaned);
    if (direct) return { date: direct, priority: 90 };
  }

  // Published / Posted / Working paper date stamp
  const stamped =
    /(?:published\s+online[^0-9A-Za-z]{0,24}|posted[^0-9A-Za-z]{0,16}|date\s*[:：]\s*|working\s+paper[^0-9\n]{0,30})([A-Za-z]+\.?\s+\d{1,2},\s*\d{4}|\d{1,2}\s+[A-Za-z]+\.?\s+\d{4}|[A-Za-z]+\.?\s+\d{4}|\d{4}-\d{2}(?:-\d{2})?)/i.exec(
      cleaned,
    );
  if (stamped) {
    const inner = parseSingleDatePhrase(stamped[1]);
    if (inner) return { date: inner, priority: 80 };
  }

  return null;
}

function validYear(year: number): boolean {
  const maxYear = new Date().getFullYear() + 1;
  return year >= 1950 && year <= maxYear;
}

function parseSingleDatePhrase(phrase: string): string | null {
  const s = phrase.trim();

  // 1. ISO YYYY-MM-DD or YYYY-MM
  const iso = /\b((?:19|20)\d{2})-(0[1-9]|1[0-2])(?:-([0-2]\d|3[01]))?\b/.exec(s);
  if (iso && validYear(Number(iso[1]))) {
    return iso[3] ? `${iso[1]}-${iso[2]}-${iso[3]}` : `${iso[1]}-${iso[2]}`;
  }

  // 2. Chinese YYYY年M月D日 or YYYY年M月
  const zh = /((?:19|20)\d{2})\s*年\s*(\d{1,2})\s*月(?:\s*(\d{1,2})\s*日)?/.exec(s);
  if (zh && validYear(Number(zh[1]))) {
    const m = Number(zh[2]);
    const d = zh[3] ? Number(zh[3]) : 0;
    if (m >= 1 && m <= 12) {
      const mm = String(m).padStart(2, "0");
      return d >= 1 && d <= 31
        ? `${zh[1]}-${mm}-${String(d).padStart(2, "0")}`
        : `${zh[1]}-${mm}`;
    }
  }

  // 3. "Month DD, YYYY" (e.g. "February 24, 2025")
  const mdy =
    /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s*,\s*((?:19|20)\d{2})\b/.exec(
      s,
    );
  if (mdy) {
    const mm = MONTHS[mdy[1].toLowerCase()];
    const day = Number(mdy[2]);
    const yr = Number(mdy[3]);
    if (mm && day >= 1 && day <= 31 && validYear(yr)) {
      return `${yr}-${mm}-${String(day).padStart(2, "0")}`;
    }
  }

  // 4. "DD Month YYYY" (e.g. "26 May 2025")
  const dmy = /\b(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+((?:19|20)\d{2})\b/.exec(s);
  if (dmy) {
    const mm = MONTHS[dmy[2].toLowerCase()];
    const day = Number(dmy[1]);
    const yr = Number(dmy[3]);
    if (mm && day >= 1 && day <= 31 && validYear(yr)) {
      return `${yr}-${mm}-${String(day).padStart(2, "0")}`;
    }
  }

  // 5. "Month YYYY" (e.g. "November 2026", "Feb. 2025")
  const my = /\b([A-Za-z]{3,9})\.?,?\s+((?:19|20)\d{2})\b/.exec(s);
  if (my) {
    const mm = MONTHS[my[1].toLowerCase()];
    const yr = Number(my[2]);
    if (mm && validYear(yr)) {
      return `${yr}-${mm}`;
    }
  }

  // 6. Season YYYY ("Spring 2025") or standalone 4-digit year line
  const seasonOrYear =
    /^(?:(?:spring|summer|autumn|fall|winter)\s+)?((?:19|20)\d{2})$/i.exec(s);
  if (seasonOrYear && validYear(Number(seasonOrYear[1]))) {
    return seasonOrYear[1];
  }

  return null;
}

export function parsePDFInfoDate(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  // Standard PDF date format: D:YYYYMMDDHHmmSSOHH'mm'
  const m = /^(?:D:)?((?:19|20)\d{2})(0[1-9]|1[0-2])?([0-2]\d|3[01])?/.exec(
    raw.trim(),
  );
  if (!m) return undefined;
  const yr = Number(m[1]);
  if (!validYear(yr)) return undefined;
  if (m[2] && m[3]) return `${m[1]}-${m[2]}-${m[3]}`;
  if (m[2]) return `${m[1]}-${m[2]}`;
  return m[1];
}

function isSeriesOrJournalBanner(text: string): boolean {
  const s = text.trim();
  if (s.length > 90) return false;
  return /\b(?:working\s+paper\s+series|discussion\s+paper\s+series|journal\s+of|review\s+of|quarterly\s+journal|american\s+economic|econometrica|management\s+science|operations\s+management|marketing\s+science|proceedings\s+of)\b/i.test(
    s,
  );
}

function detectPreprintSeriesVenue(fullText: string, doi?: string): string | undefined {
  if (doi && /^10\.3386\//i.test(doi)) return "NBER Working Paper";
  if (doi && /^10\.2139\/ssrn/i.test(doi)) return "SSRN Working Paper";
  const nber = /\bnber\s+working\s+paper(?:\s+series)?(?:\s+(?:no\.?\s*)?(w?\d{4,6}))?/i.exec(
    fullText,
  );
  if (nber) {
    return nber[1] ? `NBER Working Paper ${nber[1].replace(/^w/i, "")}` : "NBER Working Paper";
  }
  if (
    /\b(?:ssrn\s+electronic\s+journal|available\s+at\s+ssrn|ssrn\.com\/abstract)\b/i.test(
      fullText,
    )
  ) {
    return "SSRN Working Paper";
  }
  const cepr = /\bcepr\s+discussion\s+paper(?:\s+(?:no\.?\s*)?(\d{4,6}))?/i.exec(
    fullText,
  );
  if (cepr) {
    return cepr[1] ? `CEPR Discussion Paper ${cepr[1]}` : "CEPR Discussion Paper";
  }
  const iza = /\biza\s+discussion\s+paper(?:\s+(?:no\.?\s*)?(\d{4,6}))?/i.exec(
    fullText,
  );
  if (iza) {
    return iza[1] ? `IZA Discussion Paper ${iza[1]}` : "IZA Discussion Paper";
  }
  const genericSeries =
    /\b([A-Z][A-Za-z& ]{2,36}?\s+(?:Working|Discussion|Staff)\s+Paper)(?:\s+(?:Series|No\.?\s*\w+))?\b/.exec(
      fullText,
    );
  if (genericSeries) {
    return genericSeries[1].replace(/\s+/g, " ").trim();
  }
  return undefined;
}

/**
 * Deterministically extracts title, authors, year/date, preprint vs. journal
 * type, venue, affiliation, and abstract from the first 2 pages of a PDF
 * (specially tailored for Working Papers / Preprints / LaTeX manuscripts).
 */
export function extractWorkingPaperMetadata(
  blocks: PDFBlock[],
  pdfInfo?: Record<string, unknown>,
): ExtractedFrontMatter {
  const frontBlocks = blocks.filter(
    (b) =>
      b.page <= 2 &&
      b.text?.trim() &&
      !["header", "footer", "number", "display_formula", "formula_number"].includes(
        b.label,
      ),
  );
  const fullFrontText = frontBlocks.map((b) => b.text).join("\n");
  const out: ExtractedFrontMatter = {};

  // 1. Identifiers (DOI / arXiv)
  const doiMatch = /\b(10\.\d{4,9}\/[^\s"<>]+[^\s"<>.,;)\]])/i.exec(fullFrontText);
  if (doiMatch) out.doi = doiMatch[1];
  const arxivMatch = /\barxiv:\s*(\d{4}\.\d{4,5}(?:v\d+)?)/i.exec(fullFrontText);
  if (arxivMatch) out.arxiv = arxivMatch[1];

  // 2. Title & optional top journal/series banner
  const docTitles = frontBlocks.filter((b) => b.label === "doc_title");
  let mainTitleBlock: PDFBlock | undefined;
  let bannerVenue: string | undefined;
  if (docTitles.length >= 2 && isSeriesOrJournalBanner(docTitles[0].text)) {
    bannerVenue = docTitles[0].text.replace(/\s+/g, " ").trim();
    mainTitleBlock = docTitles[1];
  } else if (docTitles.length >= 1) {
    mainTitleBlock = docTitles[0];
  }
  if (mainTitleBlock) {
    const cleanTitle = mainTitleBlock.text
      .replace(/[\u2020\u2021*∗†‡]+$/u, "")
      .replace(/\s+/g, " ")
      .trim();
    if (cleanTitle.length >= 6) out.title = cleanTitle;
  } else if (typeof pdfInfo?.Title === "string") {
    const infoTitle = pdfInfo.Title.replace(/\s+/g, " ").trim();
    if (
      infoTitle.length >= 8 &&
      /\s/.test(infoTitle) &&
      !/microsoft word|\.docx?|\.tex|\.pdf|untitled/i.test(infoTitle)
    ) {
      out.title = infoTitle;
    }
  }

  // 3. Footnote surnames & affiliations (`* . Wang: University of Chicago...`)
  const { surnames: footnoteSurnames, affiliations } =
    extractFootnoteSurnames(frontBlocks);
  if (affiliations.length) {
    out.affiliation = [...new Set(affiliations)].slice(0, 3).join("; ");
  }

  // 4. Cut-off index on Page 1–2 where body/abstract starts (authors & cover dates appear above this)
  const stopIdx = frontBlocks.findIndex(
    (b) =>
      b.label === "abstract" ||
      /^(?:abstract|摘要|1\.?\s+introduction|i\.?\s+introduction|一、\s*引言)\b/i.test(
        b.text.trim(),
      ),
  );
  const headerZone =
    stopIdx >= 0 ? frontBlocks.slice(0, stopIdx) : frontBlocks.slice(0, 12);
  const afterTitleIdx = mainTitleBlock
    ? headerZone.indexOf(mainTitleBlock) + 1
    : 0;
  const candidateBlocks = headerZone.slice(Math.max(0, afterTitleIdx));

  // 5. Extract Authors (`creators`)
  // 5a. Explicit `"Name: ..."` / `"Authors: ..."` block
  const labeledAuthorBlock = candidateBlocks.find((b) =>
    /^(?:authors?|names?|作者|姓名)\s*[:：]\s*\S+/i.test(b.text.trim()),
  );
  if (labeledAuthorBlock) {
    const parsed = splitAuthorStringToCreators(
      labeledAuthorBlock.text,
      footnoteSurnames,
    );
    if (parsed.length) out.creators = parsed;
  }

  // 5b. Explicit Affiliation block (`"Affiliation: Nanjing University"`)
  const labeledAff = candidateBlocks.find((b) =>
    /^(?:affiliations?|institutions?|单位|机构)\s*[:：]\s*\S+/i.test(b.text.trim()),
  );
  if (labeledAff && !out.affiliation) {
    out.affiliation = labeledAff.text
      .replace(/^(?:affiliations?|institutions?|单位|机构)\s*[:：]\s*/i, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  // 5c. Stacked or inline author blocks between title and abstract/corresponding-author
  if (!out.creators?.length) {
    const stackedCreators: Creator[] = [];
    const stackedAffs: string[] = [];
    for (const b of candidateBlocks) {
      const txt = b.text.replace(/\s+/g, " ").trim();
      if (!txt) continue;
      if (/^(?:author\s+information)\s*$/i.test(txt)) continue;
      if (
        /^(?:corresponding\s+author|financial\s+support|acknowledg|jel\s+classification|keywords?|to\s+cite\s+this\s+article|published\s+online)/i.test(
          txt,
        )
      ) {
        break;
      }
      if (parseFlexibleDate(txt, true)?.priority === 90) continue;
      if (
        /\b(?:university|school\s+of|department\s+of|institute|college|faculty|email:|address:|@)\b|大学|学院|研究院/i.test(
          txt,
        )
      ) {
        const cleanAff = txt
          .replace(/\bEmail:\s*\S+/gi, "")
          .replace(/^Address:\s*/i, "")
          .trim()
          .replace(/[,;]\s*$/, "");
        if (cleanAff && cleanAff.length < 160) stackedAffs.push(cleanAff);
        continue;
      }
      const parsed = splitAuthorStringToCreators(txt, footnoteSurnames);
      if (parsed.length >= 2) {
        out.creators = parsed;
        break;
      }
      if (parsed.length === 1 && txt.split(/\s+/).length <= 5) {
        stackedCreators.push(parsed[0]);
      }
    }
    if (!out.creators?.length && stackedCreators.length) {
      out.creators = stackedCreators;
    }
    if (!out.affiliation && stackedAffs.length) {
      out.affiliation = [...new Set(stackedAffs)].slice(0, 2).join("; ");
    }
  }

  // 5d. Fallback to PDF Info `Author`
  if (!out.creators?.length && typeof pdfInfo?.Author === "string") {
    const rawPdfAuthor = pdfInfo.Author.trim();
    if (
      rawPdfAuthor &&
      !BAD_PDF_AUTHORS.has(rawPdfAuthor.toLowerCase()) &&
      (HAN.test(rawPdfAuthor) || /\s/.test(rawPdfAuthor))
    ) {
      const parsed = splitAuthorStringToCreators(rawPdfAuthor, footnoteSurnames);
      if (parsed.length) out.creators = parsed;
    }
  }

  // 6. Extract Date / Year (`date`) — standalone dates only from headerZone above Abstract/Introduction
  const headerSet = new Set(headerZone);
  let bestDate: { date: string; priority: number } | null = null;
  for (const b of frontBlocks) {
    if (b.label === "abstract") continue;
    const inHeader = headerSet.has(b) && b.label !== "footnote";
    const hit = parseFlexibleDate(b.text, inHeader);
    if (hit && (!bestDate || hit.priority > bestDate.priority)) {
      bestDate = hit;
    }
  }
  if (bestDate) {
    out.date = bestDate.date;
  } else {
    const pdfDate =
      parsePDFInfoDate(pdfInfo?.CreationDate) ??
      parsePDFInfoDate(pdfInfo?.ModDate);
    if (pdfDate) out.date = pdfDate;
  }

  // 7. Extract Abstract
  const absBlock = frontBlocks.find(
    (b) =>
      b.label === "abstract" ||
      /^abstract\s*[.:：—-]\s*\S+/i.test(b.text.trim()),
  );
  if (absBlock) {
    const cleanAbs = absBlock.text
      .replace(/^(?:abstract|摘要)\s*[.:：—-]?\s*/i, "")
      .replace(/\s+/g, " ")
      .trim();
    if (cleanAbs.length >= 40) out.abstract = cleanAbs;
  }

  // 8. Determine Preprint vs. Journal `itemType` & `venue`
  const preprintSeries = detectPreprintSeriesVenue(fullFrontText, out.doi);
  if (preprintSeries) {
    out.itemType = "preprint";
    out.venue = preprintSeries;
  } else if (out.arxiv || isPreprintVenueOrDOI(bannerVenue, out.doi)) {
    out.itemType = "preprint";
    if (bannerVenue) out.venue = bannerVenue;
  } else if (
    bannerVenue &&
    !PREPRINT_VENUE_RE.test(bannerVenue) &&
    (out.doi || /\bpublished\s+online|to\s+cite\s+this\s+article\b/i.test(fullFrontText))
  ) {
    out.itemType = "journal";
    out.venue = bannerVenue;
  } else if (out.doi && !isPreprintVenueOrDOI(undefined, out.doi)) {
    out.itemType = "journal";
  } else if (
    // Unpublished working paper / manuscript / LaTeX draft without journal DOI
    !out.doi &&
    (!!out.creators?.length || !!out.title) &&
    (!!absBlock ||
      /\b(?:jel\s+classification|keywords?|preliminary|working\s+paper|draft|author\s+information|1\.?\s+introduction)\b|关键词|引言/i.test(
        fullFrontText,
      ) ||
      footnoteSurnames.size > 0)
  ) {
    out.itemType = "preprint";
    out.venue = "Working Paper";
  }

  return out;
}

/**
 * Builds the non-destructive metadata patch to apply to a Document.
 * Preserves manual edits unless `repairMangledCreators` is enabled and the
 * existing creators list is a mangled single-item blob.
 */
export function buildWorkingPaperPatch(
  doc: Document,
  extracted: ExtractedFrontMatter,
  repairMangledCreators = true,
): {
  title?: string;
  metadata?: Partial<Pick<PaperMetadata, PaperMetadataField>>;
} | null {
  const m = doc.metadata;
  const sources = m.sources ?? {};
  const metaPatch: Partial<Pick<PaperMetadata, PaperMetadataField>> = {};
  let hasChanges = false;

  const canFill = (field: PaperMetadataField) => {
    const current = m[field];
    const isEmpty = Array.isArray(current)
      ? current.length === 0
      : !String(current ?? "").trim();
    if (isEmpty && sources[field] !== "manual") return true;
    return false;
  };

  if (extracted.creators?.length) {
    if (
      canFill("creators") ||
      (repairMangledCreators && isMangledCreators(m.creators))
    ) {
      if (JSON.stringify(extracted.creators) !== JSON.stringify(m.creators)) {
        metaPatch.creators = extracted.creators;
        hasChanges = true;
      }
    }
  }

  if (extracted.date && canFill("date")) {
    metaPatch.date = extracted.date;
    hasChanges = true;
  }

  if (extracted.itemType) {
    if (
      canFill("itemType") ||
      (sources.itemType !== "manual" &&
        m.itemType === "journal" &&
        isPreprintVenueOrDOI(m.venue || extracted.venue, m.doi || extracted.doi))
    ) {
      if (m.itemType !== extracted.itemType) {
        metaPatch.itemType = extracted.itemType;
        hasChanges = true;
      }
    }
  }

  if (extracted.venue && canFill("venue")) {
    metaPatch.venue = extracted.venue;
    hasChanges = true;
  }

  if (extracted.affiliation && canFill("affiliation")) {
    metaPatch.affiliation = extracted.affiliation;
    hasChanges = true;
  }

  if (extracted.abstract && canFill("abstract")) {
    metaPatch.abstract = extracted.abstract;
    hasChanges = true;
  }

  if (extracted.doi && canFill("doi")) {
    metaPatch.doi = extracted.doi;
    hasChanges = true;
  }

  if (extracted.arxiv && canFill("arxiv")) {
    metaPatch.arxiv = extracted.arxiv;
    hasChanges = true;
  }

  let titlePatch: string | undefined;
  if (
    extracted.title &&
    sources.title !== "manual" &&
    (!doc.title.trim() ||
      /^[a-z0-9_-]{6,}$/i.test(doc.title.trim()) ||
      /\.pdf$/i.test(doc.title.trim()))
  ) {
    titlePatch = extracted.title;
    hasChanges = true;
  }

  if (!hasChanges) return null;
  return {
    ...(titlePatch ? { title: titlePatch } : {}),
    ...(Object.keys(metaPatch).length ? { metadata: metaPatch } : {}),
  };
}

async function readPDFMetadataDictionary(
  documentId: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const pdfjs = await import("pdfjs-dist");
    const task = pdfjs.getDocument({
      url: publicationURL(documentId, "original.pdf"),
      cMapUrl: "/pdf-assets/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/pdf-assets/standard_fonts/",
      wasmUrl: "/pdf-assets/wasm/",
    });
    try {
      const pdf = await task.promise;
      const meta = await pdf.getMetadata();
      return (meta?.info as Record<string, unknown>) ?? undefined;
    } finally {
      await task.destroy();
    }
  } catch {
    return undefined;
  }
}

export function needsWorkingPaperEnrichment(
  doc: Document,
  job?: Processing,
): boolean {
  if (doc.library !== "papers" || doc.type !== "pdf" || doc.deletedAt) {
    return false;
  }
  if (job && (job.phase === "learning" || job.incomplete)) {
    return false;
  }
  const m = doc.metadata;
  if (isMangledCreators(m.creators)) return true;
  if (
    (m.lookup === "notFound" || m.lookup === "failed") &&
    (!m.creators?.length || !m.date || !m.itemType)
  ) {
    return true;
  }
  if (m.itemType === "preprint" && (!m.creators?.length || !m.date)) {
    return true;
  }
  return false;
}

/**
 * Extracts working-paper/preprint front-matter from parsed blocks + PDF Info
 * and persists missing fields (or repairs mangled single-blob creators).
 */
export async function enrichWorkingPaperFromPDF(
  doc: Document,
  options?: { repairMangledCreators?: boolean },
): Promise<boolean> {
  if (doc.type !== "pdf") return false;
  const blocks = await api.blocks(doc.id);
  if (!blocks.length) return false;
  let extracted = extractWorkingPaperMetadata(blocks);
  if (!extracted.date || !extracted.creators?.length || !extracted.title) {
    const pdfInfo = await readPDFMetadataDictionary(doc.id);
    if (pdfInfo) {
      extracted = extractWorkingPaperMetadata(blocks, pdfInfo);
    }
  }
  const patch = buildWorkingPaperPatch(
    doc,
    extracted,
    options?.repairMangledCreators ?? true,
  );
  if (!patch) return false;
  await api.update(doc.id, patch);
  return true;
}
