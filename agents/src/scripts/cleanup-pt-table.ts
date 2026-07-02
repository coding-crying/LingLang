/**
 * PT table contamination cleanup.
 *
 * Strategy:
 * 1. Rows with PT diacritics → keep as PT
 * 2. Rows in known PT seed list (manual list of common ASCII-only PT words) → keep as PT
 * 3. Rows with native_lemma set + lemma == native_lemma → reclassify to EN
 *    (the system caught these as native_substitution, but the old code
 *    still created a PT row for them — that was the bug)
 * 4. Rows with native_lemma set + lemma != native_lemma (e.g. "poison" → "so"):
 *    keep as PT but the lemma is corrupt; fix it to the native_lemma form
 *    (since the user knows the English word; the PT equivalent is what we
 *    want to learn). Actually — these are placeholder rows for PT words
 *    the user has not yet learned. Just leave them as-is for now and
 *    flag in a separate audit.
 * 5. No native_lemma + ASCII + state=2 (mastered) → keep as PT
 *    (the user mastered a real PT word, this is legit)
 * 6. No native_lemma + ASCII + state=1 (learning) → reclassify to EN
 *    (likely contamination from old code)
 * 7. No native_lemma + ASCII + state=0 (new) → reclassify to EN
 *
 * For EN reclassifications, the lexeme ID changes from `pt:lemma:pos` to
 * `en:lemma:pos`. The user_vocabulary rows that reference the old ID need
 * to be updated to point at the new lexeme (or merged if the new one
 * already exists).
 */

import { db } from '../db/index.js';
import { userVocabulary, lexemes } from '../db/schema.js';
import { eq, sql, and, inArray } from 'drizzle-orm';

