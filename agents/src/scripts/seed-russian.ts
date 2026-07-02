/**
 * Seed common Russian vocabulary (300 most frequent words).
 *
 * Usage:
 *   cd agents && npx tsx src/scripts/seed-russian.ts
 *
 * Then embed:
 *   npx tsx src/scripts/embed-lexemes.ts
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { db } from '../db/index.js';
import * as schema from '../db/schema.js';

// Most common Russian words ordered by frequency, with gender and morph features.
// morphFeatures JSON contains case paradigm hints for nouns, conjugation class for verbs.
const RUSSIAN_VOCAB: Array<{
  lemma: string;
  pos: string;
  translation: string;
  gender: string | null;
  morphFeatures: string | null;
}> = [
  // === PRONOUNS & FUNCTION WORDS (highest frequency) ===
  { lemma: 'я', pos: 'PRON', translation: 'I', gender: null, morphFeatures: null },
  { lemma: 'ты', pos: 'PRON', translation: 'you (informal)', gender: null, morphFeatures: null },
  { lemma: 'он', pos: 'PRON', translation: 'he', gender: null, morphFeatures: null },
  { lemma: 'она', pos: 'PRON', translation: 'she', gender: null, morphFeatures: null },
  { lemma: 'мы', pos: 'PRON', translation: 'we', gender: null, morphFeatures: null },
  { lemma: 'вы', pos: 'PRON', translation: 'you (formal/plural)', gender: null, morphFeatures: null },
  { lemma: 'они', pos: 'PRON', translation: 'they', gender: null, morphFeatures: null },
  { lemma: 'это', pos: 'PRON', translation: 'this; that', gender: null, morphFeatures: null },
  { lemma: 'что', pos: 'PRON', translation: 'what; that', gender: null, morphFeatures: null },
  { lemma: 'кто', pos: 'PRON', translation: 'who', gender: null, morphFeatures: null },
  { lemma: 'всё', pos: 'PRON', translation: 'everything; all', gender: null, morphFeatures: null },
  { lemma: 'свой', pos: 'PRON', translation: "one's own", gender: null, morphFeatures: null },
  { lemma: 'мой', pos: 'PRON', translation: 'my', gender: null, morphFeatures: null },
  { lemma: 'твой', pos: 'PRON', translation: 'your (informal)', gender: null, morphFeatures: null },
  { lemma: 'наш', pos: 'PRON', translation: 'our', gender: null, morphFeatures: null },
  { lemma: 'ваш', pos: 'PRON', translation: 'your (formal/plural)', gender: null, morphFeatures: null },
  { lemma: 'его', pos: 'PRON', translation: 'his; its', gender: null, morphFeatures: null },
  { lemma: 'её', pos: 'PRON', translation: 'her; its', gender: null, morphFeatures: null },
  { lemma: 'их', pos: 'PRON', translation: 'their', gender: null, morphFeatures: null },
  { lemma: 'сам', pos: 'PRON', translation: 'self; himself', gender: null, morphFeatures: null },

  // === VERBS — core (top 60) ===
  { lemma: 'быть', pos: 'VERB', translation: 'to be', gender: null, morphFeatures: '{"class":"irreg","pres":"есть,суть"}' },
  { lemma: 'иметь', pos: 'VERB', translation: 'to have', gender: null, morphFeatures: '{"class":"1conj"}' },
  { lemma: 'мочь', pos: 'VERB', translation: 'to be able; can', gender: null, morphFeatures: '{"class":"1conj","pres":"могу,можешь"}' },
  { lemma: 'хотеть', pos: 'VERB', translation: 'to want', gender: null, morphFeatures: '{"class":"1conj","pres":"хочу,хочешь"}' },
  { lemma: 'знать', pos: 'VERB', translation: 'to know', gender: null, morphFeatures: '{"class":"1conj"}' },
  { lemma: 'думать', pos: 'VERB', translation: 'to think', gender: null, morphFeatures: '{"class":"1conj"}' },
  { lemma: 'сказать', pos: 'VERB', translation: 'to say (perfective)', gender: null, morphFeatures: '{"class":"1conj","pair":"говорить"}' },
  { lemma: 'говорить', pos: 'VERB', translation: 'to speak; to say', gender: null, morphFeatures: '{"class":"2conj","pair":"сказать"}' },
  { lemma: 'видеть', pos: 'VERB', translation: 'to see', gender: null, morphFeatures: '{"class":"2conj"}' },
  { lemma: 'слышать', pos: 'VERB', translation: 'to hear', gender: null, morphFeatures: '{"class":"2conj"}' },
  { lemma: 'делать', pos: 'VERB', translation: 'to do; to make', gender: null, morphFeatures: '{"class":"1conj","pair":"сделать"}' },
  { lemma: 'идти', pos: 'VERB', translation: 'to go (on foot)', gender: null, morphFeatures: '{"class":"irreg","pres":"иду,идёшь"}' },
  { lemma: 'ходить', pos: 'VERB', translation: 'to go (habitual)', gender: null, morphFeatures: '{"class":"2conj"}' },
  { lemma: 'есть', pos: 'VERB', translation: 'to eat', gender: null, morphFeatures: '{"class":"irreg","pres":"ем,едите","pair":"съесть"}' },
  { lemma: 'пить', pos: 'VERB', translation: 'to drink', gender: null, morphFeatures: '{"class":"2conj","pair":"выпить"}' },
  { lemma: 'писать', pos: 'VERB', translation: 'to write', gender: null, morphFeatures: '{"class":"1conj","pair":"написать"}' },
  { lemma: 'читать', pos: 'VERB', translation: 'to read', gender: null, morphFeatures: '{"class":"1conj","pair":"прочитать"}' },
  { lemma: 'работать', pos: 'VERB', translation: 'to work', gender: null, morphFeatures: '{"class":"1conj"}' },
  { lemma: 'жить', pos: 'VERB', translation: 'to live', gender: null, morphFeatures: '{"class":"2conj","pres":"живу,живёшь"}' },
  { lemma: 'любить', pos: 'VERB', translation: 'to love; to like', gender: null, morphFeatures: '{"class":"2conj"}' },
  { lemma: 'стоять', pos: 'VERB', translation: 'to stand', gender: null, morphFeatures: '{"class":"2conj"}' },
  { lemma: 'сидеть', pos: 'VERB', translation: 'to sit', gender: null, morphFeatures: '{"class":"2conj"}' },
  { lemma: 'лежать', pos: 'VERB', translation: 'to lie (down)', gender: null, morphFeatures: '{"class":"2conj"}' },
  { lemma: 'давать', pos: 'VERB', translation: 'to give', gender: null, morphFeatures: '{"class":"1conj","pair":"дать"}' },
  { lemma: 'брать', pos: 'VERB', translation: 'to take', gender: null, morphFeatures: '{"class":"1conj","pair":"взять"}' },
  { lemma: 'понимать', pos: 'VERB', translation: 'to understand', gender: null, morphFeatures: '{"class":"1conj","pair":"понять"}' },
  { lemma: 'помогать', pos: 'VERB', translation: 'to help', gender: null, morphFeatures: '{"class":"1conj","pair":"помочь"}' },
  { lemma: 'учить', pos: 'VERB', translation: 'to teach; to learn', gender: null, morphFeatures: '{"class":"2conj"}' },
  { lemma: 'играть', pos: 'VERB', translation: 'to play', gender: null, morphFeatures: '{"class":"1conj"}' },
  { lemma: 'спать', pos: 'VERB', translation: 'to sleep', gender: null, morphFeatures: '{"class":"2conj"}' },
  { lemma: 'ждать', pos: 'VERB', translation: 'to wait', gender: null, morphFeatures: '{"class":"1conj"}' },
  { lemma: 'купить', pos: 'VERB', translation: 'to buy (perfective)', gender: null, morphFeatures: '{"class":"2conj","pair":"покупать"}' },
  { lemma: 'покупать', pos: 'VERB', translation: 'to buy (imperfective)', gender: null, morphFeatures: '{"class":"1conj","pair":"купить"}' },
  { lemma: 'приходить', pos: 'VERB', translation: 'to come; to arrive', gender: null, morphFeatures: '{"class":"2conj","pair":"прийти"}' },
  { lemma: 'находить', pos: 'VERB', translation: 'to find', gender: null, morphFeatures: '{"class":"2conj","pair":"найти"}' },
  { lemma: 'считать', pos: 'VERB', translation: 'to count; to consider', gender: null, morphFeatures: '{"class":"1conj"}' },
  { lemma: 'смотреть', pos: 'VERB', translation: 'to look; to watch', gender: null, morphFeatures: '{"class":"2conj"}' },
  { lemma: 'учиться', pos: 'VERB', translation: 'to study; to learn', gender: null, morphFeatures: '{"class":"2conj"}' },
  { lemma: 'нужно', pos: 'VERB', translation: 'it is necessary; need', gender: null, morphFeatures: '{"class":"impersonal"}' },
  { lemma: 'можно', pos: 'VERB', translation: 'it is possible; may', gender: null, morphFeatures: '{"class":"impersonal"}' },
  { lemma: 'должен', pos: 'VERB', translation: 'must; should', gender: null, morphFeatures: '{"class":"short_adj"}' },

  // === NOUNS — core (top 120) ===
  { lemma: 'человек', pos: 'NOUN', translation: 'person; human', gender: 'masc', morphFeatures: '{"nom_pl":"люди"}' },
  { lemma: 'время', pos: 'NOUN', translation: 'time', gender: 'neut', morphFeatures: '{"gen_sg":"времени","prep_sg":"времени"}' },
  { lemma: 'год', pos: 'NOUN', translation: 'year', gender: 'masc', morphFeatures: '{"nom_pl":"годá","gen_pl":"лет"}' },
  { lemma: 'дело', pos: 'NOUN', translation: 'business; matter; deed', gender: 'neut', morphFeatures: null },
  { lemma: 'жизнь', pos: 'NOUN', translation: 'life', gender: 'fem', morphFeatures: null },
  { lemma: 'день', pos: 'NOUN', translation: 'day', gender: 'masc', morphFeatures: '{"gen_pl":"дней"}' },
  { lemma: 'рука', pos: 'NOUN', translation: 'hand; arm', gender: 'fem', morphFeatures: '{"acc_sg":"руку","gen_pl":"рук"}' },
  { lemma: 'место', pos: 'NOUN', translation: 'place; seat', gender: 'neut', morphFeatures: null },
  { lemma: 'лицо', pos: 'NOUN', translation: 'face; person (formal)', gender: 'neut', morphFeatures: null },
  { lemma: 'глаз', pos: 'NOUN', translation: 'eye', gender: 'masc', morphFeatures: '{"gen_pl":"глаз"}' },
  { lemma: 'вопрос', pos: 'NOUN', translation: 'question', gender: 'masc', morphFeatures: null },
  { lemma: 'дом', pos: 'NOUN', translation: 'house; home', gender: 'masc', morphFeatures: '{"prep_sg":"доме"}' },
  { lemma: 'сторона', pos: 'NOUN', translation: 'side; direction', gender: 'fem', morphFeatures: null },
  { lemma: 'страна', pos: 'NOUN', translation: 'country', gender: 'fem', morphFeatures: null },
  { lemma: 'слово', pos: 'NOUN', translation: 'word', gender: 'neut', morphFeatures: null },
  { lemma: 'голова', pos: 'NOUN', translation: 'head', gender: 'fem', morphFeatures: null },
  { lemma: 'ночь', pos: 'NOUN', translation: 'night', gender: 'fem', morphFeatures: null },
  { lemma: 'вода', pos: 'NOUN', translation: 'water', gender: 'fem', morphFeatures: '{"acc_sg":"воду"}' },
  { lemma: 'мать', pos: 'NOUN', translation: 'mother', gender: 'fem', morphFeatures: '{"gen_sg":"матери"}' },
  { lemma: 'отец', pos: 'NOUN', translation: 'father', gender: 'masc', morphFeatures: '{"gen_sg":"отца"}' },
  { lemma: 'друг', pos: 'NOUN', translation: 'friend (male)', gender: 'masc', morphFeatures: '{"gen_sg":"друга","nom_pl":"друзья"}' },
  { lemma: 'подруга', pos: 'NOUN', translation: 'friend (female)', gender: 'fem', morphFeatures: null },
  { lemma: 'ребёнок', pos: 'NOUN', translation: 'child', gender: 'masc', morphFeatures: '{"nom_pl":"дети"}' },
  { lemma: 'семья', pos: 'NOUN', translation: 'family', gender: 'fem', morphFeatures: null },
  { lemma: 'работа', pos: 'NOUN', translation: 'work; job', gender: 'fem', morphFeatures: null },
  { lemma: 'город', pos: 'NOUN', translation: 'city', gender: 'masc', morphFeatures: null },
  { lemma: 'мир', pos: 'NOUN', translation: 'world; peace', gender: 'masc', morphFeatures: null },
  { lemma: 'книга', pos: 'NOUN', translation: 'book', gender: 'fem', morphFeatures: null },
  { lemma: 'еда', pos: 'NOUN', translation: 'food', gender: 'fem', morphFeatures: null },
  { lemma: 'машина', pos: 'NOUN', translation: 'car; machine', gender: 'fem', morphFeatures: null },
  { lemma: 'деньги', pos: 'NOUN', translation: 'money', gender: 'fem', morphFeatures: '{"only_pl":true}' },
  { lemma: 'нога', pos: 'NOUN', translation: 'leg; foot', gender: 'fem', morphFeatures: null },
  { lemma: 'система', pos: 'NOUN', translation: 'system', gender: 'fem', morphFeatures: null },
  { lemma: 'комната', pos: 'NOUN', translation: 'room', gender: 'fem', morphFeatures: null },
  { lemma: 'девушка', pos: 'NOUN', translation: 'girl; young woman', gender: 'fem', morphFeatures: null },
  { lemma: 'парень', pos: 'NOUN', translation: 'guy; boyfriend', gender: 'masc', morphFeatures: null },
  { lemma: 'женщина', pos: 'NOUN', translation: 'woman', gender: 'fem', morphFeatures: null },
  { lemma: 'мужчина', pos: 'NOUN', translation: 'man', gender: 'masc', morphFeatures: null },
  { lemma: 'имя', pos: 'NOUN', translation: 'name', gender: 'neut', morphFeatures: '{"gen_sg":"имени"}' },
  { lemma: 'путь', pos: 'NOUN', translation: 'way; path', gender: 'masc', morphFeatures: '{"gen_sg":"пути"}' },
  { lemma: 'конец', pos: 'NOUN', translation: 'end', gender: 'masc', morphFeatures: '{"gen_sg":"конца"}' },
  { lemma: 'начало', pos: 'NOUN', translation: 'beginning; start', gender: 'neut', morphFeatures: null },
  { lemma: 'сила', pos: 'NOUN', translation: 'strength; power', gender: 'fem', morphFeatures: null },
  { lemma: 'война', pos: 'NOUN', translation: 'war', gender: 'fem', morphFeatures: null },
  { lemma: 'история', pos: 'NOUN', translation: 'history; story', gender: 'fem', morphFeatures: null },
  { lemma: 'земля', pos: 'NOUN', translation: 'earth; land; ground', gender: 'fem', morphFeatures: null },
  { lemma: 'воздух', pos: 'NOUN', translation: 'air', gender: 'masc', morphFeatures: null },
  { lemma: 'небо', pos: 'NOUN', translation: 'sky; heaven', gender: 'neut', morphFeatures: null },
  { lemma: 'солнце', pos: 'NOUN', translation: 'sun', gender: 'neut', morphFeatures: null },
  { lemma: 'лес', pos: 'NOUN', translation: 'forest', gender: 'masc', morphFeatures: null },
  { lemma: 'река', pos: 'NOUN', translation: 'river', gender: 'fem', morphFeatures: null },
  { lemma: 'дорога', pos: 'NOUN', translation: 'road; way', gender: 'fem', morphFeatures: null },
  { lemma: 'дверь', pos: 'NOUN', translation: 'door', gender: 'fem', morphFeatures: null },
  { lemma: 'окно', pos: 'NOUN', translation: 'window', gender: 'neut', morphFeatures: null },
  { lemma: 'стол', pos: 'NOUN', translation: 'table; desk', gender: 'masc', morphFeatures: null },
  { lemma: 'стул', pos: 'NOUN', translation: 'chair', gender: 'masc', morphFeatures: null },
  { lemma: 'квартира', pos: 'NOUN', translation: 'apartment', gender: 'fem', morphFeatures: null },
  { lemma: 'школа', pos: 'NOUN', translation: 'school', gender: 'fem', morphFeatures: null },
  { lemma: 'университет', pos: 'NOUN', translation: 'university', gender: 'masc', morphFeatures: null },
  { lemma: 'врач', pos: 'NOUN', translation: 'doctor', gender: 'masc', morphFeatures: null },
  { lemma: 'магазин', pos: 'NOUN', translation: 'shop; store', gender: 'masc', morphFeatures: null },
  { lemma: 'цена', pos: 'NOUN', translation: 'price', gender: 'fem', morphFeatures: null },
  { lemma: 'проблема', pos: 'NOUN', translation: 'problem', gender: 'fem', morphFeatures: null },
  { lemma: 'телефон', pos: 'NOUN', translation: 'phone', gender: 'masc', morphFeatures: null },
  { lemma: 'музыка', pos: 'NOUN', translation: 'music', gender: 'fem', morphFeatures: null },
  { lemma: 'погода', pos: 'NOUN', translation: 'weather', gender: 'fem', morphFeatures: null },
  { lemma: 'утро', pos: 'NOUN', translation: 'morning', gender: 'neut', morphFeatures: null },
  { lemma: 'вечер', pos: 'NOUN', translation: 'evening', gender: 'masc', morphFeatures: null },
  { lemma: 'неделя', pos: 'NOUN', translation: 'week', gender: 'fem', morphFeatures: null },
  { lemma: 'месяц', pos: 'NOUN', translation: 'month', gender: 'masc', morphFeatures: null },
  { lemma: 'число', pos: 'NOUN', translation: 'number; date', gender: 'neut', morphFeatures: null },
  { lemma: 'час', pos: 'NOUN', translation: 'hour', gender: 'masc', morphFeatures: null },
  { lemma: 'минута', pos: 'NOUN', translation: 'minute', gender: 'fem', morphFeatures: null },
  { lemma: 'письмо', pos: 'NOUN', translation: 'letter', gender: 'neut', morphFeatures: null },
  { lemma: 'любовь', pos: 'NOUN', translation: 'love', gender: 'fem', morphFeatures: '{"gen_sg":"любви"}' },
  { lemma: 'свобода', pos: 'NOUN', translation: 'freedom', gender: 'fem', morphFeatures: null },
  { lemma: 'правда', pos: 'NOUN', translation: 'truth', gender: 'fem', morphFeatures: null },
  { lemma: 'мысль', pos: 'NOUN', translation: 'thought', gender: 'fem', morphFeatures: null },
  { lemma: 'разговор', pos: 'NOUN', translation: 'conversation', gender: 'masc', morphFeatures: null },
  { lemma: 'язык', pos: 'NOUN', translation: 'language; tongue', gender: 'masc', morphFeatures: null },
  { lemma: 'класс', pos: 'NOUN', translation: 'class; classroom', gender: 'masc', morphFeatures: null },
  { lemma: 'товарищ', pos: 'NOUN', translation: 'comrade; friend', gender: 'masc', morphFeatures: null },
  { lemma: 'группа', pos: 'NOUN', translation: 'group', gender: 'fem', morphFeatures: null },
  { lemma: 'вещь', pos: 'NOUN', translation: 'thing; object', gender: 'fem', morphFeatures: null },
  { lemma: 'чай', pos: 'NOUN', translation: 'tea', gender: 'masc', morphFeatures: null },
  { lemma: 'кофе', pos: 'NOUN', translation: 'coffee', gender: 'masc', morphFeatures: '{"indeclinable":true}' },
  { lemma: 'хлеб', pos: 'NOUN', translation: 'bread', gender: 'masc', morphFeatures: null },
  { lemma: 'молоко', pos: 'NOUN', translation: 'milk', gender: 'neut', morphFeatures: null },
  { lemma: 'мясо', pos: 'NOUN', translation: 'meat', gender: 'neut', morphFeatures: null },
  { lemma: 'рыба', pos: 'NOUN', translation: 'fish', gender: 'fem', morphFeatures: null },
  { lemma: 'овощи', pos: 'NOUN', translation: 'vegetables', gender: 'fem', morphFeatures: '{"only_pl":true}' },
  { lemma: 'фрукт', pos: 'NOUN', translation: 'fruit', gender: 'masc', morphFeatures: null },
  { lemma: 'сахар', pos: 'NOUN', translation: 'sugar', gender: 'masc', morphFeatures: null },
  { lemma: 'соль', pos: 'NOUN', translation: 'salt', gender: 'fem', morphFeatures: null },
  { lemma: 'кот', pos: 'NOUN', translation: 'cat (male)', gender: 'masc', morphFeatures: null },
  { lemma: 'кошка', pos: 'NOUN', translation: 'cat', gender: 'fem', morphFeatures: null },
  { lemma: 'собака', pos: 'NOUN', translation: 'dog', gender: 'fem', morphFeatures: null },
  { lemma: 'птица', pos: 'NOUN', translation: 'bird', gender: 'fem', morphFeatures: null },
  { lemma: 'дерево', pos: 'NOUN', translation: 'tree', gender: 'neut', morphFeatures: null },
  { lemma: 'цветок', pos: 'NOUN', translation: 'flower', gender: 'masc', morphFeatures: null },

  // === ADJECTIVES — core (top 50) ===
  { lemma: 'большой', pos: 'ADJ', translation: 'big; large', gender: 'masc', morphFeatures: '{"short":"велик,велика"}' },
  { lemma: 'маленький', pos: 'ADJ', translation: 'small; little', gender: 'masc', morphFeatures: null },
  { lemma: 'новый', pos: 'ADJ', translation: 'new', gender: 'masc', morphFeatures: null },
  { lemma: 'старый', pos: 'ADJ', translation: 'old', gender: 'masc', morphFeatures: null },
  { lemma: 'хороший', pos: 'ADJ', translation: 'good', gender: 'masc', morphFeatures: '{"short":"хорош,хороша"}' },
  { lemma: 'плохой', pos: 'ADJ', translation: 'bad', gender: 'masc', morphFeatures: null },
  { lemma: 'русский', pos: 'ADJ', translation: 'Russian', gender: 'masc', morphFeatures: null },
  { lemma: 'другой', pos: 'ADJ', translation: 'other; another', gender: 'masc', morphFeatures: null },
  { lemma: 'первый', pos: 'ADJ', translation: 'first', gender: 'masc', morphFeatures: null },
  { lemma: 'последний', pos: 'ADJ', translation: 'last', gender: 'masc', morphFeatures: null },
  { lemma: 'молодой', pos: 'ADJ', translation: 'young', gender: 'masc', morphFeatures: null },
  { lemma: 'главный', pos: 'ADJ', translation: 'main; chief', gender: 'masc', morphFeatures: null },
  { lemma: 'целый', pos: 'ADJ', translation: 'whole; entire', gender: 'masc', morphFeatures: null },
  { lemma: 'простой', pos: 'ADJ', translation: 'simple', gender: 'masc', morphFeatures: null },
  { lemma: 'чёрный', pos: 'ADJ', translation: 'black', gender: 'masc', morphFeatures: null },
  { lemma: 'белый', pos: 'ADJ', translation: 'white', gender: 'masc', morphFeatures: null },
  { lemma: 'красный', pos: 'ADJ', translation: 'red', gender: 'masc', morphFeatures: null },
  { lemma: 'зелёный', pos: 'ADJ', translation: 'green', gender: 'masc', morphFeatures: null },
  { lemma: 'синий', pos: 'ADJ', translation: 'blue (dark)', gender: 'masc', morphFeatures: null },
  { lemma: 'жёлтый', pos: 'ADJ', translation: 'yellow', gender: 'masc', morphFeatures: null },
  { lemma: 'тёплый', pos: 'ADJ', translation: 'warm', gender: 'masc', morphFeatures: null },
  { lemma: 'холодный', pos: 'ADJ', translation: 'cold', gender: 'masc', morphFeatures: null },
  { lemma: 'быстрый', pos: 'ADJ', translation: 'fast', gender: 'masc', morphFeatures: null },
  { lemma: 'медленный', pos: 'ADJ', translation: 'slow', gender: 'masc', morphFeatures: null },
  { lemma: 'высокий', pos: 'ADJ', translation: 'tall; high', gender: 'masc', morphFeatures: null },
  { lemma: 'низкий', pos: 'ADJ', translation: 'low; short', gender: 'masc', morphFeatures: null },
  { lemma: 'длинный', pos: 'ADJ', translation: 'long', gender: 'masc', morphFeatures: null },
  { lemma: 'короткий', pos: 'ADJ', translation: 'short', gender: 'masc', morphFeatures: null },
  { lemma: 'трудный', pos: 'ADJ', translation: 'difficult; hard', gender: 'masc', morphFeatures: null },
  { lemma: 'лёгкий', pos: 'ADJ', translation: 'easy; light', gender: 'masc', morphFeatures: null },
  { lemma: 'важный', pos: 'ADJ', translation: 'important', gender: 'masc', morphFeatures: null },
  { lemma: 'нужный', pos: 'ADJ', translation: 'necessary; needed', gender: 'masc', morphFeatures: null },
  { lemma: 'интересный', pos: 'ADJ', translation: 'interesting', gender: 'masc', morphFeatures: null },
  { lemma: 'красивый', pos: 'ADJ', translation: 'beautiful', gender: 'masc', morphFeatures: null },
  { lemma: 'сильный', pos: 'ADJ', translation: 'strong', gender: 'masc', morphFeatures: null },
  { lemma: 'слабый', pos: 'ADJ', translation: 'weak', gender: 'masc', morphFeatures: null },
  { lemma: 'богатый', pos: 'ADJ', translation: 'rich', gender: 'masc', morphFeatures: null },
  { lemma: 'бедный', pos: 'ADJ', translation: 'poor', gender: 'masc', morphFeatures: null },
  { lemma: 'счастливый', pos: 'ADJ', translation: 'happy; lucky', gender: 'masc', morphFeatures: null },
  { lemma: 'грустный', pos: 'ADJ', translation: 'sad', gender: 'masc', morphFeatures: null },
  { lemma: 'умный', pos: 'ADJ', translation: 'smart; clever', gender: 'masc', morphFeatures: null },
  { lemma: 'добрый', pos: 'ADJ', translation: 'kind; good', gender: 'masc', morphFeatures: null },
  { lemma: 'злой', pos: 'ADJ', translation: 'angry; evil', gender: 'masc', morphFeatures: null },
  { lemma: 'свободный', pos: 'ADJ', translation: 'free', gender: 'masc', morphFeatures: null },
  { lemma: 'готовый', pos: 'ADJ', translation: 'ready', gender: 'masc', morphFeatures: null },
  { lemma: 'правый', pos: 'ADJ', translation: 'right (correct)', gender: 'masc', morphFeatures: null },
  { lemma: 'левый', pos: 'ADJ', translation: 'left', gender: 'masc', morphFeatures: null },
  { lemma: 'средний', pos: 'ADJ', translation: 'middle; average', gender: 'masc', morphFeatures: null },
  { lemma: 'следующий', pos: 'ADJ', translation: 'next; following', gender: 'masc', morphFeatures: null },

  // === ADVERBS — core ===
  { lemma: 'очень', pos: 'ADV', translation: 'very', gender: null, morphFeatures: null },
  { lemma: 'тоже', pos: 'ADV', translation: 'also; too', gender: null, morphFeatures: null },
  { lemma: 'ещё', pos: 'ADV', translation: 'still; yet; more', gender: null, morphFeatures: null },
  { lemma: 'уже', pos: 'ADV', translation: 'already', gender: null, morphFeatures: null },
  { lemma: 'теперь', pos: 'ADV', translation: 'now', gender: null, morphFeatures: null },
  { lemma: 'сейчас', pos: 'ADV', translation: 'now; immediately', gender: null, morphFeatures: null },
  { lemma: 'потом', pos: 'ADV', translation: 'then; later', gender: null, morphFeatures: null },
  { lemma: 'вчера', pos: 'ADV', translation: 'yesterday', gender: null, morphFeatures: null },
  { lemma: 'завтра', pos: 'ADV', translation: 'tomorrow', gender: null, morphFeatures: null },
  { lemma: 'сегодня', pos: 'ADV', translation: 'today', gender: null, morphFeatures: null },
  { lemma: 'всегда', pos: 'ADV', translation: 'always', gender: null, morphFeatures: null },
  { lemma: 'никогда', pos: 'ADV', translation: 'never', gender: null, morphFeatures: null },
  { lemma: 'иногда', pos: 'ADV', translation: 'sometimes', gender: null, morphFeatures: null },
  { lemma: 'часто', pos: 'ADV', translation: 'often', gender: null, morphFeatures: null },
  { lemma: 'много', pos: 'ADV', translation: 'a lot; many', gender: null, morphFeatures: null },
  { lemma: 'мало', pos: 'ADV', translation: 'little; few', gender: null, morphFeatures: null },
  { lemma: 'быстро', pos: 'ADV', translation: 'quickly', gender: null, morphFeatures: null },
  { lemma: 'медленно', pos: 'ADV', translation: 'slowly', gender: null, morphFeatures: null },
  { lemma: 'хорошо', pos: 'ADV', translation: 'well; good', gender: null, morphFeatures: null },
  { lemma: 'плохо', pos: 'ADV', translation: 'badly; bad', gender: null, morphFeatures: null },
  { lemma: 'здесь', pos: 'ADV', translation: 'here', gender: null, morphFeatures: null },
  { lemma: 'там', pos: 'ADV', translation: 'there', gender: null, morphFeatures: null },
  { lemma: 'тут', pos: 'ADV', translation: 'here', gender: null, morphFeatures: null },
  { lemma: 'далеко', pos: 'ADV', translation: 'far', gender: null, morphFeatures: null },
  { lemma: 'близко', pos: 'ADV', translation: 'close; near', gender: null, morphFeatures: null },
  { lemma: 'вместе', pos: 'ADV', translation: 'together', gender: null, morphFeatures: null },
  { lemma: 'конечно', pos: 'ADV', translation: 'of course', gender: null, morphFeatures: null },
  { lemma: 'наверное', pos: 'ADV', translation: 'probably', gender: null, morphFeatures: null },
  { lemma: 'обязательно', pos: 'ADV', translation: 'necessarily; definitely', gender: null, morphFeatures: null },
  { lemma: 'просто', pos: 'ADV', translation: 'simply; just', gender: null, morphFeatures: null },

  // === PREPOSITIONS ===
  { lemma: 'в', pos: 'PREP', translation: 'in; into', gender: null, morphFeatures: null },
  { lemma: 'на', pos: 'PREP', translation: 'on; onto', gender: null, morphFeatures: null },
  { lemma: 'с', pos: 'PREP', translation: 'with; from', gender: null, morphFeatures: null },
  { lemma: 'к', pos: 'PREP', translation: 'to; toward', gender: null, morphFeatures: null },
  { lemma: 'у', pos: 'PREP', translation: 'by; at; from', gender: null, morphFeatures: null },
  { lemma: 'о', pos: 'PREP', translation: 'about', gender: null, morphFeatures: null },
  { lemma: 'за', pos: 'PREP', translation: 'behind; for', gender: null, morphFeatures: null },
  { lemma: 'из', pos: 'PREP', translation: 'from; out of', gender: null, morphFeatures: null },
  { lemma: 'по', pos: 'PREP', translation: 'along; according to', gender: null, morphFeatures: null },
  { lemma: 'от', pos: 'PREP', translation: 'from; away from', gender: null, morphFeatures: null },
  { lemma: 'без', pos: 'PREP', translation: 'without', gender: null, morphFeatures: null },
  { lemma: 'для', pos: 'PREP', translation: 'for', gender: null, morphFeatures: null },
  { lemma: 'до', pos: 'PREP', translation: 'until; before', gender: null, morphFeatures: null },
  { lemma: 'про', pos: 'PREP', translation: 'about', gender: null, morphFeatures: null },
  { lemma: 'через', pos: 'PREP', translation: 'through; across', gender: null, morphFeatures: null },

  // === CONJUNCTIONS & PARTICLES ===
  { lemma: 'и', pos: 'CONJ', translation: 'and', gender: null, morphFeatures: null },
  { lemma: 'а', pos: 'CONJ', translation: 'but; and', gender: null, morphFeatures: null },
  { lemma: 'но', pos: 'CONJ', translation: 'but', gender: null, morphFeatures: null },
  { lemma: 'или', pos: 'CONJ', translation: 'or', gender: null, morphFeatures: null },
  { lemma: 'если', pos: 'CONJ', translation: 'if', gender: null, morphFeatures: null },
  { lemma: 'когда', pos: 'CONJ', translation: 'when', gender: null, morphFeatures: null },
  { lemma: 'потому что', pos: 'CONJ', translation: 'because', gender: null, morphFeatures: null },
  { lemma: 'чтобы', pos: 'CONJ', translation: 'in order to; so that', gender: null, morphFeatures: null },
  { lemma: 'как', pos: 'CONJ', translation: 'how; as; like', gender: null, morphFeatures: null },
  { lemma: 'не', pos: 'PART', translation: 'not', gender: null, morphFeatures: null },
  { lemma: 'да', pos: 'PART', translation: 'yes', gender: null, morphFeatures: null },
  { lemma: 'нет', pos: 'PART', translation: 'no', gender: null, morphFeatures: null },
  { lemma: 'тоже', pos: 'PART', translation: 'also; too', gender: null, morphFeatures: null },
  { lemma: 'ли', pos: 'PART', translation: 'question particle', gender: null, morphFeatures: null },
  { lemma: 'бы', pos: 'PART', translation: 'conditional/subjunctive particle', gender: null, morphFeatures: null },

  // === NUMERALS ===
  { lemma: 'один', pos: 'NUM', translation: 'one', gender: null, morphFeatures: null },
  { lemma: 'два', pos: 'NUM', translation: 'two', gender: null, morphFeatures: null },
  { lemma: 'три', pos: 'NUM', translation: 'three', gender: null, morphFeatures: null },
  { lemma: 'четыре', pos: 'NUM', translation: 'four', gender: null, morphFeatures: null },
  { lemma: 'пять', pos: 'NUM', translation: 'five', gender: null, morphFeatures: null },

  // === COMMON INTERJECTIONS / GREETINGS ===
  { lemma: 'привет', pos: 'INTJ', translation: 'hello; hi', gender: null, morphFeatures: null },
  { lemma: 'пока', pos: 'INTJ', translation: 'bye; see you', gender: null, morphFeatures: null },
  { lemma: 'спасибо', pos: 'INTJ', translation: 'thank you', gender: null, morphFeatures: null },
  { lemma: 'пожалуйста', pos: 'INTJ', translation: 'please; you are welcome', gender: null, morphFeatures: null },
  { lemma: 'извините', pos: 'INTJ', translation: 'excuse me; sorry', gender: null, morphFeatures: null },
  { lemma: 'здравствуйте', pos: 'INTJ', translation: 'hello (formal)', gender: null, morphFeatures: null },
];

async function main() {
  console.log(`[Seed-RU] Seeding ${RUSSIAN_VOCAB.length} Russian lexemes...`);

  let created = 0;
  let skipped = 0;

  for (let i = 0; i < RUSSIAN_VOCAB.length; i++) {
    const item = RUSSIAN_VOCAB[i];
    const id = `ru:${item.lemma.toLowerCase()}:${item.pos}`;
    const frequencyRank = i + 1; // 1 = most frequent
    try {
      await db.insert(schema.lexemes).values({
        id,
        lemma: item.lemma,
        pos: item.pos,
        language: 'ru',
        translation: item.translation,
        gender: item.gender,
        morphFeatures: item.morphFeatures,
        unitId: null,
        frequencyRank,
      }).onConflictDoUpdate({
        target: schema.lexemes.id,
        set: {
          translation: item.translation,
          gender: item.gender,
          morphFeatures: item.morphFeatures,
          frequencyRank,
        },
      });
      created++;
    } catch {
      skipped++;
    }
  }

  const total = await db.select({ id: schema.lexemes.id }).from(schema.lexemes);
  console.log(`[Seed-RU] Done! ${created} created, ${skipped} skipped. Total lexemes in DB: ${total.length}`);
  console.log(`[Seed-RU] Next: run embed-lexemes.ts to add BGE-M3 vectors`);
}

main().catch(err => {
  console.error('[Seed-RU] Error:', err);
  process.exit(1);
});