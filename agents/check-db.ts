import { db } from './src/db/index.js';
import { users, lexemes, learningProgress, units, activeGoals } from './src/db/schema.js';
import { eq } from 'drizzle-orm';

console.log('=== Database Status ===\n');

// Count records
const userCount = await db.select().from(users).all();
const lexemeCount = await db.select().from(lexemes).all();
const progressCount = await db.select().from(learningProgress).all();
const unitCount = await db.select().from(units).all();
const goalCount = await db.select().from(activeGoals).all();

console.log(`Users: ${userCount.length}`);
console.log(`Units: ${unitCount.length}`);
console.log(`Lexemes: ${lexemeCount.length}`);
console.log(`Progress Records: ${progressCount.length}`);
console.log(`Active Goals: ${goalCount.length}\n`);

// Sample data
if (userCount.length > 0) {
  console.log('=== Sample User ===');
  const user = userCount[0];
  console.log(`ID: ${user.id}`);
  console.log(`Target Language: ${user.targetLanguage}`);
  console.log(`Native Language: ${user.nativeLanguage}`);
  console.log(`Proficiency: ${user.proficiencyLevel}\n`);
}

if (lexemeCount.length > 0) {
  console.log('=== Sample Lexemes (first 5) ===');
  lexemeCount.slice(0, 5).forEach(lex => {
    console.log(`${lex.lemma} (${lex.pos}) - ${lex.translation} [${lex.language}]`);
  });
  console.log('');
}

if (progressCount.length > 0) {
  console.log('=== Sample Progress (first 5) ===');
  progressCount.slice(0, 5).forEach(prog => {
    console.log(`User: ${prog.userId}, Lexeme: ${prog.lexemeId}, SRS Level: ${prog.srsLevel}, Encounters: ${prog.encounters}`);
  });
  console.log('');
}

if (unitCount.length > 0) {
  console.log('=== Units ===');
  unitCount.forEach(unit => {
    console.log(`${unit.title} (${unit.language}) - Order: ${unit.order}`);
  });
  console.log('');
}

if (goalCount.length > 0) {
  console.log('=== Active Goals ===');
  goalCount.forEach(goal => {
    console.log(`User: ${goal.userId}, Type: ${goal.type}, Target: ${goal.targetId}, Status: ${goal.status}`);
  });
}

process.exit(0);