// Known PT words that happen to be ASCII-only. Add to this as you encounter
// false-positive cases.
const PT_SEED = new Set([
  // Articles, pronouns, prepositions
  'a', 'o', 'as', 'os', 'um', 'uma', 'uns', 'umas', 'de', 'do', 'da', 'dos', 'das',
  'em', 'no', 'na', 'nos', 'nas', 'por', 'para', 'pelo', 'pela', 'com', 'sem',
  'sob', 'sobre', 'ate', 'entre', 'após', 'após', 'desde', 'contra',
  'eu', 'tu', 'ele', 'ela', 'nos', 'vos', 'eles', 'elas', 'me', 'te', 'se',
  'lhe', 'lhes', 'que', 'quem', 'qual', 'quais', 'cujo',
  // Common verbs
  'ser', 'ter', 'haver', 'ir', 'vir', 'dar', 'ver', 'saber', 'querer', 'poder',
  'dizer', 'falar', 'fazer', 'por', 'trazer', 'gostar', 'amar', 'ajudar',
  'aprender', 'ensinar', 'entender', 'estar', 'comer', 'beber', 'cantar',
  'dancar', 'correr', 'pular', 'rir', 'chorar', 'pedir', 'usar', 'abrir',
  'fechar', 'escrever', 'ler', 'pensar', 'sentir', 'dormir', 'acordar',
  'viver', 'morrer', 'pagar', 'comprar', 'vender', 'ganhar', 'perder',
  // Common nouns
  'cafe', 'praia', 'mar', 'sol', 'ar', 'lua', 'ceu', 'rio', 'mato', 'mel',
  'vinho', 'cerveja', 'agua', 'leite', 'pao', 'queijo', 'manteiga', 'ovos',
  'banana', 'maca', 'laranja', 'uva', 'manga', 'mamao', 'abacaxi', 'morango',
  'frango', 'carne', 'peixe', 'arroz', 'feijao', 'batata', 'tomate', 'cebola',
  'alho', 'sal', 'acucar', 'azeite', 'ovo', 'pimenta', 'pimenta', 'salsinha',
  'amigo', 'amiga', 'amor', 'familia', 'mae', 'pai', 'filho', 'filha',
  'irmao', 'irma', 'avo', 'avó', 'tio', 'tia', 'primo', 'prima', 'sobrinho',
  'casa', 'apartamento', 'carro', 'moto', 'bicicleta', 'onibus', 'metro',
  'trem', 'aviao', 'navio', 'barco', 'escola', 'trabalho', 'escritorio',
  'rua', 'avenida', 'praca', 'parque', 'jardim', 'floresta', 'campo', 'fazenda',
  'dia', 'noite', 'manha', 'tarde', 'hoje', 'ontem', 'amanha', 'semana',
  'mes', 'ano', 'hora', 'minuto', 'segundo', 'tempo', 'momento', 'instante',
  'homem', 'mulher', 'menino', 'menina', 'crianca', 'bebe', 'idoso', 'jovem',
  'cor', 'tamanho', 'forma', 'estilo', 'tipo', 'modo', 'jeito', 'maneira',
  'palavra', 'nome', 'numero', 'letra', 'texto', 'frase', 'pergunta', 'resposta',
  'problema', 'solucao', 'ideia', 'pensamento', 'sentimento', 'emocao',
  'coracao', 'cabeca', 'mao', 'pe', 'olho', 'boca', 'nariz', 'orelha',
  'cabelo', 'rosto', 'corpo', 'braco', 'perna', 'dedo', 'dente', 'lingua',
  'banheiro', 'cozinha', 'quarto', 'sala', 'garagem', 'jardim', 'quintal',
  'piscina', 'academia', 'hospital', 'igreja', 'banco', 'loja', 'mercado',
  'restaurante', 'bar', 'hotel', 'praia',
  // Common adjectives
  'bom', 'boa', 'mal', 'grande', 'pequeno', 'novo', 'velho', 'jovem', 'velho',
  'alto', 'baixo', 'longo', 'curto', 'largo', 'estreito', 'gordo', 'magro',
  'forte', 'fraco', 'rapido', 'lento', 'quente', 'frio', 'morno', 'fresco',
  'limpo', 'sujo', 'cheio', 'vazio', 'aberto', 'fechado', 'certo', 'errado',
  'facil', 'dificil', 'simples', 'complexo', 'importante', 'urgente',
  'comum', 'raro', 'normal', 'estranho', 'feliz', 'triste', 'bravo', 'calmo',
  'preparado', 'pronto', 'ocupado', 'livre', 'solteiro', 'casado', 'divorciado',
  // Common adverbs
  'bem', 'mal', 'mais', 'menos', 'muito', 'pouco', 'tanto', 'bastante',
  'demais', 'tambem', 'talvez', 'quase', 'apenas', 'somente', 'ja', 'ainda',
  'sempre', 'nunca', 'ontem', 'hoje', 'amanha', 'cedo', 'tarde', 'logo',
  'aqui', 'ali', 'la', 'cá', 'fora', 'dentro', 'acima', 'abaixo', 'na frente',
  'atras', 'perto', 'longe', 'junto', 'sozinho', 'rapido', 'devagar',
  'como', 'quando', 'onde', 'porque', 'embora', 'enquanto', 'depois', 'antes',
  'assim', 'entao', 'porem', 'contudo', 'todavia', 'por isso', 'porem',
  'obrigado', 'obrigada', 'desculpa', 'por favor', 'talvez', 'quem sabe',
  // Common function words
  'nada', 'algo', 'tudo', 'todo', 'toda', 'todos', 'todas', 'cada', 'qualquer',
  'outro', 'outra', 'outros', 'outras', 'mesmo', 'mesma', 'mesmos', 'mesmas',
  'tal', 'tais', 'certo', 'certa', 'certos', 'certas', 'nenhum', 'nenhuma',
  // Slang / very common
  'legal', 'maneiro', 'bacana', 'show', 'massa', 'gente', 'cara', 'moço',
  'moça', 'menino', 'menina', 'pessoal', 'galera', 'beleza', 'valeu', 'tchau',
  'oi', 'ola', 'sim', 'nao', 'talvez', 'claro', 'certo', 'exato',
]);

function hasPTDiacritics(s: string): boolean {
  return /[à-ÿÀ-ŸáéíóúçãõâêôÁÉÍÓÚÇÃÕÂÊÔ]/.test(s);
}

function classify(lemma: string, nativeLemma: string | null, state: number): 'pt' | 'en' {
  if (hasPTDiacritics(lemma)) return 'pt';
  const l = lemma.toLowerCase();
  if (PT_SEED.has(l)) return 'pt';
  // Has native_lemma link set: this was flagged as native_substitution
  if (nativeLemma) return 'en';
  // No native_lemma, ASCII, mastered (state=2) → likely real PT
  if (state >= 2) return 'pt';
  // No native_lemma, ASCII, learning (state=1) or new (state=0) → contamination
  return 'en';
}

