/**
 * Dictionary-existence gate for processor output.
 *
 * 2026-07-03: the processor (Gemma 12B) provably does NOT know which
 * target-language words are real — a live session wrote "кост", "янный",
 * and bare "ла" to FSRS as fluently-produced nouns, which then inflated
 * level inference to B1 for an A1 learner. Prompt instructions don't bind
 * this model (session-long lesson), so the gate is structural: a word
 * only reaches spaced repetition if a hunspell dictionary recognizes its
 * surface form or its lemma.
 *
 * Pure-JS hunspell (nspell) + npm dictionary packages — no system deps.
 * Languages without an installed dictionary are NOT gated (fail-open):
 * this is a precision filter, not a gatekeeper for language support.
 */

const DICTIONARY_LOADERS: Record<string, () => Promise<{ aff: unknown; dic: unknown }>> = {
  ru: () => import('dictionary-ru' as string) as any,
  // 2026-08-04: NOT pt. dictionary-pt's affix file is ~6x larger/more
  // complex than any other installed dictionary (979KB vs 3-167KB), and
  // nspell's add() has some algorithmic blowup on it specifically —
  // confirmed in isolation: ru/es/en build their spellers in 0.1-2.3s,
  // pt didn't finish even after 20s of pegging a full core. Since this
  // build is synchronous and blocks the whole event loop, every Portuguese
  // session hit this on its first gate check and wedged until the job
  // watchdog SIGKILLed it. Fail-open (same as the other ungated languages
  // below) until nspell/dictionary-pt's perf is actually fixed — see this
  // file's own doc comment on what fail-open costs (loses the
  // hallucinated-word protection this gate exists for).
  es: () => import('dictionary-es' as string) as any,
  en: () => import('dictionary-en' as string) as any,
};

type Speller = { correct: (word: string) => boolean };

const spellers = new Map<string, Promise<Speller | null>>();

function loadSpeller(lang: string): Promise<Speller | null> {
  const cached = spellers.get(lang);
  if (cached) return cached;

  const loader = DICTIONARY_LOADERS[lang];
  const promise: Promise<Speller | null> = loader
    ? Promise.all([import('nspell' as string) as any, loader()])
        .then(([nspellMod, dict]: [any, any]) => {
          const nspell = nspellMod.default ?? nspellMod;
          const d = dict.default ?? dict;
          return nspell(d) as Speller;
        })
        .catch((err) => {
          console.warn(`[Dictionary] Failed to load ${lang} dictionary — gate disabled for ${lang}:`, err);
          return null;
        })
    : Promise.resolve(null);

  spellers.set(lang, promise);
  return promise;
}

/**
 * true → recognized; false → not a real word; null → no dictionary for
 * this language (caller should not gate).
 */
export async function isRealWord(word: string, lang: string): Promise<boolean | null> {
  const speller = await loadSpeller((lang || '').toLowerCase());
  if (!speller) return null;
  const w = (word || '').trim();
  if (!w) return false;
  if (speller.correct(w) || speller.correct(w.toLowerCase())) return true;
  // Multi-word and hyphenated entries ("потому что", "по-русски") are
  // real vocabulary items but absent from hunspell as a unit — accept
  // them when every token is itself a dictionary word.
  const tokens = w.split(/[\s-]+/).filter(Boolean);
  if (tokens.length < 2) return false;
  for (const t of tokens) {
    if (!speller.correct(t) && !speller.correct(t.toLowerCase())) return false;
  }
  return true;
}

/**
 * Gate one processor lexeme: passes if either the surface form or the
 * lemma is a dictionary word. null-dictionary languages always pass.
 */
export async function passesDictionaryGate(
  form: string,
  lemma: string,
  lang: string,
): Promise<boolean> {
  const formOk = await isRealWord(form, lang);
  if (formOk === null) return true; // no dictionary — fail open
  if (formOk) return true;
  return (await isRealWord(lemma, lang)) === true;
}
