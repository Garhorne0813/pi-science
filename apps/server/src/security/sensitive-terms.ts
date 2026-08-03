/**
 * Sensitive-term detection for outbound connector queries (literature,
 * chemistry, biology services). Pure detection: it only classifies query
 * text; enforcement (ask-the-user gating) is wired at the call site.
 *
 * Design notes:
 * - DNA/RNA: 12+ consecutive nucleotide letters (ACGTNU, case-insensitive).
 *   Long runs of only these letters are vanishingly rare in prose.
 * - Protein: 14+ consecutive standard amino-acid letters (20-letter alphabet)
 *   that also contain at least two low-frequency letters (C F H M W Y) and are
 *   not purely nucleotide runs. Plain English words essentially never satisfy
 *   all constraints; a tiny exclude list covers the rare exceptions.
 * - Compounds: SMILES ion brackets, chain/ring-closure/chemical-formula
 *   patterns, InChI/InChIKey.
 * - Clinical: labeled record numbers (patient/MRN/病历号/住院号/门诊号/就诊号).
 *   Bare 18-digit sequences are intentionally NOT flagged (too many false
 *   positives on order numbers etc.).
 * - Custom: user-supplied term list (case-insensitive substring, length >= 2).
 *
 * Known detection boundaries (by design, covered by negative tests):
 * - Bare patient labels with alphanumeric strings ("patient 88AB123") are not
 *   flagged; only labeled records or patient + bare digit runs match.
 * - Single-atom bracket placeholders ([C]/[N]) and short formula shorthands
 *   (CO2/CH4/H2O/C3H8) are not flagged; ring-closed SMILES (C1CC1, C1CCCCC1)
 *   and chained SMILES with symbols (CC(=O)O, O=C=O) are.
 * - Pure-lowercase prose and code-style tokens (e2e/b2b/R2D2/C3PO) never match;
 *   hyphenated non-chemistry words (CC-BY) are rejected via the organic-letter
 *   check.
 */

export type SensitiveCategory = "dna-sequence" | "protein-sequence" | "compound-identifier" | "clinical-identifier" | "custom";

export const SENSITIVE_CATEGORIES: readonly SensitiveCategory[] = ["dna-sequence", "protein-sequence", "compound-identifier", "clinical-identifier", "custom"];

export type SensitiveTermResult = {
  matched: boolean;
  categories: SensitiveCategory[];
  terms: string[];
};

export type SensitiveTermOptions = {
  /** User-configured terms; substring match, case-insensitive. Default: env PI_SCIENCE_SENSITIVE_TERMS (comma-separated), else none. */
  customTerms?: readonly string[];
};

const MAX_TERM_LENGTH = 120;

/** DNA/RNA nucleotide letters: A C G T N (any) + U (RNA). */
const NUCLEOTIDES = /(?<![A-Za-z])([ACGTNUacgtnu]{12,})(?![A-Za-z])/g;
/** Standard 20-letter amino-acid alphabet (excludes B/J/O/U/X/Z). */
const AMINO_ACID_LETTERS = new Set("ACDEFGHIKLMNPQRSTVWY".split(""));
const NUCLEOTIDE_LETTERS = new Set("ACGTNUacgtnu".split(""));
const AMINO_ACID_PATTERN = /(?<![A-Za-z])([A-Za-z]{14,})(?![A-Za-z])/g;
/** Low-frequency amino-acid letters; requiring 2+ of them kills English-word matches. */
const LOW_FREQUENCY = new Set("CFHMWY".split(""));
/** Rare long English words composed solely of amino-acid letters that would otherwise false-positive. Stored uppercase: isProteinLike compares against the uppercased candidate. */
const PROTEIN_FALSE_POSITIVES = new Set(["CHARACTERISTIC", "CHARACTERISTICALLY", "CHARACTERISTICS", "MATHEMATICALLY", "ELECTROMAGNETICALLY"]);
/** SMILES atom/ion inside brackets, e.g. [Na+], [Cl-], [NH4+]. */
const SMILES_ION = /\[[A-Z][a-z]?(?:\d+)?(?:[+-](?:\d+)?)?\]/g;
/** Chemical-formula-style tokens ending in a letter, e.g. H2O, C6H12O6, C1CCCCC1 (min 3 chars). */
const SMILES_RING_LETTER_TAIL = /(?<![A-Za-z0-9])([A-Za-z*][A-Za-z0-9*]*\d[A-Za-z0-9*]*[A-Za-z*])(?![A-Za-z0-9])/g;
/** Ring-closure tokens with 2+ digits ending in a digit, e.g. C1CCCCC1 (excludes "python3"-style words). */
const SMILES_RING_DIGIT_TAIL = /(?<![A-Za-z0-9])([A-Za-z*][A-Za-z0-9*]*\d[A-Za-z0-9*]*\d)(?![A-Za-z0-9])/g;
/** Chain-style SMILES: letters/digits/symbols with no bracket requirement, e.g. CCO, CC(=O)O, O=C=O, C1=CC=CC=C1, N[C@@H](C)C(=O)O, c1ccccc1. */
const SMILES_CHAIN = /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9=()@/\\-]*)(?![A-Za-z0-9])/g;
/** Uppercase organic-subset single letters (B C N O P S F; Cl/Br handled separately). */
const ORGANIC_UPPER = new Set("BCNOPSF".split(""));
/** Aromatic lowercase SMILES atoms: c n o p s. */
const AROMATIC_LOWER = new Set("cnops".split(""));
/** All-uppercase organic-letter words that are prose abbreviations, not SMILES. */
const UPPER_ORGANIC_EXCLUDE = new Set(["CNN", "CBS", "FBI", "NBC", "BBC", "CNBC", "CCP", "PSF", "NPO", "BBS"]);
const INCHI = /\b(?:InChI=|InChIKey=)[A-Z0-9\/\.\-\(\)\+\,\?]+/gi;
/**
 * Labeled record numbers. Patient identifiers must carry an explicit label
 * (patient id/no/number/#) or be a bare digit run directly after "patient";
 * plain prose like "patient satisfaction survey" never matches. The leading
 * boundary uses (?<![A-Za-z0-9_]) instead of \b because \b does not hold
 * between two non-ASCII characters (e.g. before 病历号 in 病历号：2024001234).
 */