async function main() {
  console.log('=== PT cleanup migration ===\n');

  // Snapshot PT rows
  const ptRows = await db
    .select({
      id: lexemes.id,
      lemma: lexemes.lemma,
      pos: lexemes.pos,
      language: lexemes.language,
      nativeLemma: lexemes.nativeLemma,
      state: userVocabulary.state,
      userId: userVocabulary.userId,
      userVocabId: userVocabulary.id,
    })
    .from(userVocabulary)
    .innerJoin(lexemes, eq(userVocabulary.lexemeId, lexemes.id))
    .where(eq(lexemes.language, 'pt'));

  console.log(`Total PT rows: ${ptRows.length}`);

  const enRows = ptRows.filter((r) => classify(r.lemma, r.nativeLemma, r.state) === 'en');
  const ptRows2 = ptRows.filter((r) => classify(r.lemma, r.nativeLemma, r.state) === 'pt');

  console.log(`Will reclassify to EN: ${enRows.length}`);
  console.log(`Will keep as PT: ${ptRows2.length}\n`);

  // Group EN reclassifications by user to log
  const byUser = new Map<string, number>();
  for (const r of enRows) {
    byUser.set(r.userId, (byUser.get(r.userId) || 0) + 1);
  }
  console.log('Reclassifications by user:');
  for (const [u, n] of byUser) console.log(`  ${u}: ${n}`);

  // Dry-run preview: show the first 10 EN reclassifications
  console.log('\nFirst 10 EN reclassifications:');
  for (const r of enRows.slice(0, 10)) {
    const newLemma = r.nativeLemma || r.lemma;
    const newId = `en:${newLemma.toLowerCase()}:${r.pos}`;
    console.log(`  ${r.id}  →  ${newId}`);
  }

  // Apply the migration
  console.log('\nApplying migration...');

  let reclassified = 0;
  let merged = 0;
  let deleted = 0;

  for (const r of enRows) {
    const newLemma = r.nativeLemma || r.lemma;
    const newLexemeId = `en:${newLemma.toLowerCase()}:${r.pos}`;

    // Check if the new EN lexeme already exists
    let newLex = await db.query.lexemes.findFirst({ where: eq(lexemes.id, newLexemeId) });
    if (!newLex) {
      // Create the EN lexeme (copy translation/nativeLemma from old row if useful)
      await db.insert(lexemes).values({
        id: newLexemeId,
        lemma: newLemma,
        pos: r.pos,
        language: 'en',
        translation: '', // English words don't need translations
        unitId: null,
        gender: null,
        morphFeatures: null,
        nativeLemma: null,
      });
      newLex = (await db.query.lexemes.findFirst({ where: eq(lexemes.id, newLexemeId) }))!;
    }

    // Check if user_vocab already exists for this (user, newLex) pair
    const existingVocab = await db.query.userVocabulary.findFirst({
      where: and(
        eq(userVocabulary.userId, r.userId),
        eq(userVocabulary.lexemeId, newLexemeId),
      ),
    });

    if (existingVocab) {
      // Merge: delete the old PT row's vocab, keep the existing EN vocab
      await db.delete(userVocabulary).where(eq(userVocabulary.id, r.userVocabId));
      merged++;
    } else {
      // Update: point old user_vocab row at the new EN lexeme
      await db
        .update(userVocabulary)
        .set({ lexemeId: newLexemeId })
        .where(eq(userVocabulary.id, r.userVocabId));
      reclassified++;
    }
  }

  // Delete the now-orphaned PT lexemes (no user_vocab refs)
  const ptLexemes = await db
    .select({ id: lexemes.id })
    .from(lexemes)
    .where(eq(lexemes.language, 'pt'));
  for (const lx of ptLexemes) {
    const ref = await db.query.userVocabulary.findFirst({ where: eq(userVocabulary.lexemeId, lx.id) });
    if (!ref) {
      await db.delete(lexemes).where(eq(lexemes.id, lx.id));
      deleted++;
    }
  }

  console.log(`\nReclassified: ${reclassified}`);
  console.log(`Merged into existing EN row: ${merged}`);
  console.log(`Orphaned PT lexemes deleted: ${deleted}`);

  // Final audit
  const finalPt = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(userVocabulary)
    .innerJoin(lexemes, eq(userVocabulary.lexemeId, lexemes.id))
    .where(eq(lexemes.language, 'pt'));
  console.log(`\nFinal PT user_vocab rows: ${finalPt[0]?.count}`);

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
