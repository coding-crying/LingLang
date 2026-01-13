/**
 * Simple Curriculum-Based Learning Goals
 *
 * Instead of SRS vocabulary drilling, this provides structured lessons
 * that progress through topics in a natural order.
 */

export interface CurriculumGoal {
  id: string;
  topic: string;
  objective: string;  // What the user should accomplish
  targetVocab: string[];  // Key words/phrases for this goal
  successCriteria: string;  // How to know if they achieved it
}

export interface LanguageCurriculum {
  language: string;
  goals: CurriculumGoal[];
}

export const PORTUGUESE_CURRICULUM: LanguageCurriculum = {
  language: 'pt',
  goals: [
    {
      id: 'pt-001-greetings',
      topic: 'Basic Greetings',
      objective: 'Use 3 different Portuguese greetings in conversation',
      targetVocab: ['olá', 'oi', 'bom dia', 'boa tarde', 'boa noite', 'tchau', 'até logo'],
      successCriteria: 'User successfully used at least 3 greetings (olá/oi/bom dia/etc.)'
    },
    {
      id: 'pt-002-introductions',
      topic: 'Self Introduction',
      objective: 'Introduce yourself with name and basic info',
      targetVocab: ['meu nome é', 'me chamo', 'sou', 'tenho', 'anos'],
      successCriteria: 'User said their name and one personal detail in Portuguese'
    },
    {
      id: 'pt-003-numbers',
      topic: 'Numbers 1-10',
      objective: 'Count or use numbers 1-10 in conversation',
      targetVocab: ['um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez'],
      successCriteria: 'User used at least 3 numbers naturally (age, quantity, etc.)'
    },
    {
      id: 'pt-004-family',
      topic: 'Family Members',
      objective: 'Talk about your family using 3 family words',
      targetVocab: ['mãe', 'pai', 'irmão', 'irmã', 'avó', 'avô', 'filho', 'filha', 'família'],
      successCriteria: 'User mentioned at least 3 family members in Portuguese'
    },
    {
      id: 'pt-005-colors',
      topic: 'Basic Colors',
      objective: 'Describe things using 3 different colors',
      targetVocab: ['vermelho', 'azul', 'verde', 'amarelo', 'preto', 'branco', 'cor'],
      successCriteria: 'User described objects using at least 3 colors'
    },
    {
      id: 'pt-006-food',
      topic: 'Common Foods',
      objective: 'Talk about food preferences using 4 food words',
      targetVocab: ['gosto', 'comida', 'água', 'café', 'pão', 'carne', 'fruta', 'arroz', 'feijão'],
      successCriteria: 'User talked about food using at least 4 food-related words'
    },
    {
      id: 'pt-007-days',
      topic: 'Days of the Week',
      objective: 'Use 3 different day names in conversation',
      targetVocab: ['segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado', 'domingo', 'hoje', 'amanhã'],
      successCriteria: 'User mentioned at least 3 different days'
    },
    {
      id: 'pt-008-activities',
      topic: 'Daily Activities',
      objective: 'Describe 3 activities you do',
      targetVocab: ['trabalho', 'estudo', 'como', 'durmo', 'vou', 'faço', 'gosto de'],
      successCriteria: 'User described at least 3 daily activities in Portuguese'
    },
    {
      id: 'pt-009-locations',
      topic: 'Places & Locations',
      objective: 'Talk about where you go using 3 location words',
      targetVocab: ['casa', 'trabalho', 'escola', 'restaurante', 'mercado', 'cidade', 'rua'],
      successCriteria: 'User mentioned at least 3 different places'
    },
    {
      id: 'pt-010-weather',
      topic: 'Weather & Seasons',
      objective: 'Discuss weather or seasons',
      targetVocab: ['tempo', 'quente', 'frio', 'chuva', 'sol', 'verão', 'inverno'],
      successCriteria: 'User talked about weather using appropriate vocabulary'
    }
  ]
};

export const RUSSIAN_CURRICULUM: LanguageCurriculum = {
  language: 'ru',
  goals: [
    {
      id: 'ru-001-greetings',
      topic: 'Basic Greetings',
      objective: 'Use 3 different Russian greetings in conversation',
      targetVocab: ['привет', 'здравствуйте', 'доброе утро', 'добрый день', 'добрый вечер', 'пока', 'до свидания'],
      successCriteria: 'User successfully used at least 3 greetings'
    },
    {
      id: 'ru-002-introductions',
      topic: 'Self Introduction',
      objective: 'Introduce yourself with name',
      targetVocab: ['меня зовут', 'я', 'мне', 'лет', 'года'],
      successCriteria: 'User said their name in Russian'
    },
    {
      id: 'ru-003-numbers',
      topic: 'Numbers 1-10',
      objective: 'Count or use numbers 1-10 in conversation',
      targetVocab: ['один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять', 'десять'],
      successCriteria: 'User used at least 3 numbers naturally'
    },
    {
      id: 'ru-004-family',
      topic: 'Family Members',
      objective: 'Talk about your family using 3 family words',
      targetVocab: ['мама', 'папа', 'брат', 'сестра', 'бабушка', 'дедушка', 'семья'],
      successCriteria: 'User mentioned at least 3 family members'
    },
    {
      id: 'ru-005-months',
      topic: 'Months of the Year',
      objective: 'Use 3 different month names in conversation',
      targetVocab: ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'],
      successCriteria: 'User mentioned at least 3 different months'
    }
  ]
};

export function getCurriculum(languageCode: string): LanguageCurriculum | null {
  switch (languageCode) {
    case 'pt':
      return PORTUGUESE_CURRICULUM;
    case 'ru':
      return RUSSIAN_CURRICULUM;
    default:
      return null;
  }
}