const CLINICAL_RECORD = /(?<![A-Za-z0-9_])(?:(?:patient\s*(?:id|no\.?|number|#)[-:：\s_]*[A-Z0-9]{4,20})|(?:patient\s+[0-9]{4,20})|(?:mrn|病历号|住院号|门诊号|就诊号)[-:：\s_]*[A-Z0-9]{4,20})\b/gi;

function clip(value: string): string {
  return value.length > MAX_TERM_LENGTH ? `${value.slice(0, MAX_TERM_LENGTH)}…` : value;
}

function countLowFrequency(value: string): number {
  let count = 0;
  for (const char of value) if (LOW_FREQUENCY.has(char.toUpperCase())) count += 1;
  return count;
}

/** Bracketed SMILES hits must carry a charge or at least 4 characters: "[A]"/"[B]" placeholders are prose, "[Na+]"/"[CH4]" are chemistry. */
function isBracketIon(candidate: string): boolean {
  return candidate.length >= 4 || /[+-]/.test(candidate);
}

/** Formula-like hits must be 4+ chars with 2+ distinct letters: "e2e"/"b2b"/"H2O" prose shorthands never match, "C6H12O6"/"H2SO4" do. */
function isFormulaLike(candidate: string): boolean {
  if (candidate.length < 4) return false;
  const letters = new Set(candidate.toUpperCase().replace(/[^A-Z]/g, ""));
  return letters.size >= 2;
}

/** True when the token contains an uppercase organic-subset letter or a Cl/Br pair. */
function hasOrganicUpper(candidate: string): boolean {
  for (const char of candidate) if (ORGANIC_UPPER.has(char)) return true;
  return /Cl|Br/.test(candidate);
}

/** Code-style shorthands: letter-digit-letter start, <=5 chars, distinct digits (e2e, b2b, C3PO, C3H8). Repeated digits (C1CC1) mean a ring closure, not shorthand. */
function isCodeLikeShorthand(candidate: string): boolean {
  if (candidate.length > 5) return false;
  if (!/^[A-Za-z]\d[A-Za-z]/.test(candidate)) return false;
  const digits = candidate.match(/\d/g) ?? [];
  if (digits.length > 2) return false;
  return new Set(digits).size === digits.length;
}

/**
 * Chain-style SMILES gate. Catches CCO, CC(=O)O, O=C=O, C1=CC=CC=C1, c1ccccc1
 * while rejecting prose, abbreviations (C3PO, R2D2, e2e), single-atom brackets
 * and short formula shorthands (CO2/CH4/H2O). Slash-enumerated strings
 * ("CO2/CH4/H2O", "CNN/BBC") are only flagged when every slash-separated
 * segment passes the gate on its own; SMILES containing other special
 * symbols (= ( ) @ \\) still match directly.
 */
function isChainSmiles(candidate: string): boolean {
  if (candidate.length < 3) return false;
  if (isCodeLikeShorthand(candidate)) return false;
  const hasDigit = /[0-9]/.test(candidate);
  const hasLower = /[a-z]/.test(candidate);
  const aromaticLower = [...candidate].some((char) => AROMATIC_LOWER.has(char));
  if (!hasOrganicUpper(candidate) && !(aromaticLower && hasDigit)) return false;
  if (/[=()@\\]/.test(candidate)) return true;
  if (candidate.includes("/")) {
    // Slash-enumerated strings: each segment must independently pass the gate
    // ("CO2/CH4/H2O", "CNN/BBC", "pH/temp" are prose lists, not SMILES).
    // Segments no longer contain "/" so recursion terminates.
    return candidate.split("/").every((segment) => isChainSmiles(segment));
  }
  if (candidate.includes("-")) {
    const stripped = candidate.replace(/-/g, "");
    if (/[a-z]/.test(stripped)) return false;
    if (![...stripped].every((char) => ORGANIC_UPPER.has(char))) return false;
    return new Set([...stripped]).size >= 2;
  }
  const digitCount = (candidate.match(/\d/g) ?? []).length;
  if (digitCount === 1 && candidate.length <= 4) return false; // CO2/CH4/H2O-style formula shorthands
  if (hasDigit) return true; // ring closures: C1CC1, C1CCCCC1, C6H12O6
  if (hasLower) return false; // mixed-case prose: Ethanol, InChI
  if (![...candidate].every((char) => ORGANIC_UPPER.has(char))) return false;
  if (UPPER_ORGANIC_EXCLUDE.has(candidate)) return false;
  return new Set([...candidate]).size >= 2 || candidate.length >= 4; // CCO, CCC(C3?), CCCC
}

function isProteinLike(candidate: string): boolean {
  const upper = candidate.toUpperCase();
  if (PROTEIN_FALSE_POSITIVES.has(upper)) return false;
  let nucleotideOnly = true;
  for (const char of upper) {
    if (!AMINO_ACID_LETTERS.has(char)) return false;
    if (!NUCLEOTIDE_LETTERS.has(char)) nucleotideOnly = false;
  }
  // Pure nucleotide runs (ACGT...) are DNA/RNA, not protein.
  if (nucleotideOnly) return false;
  return countLowFrequency(upper) >= 2;
}

function collect(patterns: RegExp[], text: string): string[] {
  const found: string[] = [];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const value = match[1] ?? match[0];
      if (!found.includes(value)) found.push(clip(value));
    }
  }
  return found;
}

/** Detect sensitive patterns in a query. Returns matched categories and the raw hits. */
export function detectSensitiveTerms(query: string, options: SensitiveTermOptions = {}): SensitiveTermResult {
  const categories: SensitiveCategory[] = [];
  const terms: string[] = [];

  const dna = collect([NUCLEOTIDES], query);
  if (dna.length) { categories.push("dna-sequence"); terms.push(...dna); }

  const protein: string[] = [];
  for (const match of query.matchAll(AMINO_ACID_PATTERN)) {
    const candidate = match[1] ?? match[0];
    if (isProteinLike(candidate) && !protein.includes(candidate)) protein.push(clip(candidate));
  }
  if (protein.length) { categories.push("protein-sequence"); terms.push(...protein); }

  const ionHits = collect([SMILES_ION], query).filter(isBracketIon);
  const chainHits = collect([SMILES_CHAIN], query).filter(isChainSmiles);
  const letterTailHits = collect([SMILES_RING_LETTER_TAIL], query).filter(isFormulaLike).filter((hit) => hasOrganicUpper(hit) && !isCodeLikeShorthand(hit));
  const ringDigitHits = collect([SMILES_RING_DIGIT_TAIL], query).filter((hit) => hasOrganicUpper(hit) && !isCodeLikeShorthand(hit));
  const inchiHits = collect([INCHI], query);
  const compounds = [...ionHits, ...chainHits, ...letterTailHits, ...ringDigitHits, ...inchiHits].filter((hit, index, all) => all.indexOf(hit) === index);
  if (compounds.length) { categories.push("compound-identifier"); terms.push(...compounds); }

  const clinical = collect([CLINICAL_RECORD], query);
  if (clinical.length) { categories.push("clinical-identifier"); terms.push(...clinical); }

  const customList = (options.customTerms?.length ? [...options.customTerms] : (process.env.PI_SCIENCE_SENSITIVE_TERMS ?? "").split(",").map((term) => term.trim())).filter((term) => term.length >= 2);
  const custom: string[] = [];
  if (customList.length) {
    for (const term of customList) {
      if (query.toLowerCase().includes(term.toLowerCase()) && !custom.includes(term)) custom.push(clip(term));
    }
  }
  if (custom.length) { categories.push("custom"); terms.push(...custom); }

  return { matched: categories.length > 0, categories, terms };
}
