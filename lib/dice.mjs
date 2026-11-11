import { randomInt } from 'node:crypto';

export function parseDice(expression) {
  if (typeof expression !== 'string' || expression.length > 40) {
    throw new Error('Enter dice such as 1d20, 3d20 or 2d6+4.');
  }
  const match = expression.replace(/\s/g, '').toLowerCase().match(/^(\d{1,2})?d(\d{1,4})([+-]\d{1,5})?$/);
  if (!match) throw new Error('Enter dice such as 1d20, 3d20 or 2d6+4.');
  const count = Number(match[1] ?? 1);
  const sides = Number(match[2]);
  const modifier = Number(match[3] ?? 0);
  if (count < 1 || count > 20 || sides < 2 || sides > 1000 || Math.abs(modifier) > 10000) {
    throw new Error('Use 1–20 dice, 2–1000 sides, and a modifier between −10000 and +10000.');
  }
  return { count, sides, modifier, expression: `${count}d${sides}${modifier ? `${modifier > 0 ? '+' : ''}${modifier}` : ''}` };
}

export function rollDice(expression) {
  const dice = parseDice(expression);
  const results = Array.from({ length: dice.count }, () => randomInt(1, dice.sides + 1));
  return { expression: dice.expression, results, modifier: dice.modifier, total: results.reduce((a, b) => a + b, dice.modifier) };
}
