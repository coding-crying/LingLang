import { db } from './src/db/index.js';
import { sql, eq, and } from 'drizzle-orm';
import { userLanguageLevels, users } from './src/db/schema.js';

async function main() {
  // Show will's row(s)
  const will = await db.select().from(users).where(eq(users.id, 'will'));
  console.log('will user:', will[0]);
  const willLevels = await db.select().from(userLanguageLevels).where(eq(userLanguageLevels.userId, 'will'));
  console.log('will levels:', willLevels);

  // Update will's PT to pre_a1 and RU to A2
  if (will[0]) {
    if (will[0].targetLanguage === 'pt') {
      await db
        .update(userLanguageLevels)
        .set({ proficiencyLevel: 'pre_a1', confidence: 1.0, source: 'manual' })
        .where(and(eq(userLanguageLevels.userId, 'will'), eq(userLanguageLevels.languageCode, 'pt')));
      console.log('Set will/pt = pre_a1');
    }
    if (will[0].nativeLanguage === 'ru' || (will[0] as any).learningLanguage === 'ru') {
      // Check if there's a ru row
      const ruRow = willLevels.find((l) => l.languageCode === 'ru');
      if (ruRow) {
        await db
          .update(userLanguageLevels)
          .set({ proficiencyLevel: 'a2', confidence: 1.0, source: 'manual' })
          .where(and(eq(userLanguageLevels.userId, 'will'), eq(userLanguageLevels.languageCode, 'ru')));
        console.log('Set will/ru = a2');
      } else {
        // Need to insert
        await db
          .insert(userLanguageLevels)
          .values({ userId: 'will', languageCode: 'ru', proficiencyLevel: 'a2', confidence: 1.0, source: 'manual' });
        console.log('Inserted will/ru = a2');
      }
    }
  }

  // Show all will rows after update
  const after = await db.select().from(userLanguageLevels).where(eq(userLanguageLevels.userId, 'will'));
  console.log('will levels AFTER:', after);
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
