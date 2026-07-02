# Curriculum Mode

Simple structured learning path instead of SRS vocabulary drilling.

## What is Curriculum Mode?

Instead of practicing random vocabulary from your SRS queue, Curriculum Mode provides a structured sequence of conversation goals that progress naturally:

1. **Basic Greetings** → Use 3 different greetings
2. **Self Introduction** → Introduce yourself
3. **Numbers 1-10** → Count or use numbers
4. **Family Members** → Talk about family
5. **Colors** → Describe things with colors
6. **Food** → Talk about food preferences
7. **Days of the Week** → Use day names
8. **Daily Activities** → Describe what you do
9. **Locations** → Talk about places
10. **Weather & Seasons** → Discuss weather

## How It Works

- The tutor guides you naturally toward using target vocabulary
- When you've used enough words from a goal, it completes automatically
- You progress to the next goal in sequence
- No explicit drilling or testing - just natural conversation

## Supported Languages

- **Portuguese** (pt) - 10 goals
- **Russian** (ru) - 5 goals (starter set)

## How to Enable

Set environment variable:
```bash
export USE_CURRICULUM=true
```

Or add to `.env.local`:
```
USE_CURRICULUM=true
```

Then start the agent normally:
```bash
./start_agent.sh
```

## How to Disable

Remove the environment variable or set it to `false`:
```bash
export USE_CURRICULUM=false
# or just unset it
unset USE_CURRICULUM
```

## Adding More Goals

Edit `agents/src/config/curriculum.ts` to add new goals:

```typescript
{
  id: 'pt-011-weather',
  topic: 'Weather & Seasons',
  objective: 'Discuss weather or seasons',
  targetVocab: ['tempo', 'quente', 'frio', 'chuva', 'sol'],
  successCriteria: 'User talked about weather using appropriate vocabulary'
}
```

## Progress Tracking

Progress is stored in user metadata:
- `completedGoals`: Array of completed goal IDs
- Reset by clearing user metadata in database

## Differences from SRS Mode

| Feature | SRS Mode | Curriculum Mode |
|---------|----------|----------------|
| Goal Selection | Based on word strength | Sequential curriculum |
| Progress Tracking | Leitner boxes | Completed goals list |
| Focus | Vocabulary drilling | Topic-based conversation |
| Flexibility | Dynamic based on mistakes | Fixed sequence |
| Best For | Maintenance & review | Beginners & structure |

## Future Enhancements

- [ ] Branching paths (choose your own adventure)
- [ ] Difficulty levels (beginner/intermediate/advanced tracks)
- [ ] User-customizable curricula
- [ ] Grammar-focused goals alongside vocabulary
- [ ] Cultural context integrated into goals
